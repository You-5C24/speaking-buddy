/**
 * 复盘：从攒下来的 turns 里挑 3 句，拼成一张卡片。
 * 不重新调 LLM —— 复盘是攒数据，不是重新推导。
 * 「更自然」只取 rewrite。块统计含热身轮。
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assignNotReached, computeBlockUsage, type BlockUsage } from './blocks.js';
import { longPauseGaps, metrics, type Session, type Turn } from './pipeline.js';

const MAX_SENTENCES = 3;

function maxSeverity(turn: Turn): number {
  return turn.reply.flags.reduce((m, f) => Math.max(m, f.severity), 0);
}

/** 优先 severity 高的，不够再按轮次补最早的 */
export function pickSentences(session: Session, n = MAX_SENTENCES): Turn[] {
  const withFlags = [...session.turns]
    .filter((t) => t.reply.flags.length > 0)
    .sort((a, b) => maxSeverity(b) - maxSeverity(a));

  const picked = withFlags.slice(0, n);
  const pickedIds = new Set(picked.map((t) => t.index));

  if (picked.length < n) {
    const rest = session.turns
      .filter((t) => !pickedIds.has(t.index) && t.userText.length > 0)
      .slice(0, n - picked.length);
    picked.push(...rest);
  }

  return picked.sort((a, b) => a.index - b.index);
}

export type AggregateMetrics = {
  wpm: number | null;
  longPausePerMin: number | null;
  fillerPer100w: number | null;
};

/**
 * 累加每轮 `metrics()` 的计数，不另抄一套公式。
 * 间隙检测结构上打不出停顿（whisper 把静音吞进词长），0 记成 null，卡片显示 —。
 */
export function aggregateMetrics(session: Session): AggregateMetrics {
  const parts = session.turns.flatMap((t) => {
    const m = metrics(t.words);
    return m ? [m] : [];
  });

  const speechMs = parts.reduce((s, x) => s + x.speechMs, 0);
  const words = parts.reduce((s, x) => s + x.words, 0);
  const longPauses = parts.reduce((s, x) => s + x.longPauses, 0);
  const fillers = parts.reduce((s, x) => s + x.fillers, 0);

  if (speechMs <= 0 || words === 0) {
    return { wpm: null, longPausePerMin: null, fillerPer100w: null };
  }

  const minutes = speechMs / 60000;
  return {
    wpm: Math.round(words / minutes),
    longPausePerMin: longPauses === 0 ? null : Number((longPauses / minutes).toFixed(1)),
    // 一个填充词都没检测到 ≠ 用户没说。whisper 倾向丢掉 um / uh，写 null 显示 —（§7）
    fillerPer100w: fillers === 0 ? null : Number(((fillers / words) * 100).toFixed(1)),
  };
}

export function blockUsageFor(session: Session): Record<string, BlockUsage> | null {
  if (!session.scenario) return null;
  const texts = [
    ...(session.warmup ? [session.warmup.userText] : []),
    ...session.turns.map((t) => t.userText),
  ];
  const raw = computeBlockUsage(session.scenario.blocks, texts);
  return assignNotReached(raw, session.scenario.beats, session.turns.length);
}

const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九'];

function blockUsageLine(blocks: { n: number }[], usage: Record<string, BlockUsage>): string {
  const sorted = [...blocks].sort((a, b) => a.n - b.n);
  const used = sorted.filter((b) => usage[String(b.n)] === 'used').length;
  const marks = sorted
    .map((b) => {
      const state = usage[String(b.n)] ?? 'unused';
      const mark = state === 'used' ? '✓' : state === 'not_reached' ? '—' : '✗';
      return `${b.n} ${mark}`;
    })
    .join('  ');
  const n = CN[used] ?? String(used);
  return `三句用了${n}句：${marks}`;
}

export type Postmortem = {
  sessionId: string;
  scenarioId: string;
  endReason: string;
  turnCount: number;
  metrics: AggregateMetrics;
  blockUsage: Record<string, BlockUsage> | null;
  rewriteCount: number;
  topIssue: { said: string; better: string; why?: string; turn: number } | null;
  sentences: {
    turn: number;
    said: string;
    expression: string;
    natural: string | null;
    audioUser: string;
  }[];
  stalls: { turn: number; signal: string; pauseMs: number }[];
};

