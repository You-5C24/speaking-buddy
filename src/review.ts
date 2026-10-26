/**
 * 复盘：把整场逐句判一遍，拼成一张卡片。
 *
 * 和以前最大的区别：**判分不在对话里做，在这里做**（见 `grading.ts` 顶部）。
 * 所以这个文件现在是 async 的，`/end` 时多花几秒，那是值得的。
 *
 * 卡片的原则（docs/04 §三）：
 * - **每一句都点到**，不再只挑 3 句。没被挑中的句子，用户永远不知道自己说对了没有，
 *   而「我到底对不对」正是他要的答案。
 * - 四档分开：没问题 / 不地道 / 要改 / 没听清。`没听清` 不是错，不占过错。
 * - 不给语速打分（用户明确说语速不重要）。语速只留在 postmortem.json 里。
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mishearTarget } from './beats.js';
import { assignNotReached, computeBlockUsage, type BlockUsage } from './blocks.js';
import { gradeSession, type Sentence, type SessionGrade, type Verdict } from './grading.js';
import { longPauseGaps, metrics, type Session, type Turn } from './pipeline.js';

// ────────────────────────────────────────────────────────────
// 指标与块统计
// ────────────────────────────────────────────────────────────

export type AggregateMetrics = {
  wpm: number | null;
  longPausePerMin: number | null;
  fillerPer100w: number | null;
};

/**
 * 累加每轮 `metrics()` 的计数，不另抄一套公式。
 * 间隙检测结构上打不出停顿（whisper 把静音吞进词长），0 记成 null。
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

const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

function blockUsageLine(
  blocks: { n: number }[],
  usage: Record<string, BlockUsage>,
  missed: number[]
): string {
  const sorted = [...blocks].sort((a, b) => a.n - b.n);
  const used = sorted.filter((b) => usage[String(b.n)] === 'used').length;
  // 一开口都没说的时候，三个 ✗ 是在骂人。改成 `—`：没测到，不是没做到。
  const untouched = used === 0 && sorted.every((b) => usage[String(b.n)] !== 'used');
  const marks = sorted
    .map((b) => {
      const state = usage[String(b.n)] ?? 'unused';
      const mark =
        missed.includes(b.n) || untouched
          ? '—' // 店员没做那个动作 / 这轮根本没轮到，都不是用户漏了
          : state === 'used'
            ? '✓'
            : state === 'not_reached'
              ? '—'
              : '✗';
      return `${b.n} ${mark}`;
    })
    .join('  ');
  return `三句用了${CN[used] ?? String(used)}句：${marks}`;
}

// ────────────────────────────────────────────────────────────
// 卡片数据
// ────────────────────────────────────────────────────────────

export type VerdictOrUngraded = Verdict | 'ungraded';

export type Postmortem = {
  sessionId: string;
  scenarioId: string;
  endReason: string;
  turnCount: number;
  metrics: AggregateMetrics;
  blockUsage: Record<string, BlockUsage> | null;
  counts: Record<VerdictOrUngraded, number>;
  sentences: {
    turn: number;
    said: string;
    form: 'full' | 'fragment';
    /** 这一句有几个词。短答（For here / To go）不标「只说了半句」 */
    wordCount: number;
    /** 三次采样里判成同一档的比例。1 = 稳，0.34 = 三次全不同。不上卡片，只落盘 */
    agreement: number | null;
    verdict: VerdictOrUngraded;
    /** 出问题的片段（原样）。只有 wrong / unnatural 有 */
    fragment: string | null;
    fix: string | null;
    better: string | null;
    why: string | null;
    note: string | null;
    audioUser: string;
  }[];
  /** 从这场真实错误里长出来的练习项 */
  drills: string[];
  stalls: { turn: number; signal: string; pauseMs: number }[];
  /** 店员该做没做的动作（beats）。这些块不算用户漏了 */
  beatsMissed: { atTurn: number; forBlock: number | null }[];
};

function audioOf(turn: number): string {
  return turn === 0
    ? 'turns/000-warmup/user.opus'
    : `turns/${String(turn).padStart(3, '0')}/user.opus`;
}

const EMPTY_COUNTS = (): Record<VerdictOrUngraded, number> => ({
  ok: 0,
  unnatural: 0,
  wrong: 0,
  unclear: 0,
  ungraded: 0,
});

/**
 * 店员该做、但没做的动作。
 *
 * `atTurn` 的回复里应该出现 beat 要求的动作（比如把用户刚说的 medium 说成 large）。
 * 判断方式：`beats.ts` 的 `specifyMishear` 是确定性的，给定用户说过的话就能算出
 * 「应该换成哪个词」；如果 bot 那一轮的回复里没有这个词，就是没做到。
 * 只对听错类 beat 生效，别的 beat 返回 `false`（宁可不判）。
 */
