/**
 * 复盘：从攒下来的 turns 里挑 3 句，拼成一张卡片。
 * 不重新调 LLM —— 复盘是攒数据，不是重新推导。
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, Turn } from './pipeline.js';

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

function aggregateMetrics(session: Session) {
  const per = session.turns
    .map((t) => t.reply && t.userText ? t : null)
    .filter(Boolean);

  const m = session.turns
    .flatMap((t) => {
      const w = t.words;
      if (w.length < 2) return [];
      const first = w[0]!;
      const last = w[w.length - 1]!;
      const speechMs = (last.end - first.start) * 1000;
      if (speechMs <= 0) return [];
      let longPauses = 0;
      for (let i = 1; i < w.length; i++) {
        if ((w[i]!.start - w[i - 1]!.end) * 1000 > 1500) longPauses++;
      }
      const fillers = w.filter((x) => /^(um|uh|erm|hmm|er|ah)$/i.test(x.w)).length;
      return [{ speechMs, words: w.length, longPauses, fillers }];
    });

  const speechMs = m.reduce((s, x) => s + x.speechMs, 0);
  const words = m.reduce((s, x) => s + x.words, 0);
  const longPauses = m.reduce((s, x) => s + x.longPauses, 0);
  const fillers = m.reduce((s, x) => s + x.fillers, 0);

  if (speechMs <= 0 || words === 0) {
    return { wpm: 0, longPausePerMin: 0, fillerPer100w: 0 };
  }

  const minutes = speechMs / 60000;
  return {
    wpm: Math.round(words / minutes),
    longPausePerMin: Number((longPauses / minutes).toFixed(1)),
    fillerPer100w: Number(((fillers / words) * 100).toFixed(1)),
    _unused: per.length,
  };
}

export type Postmortem = {
  sessionId: string;
  scenarioId: string;
  endReason: string;
  turnCount: number;
  metrics: ReturnType<typeof aggregateMetrics>;
  topIssue: { said: string; better: string; why?: string; turn: number } | null;
  sentences: {
    turn: number;
    said: string;
    expression: string;
    natural: string;
    audioUser: string;
  }[];
  stalls: { turn: number; signal: string; pauseMs: number }[];
};

export function buildPostmortem(session: Session, endReason = 'user_end'): Postmortem {
  const picked = pickSentences(session);

  const allFlags = session.turns.flatMap((t) =>
    t.reply.flags.map((f) => ({ ...f, turn: t.index }))
  );
  const top = [...allFlags].sort((a, b) => b.severity - a.severity)[0];

  const stalls = session.turns.flatMap((t) => {
    const w = t.words;
    const out: { turn: number; signal: string; pauseMs: number }[] = [];
    for (let i = 1; i < w.length; i++) {
      const gap = (w[i]!.start - w[i - 1]!.end) * 1000;
      if (gap > 1500) out.push({ turn: t.index, signal: 'long_pause', pauseMs: Math.round(gap) });
    }
    return out;
  });

  return {
    sessionId: session.id,
    scenarioId: session.scenario.id,
    endReason,
    turnCount: session.turns.length,
    metrics: aggregateMetrics(session),
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
      return {
        turn: t.index,
        said: t.userText,
        expression: f
          ? `${f.said} → ${f.better}${f.why ? `（${f.why}）` : ''}`
          : '这一句没有影响理解的问题',
        natural: t.reply.say,
        audioUser: `turns/${String(t.index).padStart(3, '0')}/user.opus`,
      };
    }),
    stalls,
  };
}

/** 生成发到飞书的卡片文本。一屏能看完是硬要求。 */
export function buildReview(session: Session, endReason = 'user_end'): string {
  const pm = buildPostmortem(session, endReason);

  const lines: string[] = [];
  lines.push(
    `🎯 ${session.scenario.title} · ${pm.turnCount} 轮 · 语速 ${pm.metrics.wpm} wpm`
  );
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
    lines.push(`  表达：${s.expression}`);
    if (s.natural) lines.push(`  更自然：${s.natural}`);
  }

  lines.push('');
  lines.push('─────────────');
  lines.push(
    `长停顿 ${pm.stalls.length} 次 · 填充词 ${pm.metrics.fillerPer100w}/百词`
  );
  lines.push(`原始音频在 data/sessions/…/${pm.sessionId}/turns/`);

  void writePostmortem(session, pm).catch((err) =>
    console.error('[postmortem write]', err)
  );

  return lines.join('\n');
}

export async function writePostmortem(session: Session, pm: Postmortem): Promise<void> {
  await writeFile(
    join(session.dir, 'postmortem.json'),
    JSON.stringify(pm, null, 2),
    'utf8'
  );
}