export function buildPostmortem(session: Session, endReason = 'user_end'): Postmortem {
  if (!session.scenario) throw new Error('还没选场景，没有复盘');
  const picked = pickSentences(session);

  const allFlags = session.turns.flatMap((t) =>
    t.reply.flags.map((f) => ({ ...f, turn: t.index }))
  );
  const top = allFlags.filter((f) => f.severity >= 2).sort((a, b) => b.severity - a.severity)[0];

  const stalls = session.turns.flatMap((t) =>
    longPauseGaps(t.words).map(({ gapMs }) => ({
      turn: t.index,
      signal: 'long_pause',
      pauseMs: Math.round(gapMs),
    }))
  );

  const blockUsage = blockUsageFor(session);
  session.blockUsage = blockUsage;
  const rewriteCount = session.turns.filter((t) => t.reply.rewrite?.trim()).length;

  return {
    sessionId: session.id,
    scenarioId: session.scenario.id,
    endReason,
    turnCount: session.turns.length,
    metrics: aggregateMetrics(session),
    blockUsage,
    rewriteCount,
    topIssue: top
      ? {
          said: top.said,
          better: top.better,
          ...(top.why ? { why: top.why } : {}),
          turn: top.turn,
        }
      : null,
    sentences: picked.map((t) => {
      const f = t.reply.flags[0];
      const audio =
        t.index === 0
          ? 'turns/000-warmup/user.opus'
          : `turns/${String(t.index).padStart(3, '0')}/user.opus`;
      return {
        turn: t.index,
        said: t.userText,
        expression: f
          ? `${f.said} → ${f.better}${f.why ? `（${f.why}）` : ''}`
          : '这一句没有影响理解的问题',
        natural: t.reply.rewrite?.trim() || null,
        audioUser: audio,
      };
    }),
    stalls,
  };
}

function wpmLabel(wpm: number | null): string {
  return wpm == null ? '—' : `${wpm} wpm`;
}

/** 生成发到飞书的卡片文本。一屏能看完是硬要求。 */
export function buildReview(session: Session, endReason = 'user_end'): string {
  const pm = buildPostmortem(session, endReason);
  const scenario = session.scenario;
  if (!scenario) throw new Error('还没选场景，没有复盘');

  const title = session.listTitle || scenario.title;
  const speed = wpmLabel(pm.metrics.wpm);
  const lines: string[] = [];
  lines.push(`🎯 ${title} · ${pm.turnCount} 轮 · 语速 ${speed}`);

  if (scenario.cardStyle === 'rewrite') {
    lines.push(`说得更自然 ${pm.rewriteCount} 处 · ${pm.turnCount} 轮 · 语速 ${speed}`);
  } else if (pm.blockUsage) {
    lines.push(blockUsageLine(scenario.blocks, pm.blockUsage));
  }
  lines.push('');

  if (pm.topIssue) {
    lines.push('最该改的一点');
    lines.push(`  你说：${pm.topIssue.said}`);
    lines.push(`  改：  ${pm.topIssue.better}`);
    if (pm.topIssue.why) lines.push(`  为什么：${pm.topIssue.why}`);
    lines.push('');
  } else {
    lines.push('今天没有影响理解的错误。');
    lines.push('');
  }

  lines.push('─────────────');

  for (const s of pm.sentences) {
    lines.push('');
    lines.push(`第 ${s.turn} 轮`);
    lines.push(`  你说：${s.said}`);
    if (s.natural) lines.push(`  更自然：${s.natural}`);
  }

  lines.push('');
  lines.push('─────────────');
  const pauses = pm.metrics.longPausePerMin == null ? '—' : `${pm.stalls.length} 次`;
  const filler =
    pm.metrics.fillerPer100w == null ? '—' : `${pm.metrics.fillerPer100w}/百词`;
  lines.push(`长停顿 ${pauses} · 填充词 ${filler}`);
  lines.push(`原始音频在 data/sessions/…/${pm.sessionId}/turns/`);

  void writePostmortem(session, pm).catch((err) => console.error('[postmortem write]', err));

  return lines.join('\n');
}

export async function writePostmortem(session: Session, pm: Postmortem): Promise<void> {
  await writeFile(join(session.dir, 'postmortem.json'), JSON.stringify(pm, null, 2), 'utf8');
}