export function beatsNotPerformed(session: Session): { atTurn: number; forBlock: number | null }[] {
  const out: { atTurn: number; forBlock: number | null }[] = [];
  if (!session.scenario) return out;
  const scenario = session.scenario;

  for (const beat of scenario.beats) {
    // 这一轮根本没发生就不判。不然刚热完身就 /end，卡片会说
    // 「店员第 2 轮该做的动作没做」——第 2 轮压根不存在。
    const beatTurn = session.turns.find((t) => t.index === beat.atTurn);
    if (!beatTurn) continue;

    // 只对「听错」这一类能确定性核对的 beat 生效。
    // 换法由 beats.ts 从用户已经说过的话里推出，和注入 prompt 时是同一个函数。
    const saidUpTo = [
      ...(session.warmup ? [session.warmup.userText] : []),
      ...session.turns.filter((t) => t.index <= beat.atTurn).map((t) => t.userText),
    ];
    const want = mishearTarget(beat.directive, saidUpTo)?.to;
    if (!want) continue;
    const ok = new RegExp(`\\b${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
      beatTurn.reply.say
    );
    if (!ok) out.push({ atTurn: beat.atTurn, forBlock: beat.forBlock ?? null });
  }
  return out;
}

export function buildPostmortem(session: Session, grade: SessionGrade, endReason = 'user_end'): Postmortem {
  if (!session.scenario) throw new Error('还没选场景，没有复盘');

  const byTurn = new Map<number, Sentence>(grade.sentences.map((s) => [s.turn, s]));
  const turns: (Turn | null)[] = [
    ...(session.warmup ? [session.warmup] : []),
    ...session.turns,
  ];

  const counts = EMPTY_COUNTS();
  const sentences: Postmortem['sentences'] = [];

  for (const t of turns) {
    if (!t || !t.userText.trim()) continue;
    const s = byTurn.get(t.index);
    const verdict: VerdictOrUngraded = s?.verdict ?? 'ungraded';
    counts[verdict]++;
    sentences.push({
      turn: t.index,
      said: t.userText,
      form: s?.form ?? 'full',
      wordCount: t.userText.trim().split(/\s+/).filter(Boolean).length,
      agreement: s?.agreement ?? null,
      verdict,
      fragment: s?.said ?? null,
      fix: s?.fix ?? null,
      better: s?.better ?? null,
      why: s?.why ?? null,
      note: s?.note ?? null,
      audioUser: audioOf(t.index),
    });
  }

  const stalls = session.turns.flatMap((t) =>
    longPauseGaps(t.words).map(({ gapMs }) => ({
      turn: t.index,
      signal: 'long_pause',
      pauseMs: Math.round(gapMs),
    }))
  );

  const blockUsage = blockUsageFor(session);
  session.blockUsage = blockUsage;

  const missed = beatsNotPerformed(session);
  for (const m of missed) {
    if (m.forBlock != null && blockUsage) blockUsage[String(m.forBlock)] = 'unused';
  }

  return {
    sessionId: session.id,
    scenarioId: session.scenario.id,
    endReason,
    turnCount: session.turns.length,
    metrics: aggregateMetrics(session),
    blockUsage,
    counts,
    sentences,
    drills: grade.drills,
    stalls,
    beatsMissed: missed,
  };
}

// ────────────────────────────────────────────────────────────
// 卡片
// ────────────────────────────────────────────────────────────

const MARK: Record<VerdictOrUngraded, string> = {
  ok: '✓',
  unnatural: '~',
  wrong: '✗',
  unclear: '?',
  ungraded: '·',
};

/** 一屏能看完是硬要求。超过这个轮次就把连续的 ✓ 折叠。 */
const MAX_LINES = 14;

function countsLine(c: Record<VerdictOrUngraded, number>): string {
  const bits: string[] = [`✓ ${c.ok} 句没问题`];
  if (c.unnatural) bits.push(`~ ${c.unnatural} 句不地道`);
  if (c.wrong) bits.push(`✗ ${c.wrong} 句要改`);
  if (c.unclear) bits.push(`? ${c.unclear} 句没听清`);
  if (c.ungraded) bits.push(`· ${c.ungraded} 句没判出来`);
  return bits.join(' · ');
}

function sentenceBlock(s: Postmortem['sentences'][number]): string[] {
  const label = s.turn === 0 ? '热身' : `第 ${s.turn} 轮`;
  const lines: string[] = [`${MARK[s.verdict]} ${label}  ${s.said}`];

  if (s.verdict === 'wrong' || s.verdict === 'unnatural') {
    if (s.fragment && s.fix && s.fragment.trim().toLowerCase() !== s.fix.trim().toLowerCase()) {
      lines.push(`    错在：${s.fragment} → ${s.fix}`);
    }
    if (s.better && s.better.trim().toLowerCase() !== s.said.trim().toLowerCase()) {
      lines.push(`    更地道：${s.better}`);
    }
    if (s.why) lines.push(`    为什么：${s.why}`);
  } else if (s.verdict === 'unclear') {
    lines.push(`    这个词没听清，这次不判`);
  } else if (s.verdict === 'ungraded') {
    lines.push(`    这次没判出来`);
  }
  // 「只说了半句」只对真正卡住的那句说。`For here` / `To go` 这种短答是完整的，
  // 模型把 form 判成 fragment 是它的问题，不该印在卡片上让用户以为自己没说完整。
  if (s.verdict !== 'unclear' && s.verdict !== 'ungraded' && s.form === 'fragment' && s.wordCount >= 4) {
    lines.push(`    只说了半句`);
  }
  // 热身那轮不给备注：它是「念一句准备好的话」，提内容上的意见没有意义
  if (s.note && s.turn !== 0) lines.push(`    ⚑ ${s.note}`);

  return lines;
}

/** 连续 3 个以上 ✓ 折成一行，否则轮次一多就翻三屏 */
function collapseOk(list: Postmortem['sentences']): (Postmortem['sentences'][number] | string)[] {
  if (list.length <= MAX_LINES) return list;
  const out: (Postmortem['sentences'][number] | string)[] = [];
  let run: Postmortem['sentences'] = [];
  const flush = () => {
    if (run.length >= 3) {
      const a = run[0]!.turn === 0 ? '热身' : `第 ${run[0]!.turn} 轮`;
      const b = `第 ${run[run.length - 1]!.turn} 轮`;
      out.push(`✓ ${a}–${b} 都没问题`);
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const s of list) {
    if (s.verdict === 'ok') run.push(s);
    else {
      flush();
      out.push(s);
    }
  }
  flush();
  return out;
}

export function renderCard(session: Session, pm: Postmortem): string {
  const scenario = session.scenario;
  if (!scenario) throw new Error('还没选场景，没有复盘');

  const title = session.listTitle || scenario.title;
  const lines: string[] = [];

  lines.push(`🎯 ${title} · ${pm.turnCount} 轮`);
  lines.push(countsLine(pm.counts));
  lines.push('');

  for (const item of collapseOk(pm.sentences)) {
    lines.push(...(typeof item === 'string' ? [item] : sentenceBlock(item)));
    lines.push('');
  }

  if (scenario.cardStyle !== 'rewrite' && pm.blockUsage) {
    const missedBlocks = pm.beatsMissed
      .map((m) => m.forBlock)
      .filter((n): n is number => n != null);
    lines.push(blockUsageLine(scenario.blocks, pm.blockUsage, missedBlocks));
    for (const m of pm.beatsMissed) {
      lines.push(
        m.forBlock == null
          ? `店员第 ${m.atTurn} 轮该做的动作没做，这一段没练到`
          : `店员第 ${m.atTurn} 轮该做的动作没做，${m.forBlock} 号句没机会用——不是你漏了`
      );
    }
    lines.push('');
  }

  if (pm.drills.length) {
    lines.push('下次先练这组');
    for (const d of pm.drills) lines.push(`  ${d}`);
  }

  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * `/end` 的入口。判分失败也要出卡片——复盘是收尾，不能因为一次调用挂掉就没有。
 */
export async function buildReview(session: Session, endReason = 'user_end'): Promise<string> {
  const scenario = session.scenario;
  if (!scenario) throw new Error('还没选场景，没有复盘');

  const turns = [
    ...(session.warmup ? [session.warmup] : []),
    ...session.turns,
  ].map((t) => ({
    index: t.index,
    text: t.userText,
    words: t.words,
    botSay: t.reply.say,
  }));

  let grade: SessionGrade = { sentences: [], drills: [], gradeMs: 0 };
  try {
    grade = await gradeSession({
      title: session.listTitle || scenario.title,
      turns,
    });
  } catch (err) {
    console.error('[review] 判分失败，卡片只出统计：', err instanceof Error ? err.message : err);
  }

  const pm = buildPostmortem(session, grade, endReason);
  void writePostmortem(session, pm).catch((err) => console.error('[postmortem write]', err));
  return renderCard(session, pm);
}

export async function writePostmortem(session: Session, pm: Postmortem): Promise<void> {
  await writeFile(join(session.dir, 'postmortem.json'), JSON.stringify(pm, null, 2), 'utf8');
}
