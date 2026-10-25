/**
 * 一轮对话的编排。
 * 场景从 config/scenarios/ 加载。热身不进 turns，不占 atTurn。
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { asr } from './asr.js';
import { activeBeatDirective } from './beats.js';
import type { BlockUsage } from './blocks.js';
import {
  annotateTranscript,
  buildMessages,
  completeWithRetry,
  helpSeekingReply,
  isHelpSeeking,
  sanitizeReply,
  Reply as ReplySchema,
  selectModel,
  type Msg,
  type Reply,
} from './llm.js';
import type { ResolvedScenario } from './scenarios.js';
import { speak, toWav16k } from './tts.js';
import { buildWarmupLine } from './warmup.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SESSIONS_ROOT = join(REPO_ROOT, 'data', 'sessions');

export type Turn = {
  index: number;
  userText: string;
  words: { w: string; start: number; end: number; p: number }[];
  reply: Reply;
};

export type Session = {
  id: string;
  chatId: string;
  /** `${chatId}:${topicId}`。单聊的 topicId 就是 chatId */
  sessionKey: string;
  threadId: string | null;
  rootId: string | null;
  scenario: ResolvedScenario | null;
  /** index.json 的标题。三句卡和复盘用它，meta 里仍存场景文件的 title */
  listTitle: string | null;
  turns: Turn[];
  /** 热身轮。不在 turns 里，块统计要单独算上 */
  warmup: Turn | null;
  startedAt: string;
  dir: string;
  menuSent: boolean;
  warmupDone: boolean;
  seedText: string | null;
  rootText: string | null;
  anchorMessageId: string | null;
  endedAt: string | null;
  endReason: string | null;
  blockUsage: Record<string, BlockUsage> | null;
};

export function newSessionId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function sessionDir(sessionId: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return join(SESSIONS_ROOT, day, sessionId);
}

/** 下一轮目录号 = 已有正式轮次目录的 max + 1。000-warmup 不计。 */
export function turnIndexFromNames(names: string[]): number {
  let max = 0;
  for (const name of names) {
    if (!/^\d{3}$/.test(name)) continue;
    const n = Number(name);
    if (n > max) max = n;
  }
  return max + 1;
}

export async function nextTurnIndex(dir: string): Promise<number> {
  try {
    return turnIndexFromNames(await readdir(join(dir, 'turns')));
  } catch {
    return 1;
  }
}

export function warmupDir(session: Session): string {
  return join(session.dir, 'turns', '000-warmup');
}

export function formalTurnDir(session: Session, index: number): string {
  return join(session.dir, 'turns', String(index).padStart(3, '0'));
}

function metaOf(session: Session) {
  return {
    sessionId: session.id,
    chatId: session.chatId,
    threadId: session.threadId,
    rootId: session.rootId,
    sessionKey: session.sessionKey,
    anchorMessageId: session.anchorMessageId,
    rootText: session.rootText,
    scenarioId: session.scenario?.id ?? null,
    scenarioTitle: session.scenario?.title ?? null,
    seedText: session.seedText,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endReason: session.endReason,
    turnCount: session.turns.length,
    warmupDone: session.warmupDone,
    menuSent: session.menuSent,
    blockUsage: session.blockUsage,
  };
}

export async function writeMeta(session: Session): Promise<void> {
  const path = join(session.dir, 'meta.json');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(metaOf(session), null, 2), 'utf8');
  await rename(tmp, path);
}

export async function createSession(
  chatId: string,
  scenario: ResolvedScenario | null,
  opts?: {
    rootText?: string | null;
    dir?: string;
    menuSent?: boolean;
    listTitle?: string | null;
    anchorMessageId?: string | null;
    seedText?: string | null;
    sessionKey?: string;
    threadId?: string | null;
    rootId?: string | null;
  }
): Promise<Session> {
  const id = newSessionId();
  const dir = opts?.dir ?? sessionDir(id);
  await mkdir(join(dir, 'turns'), { recursive: true });

  const session: Session = {
    id,
    chatId,
    sessionKey: opts?.sessionKey ?? `${chatId}:${chatId}`,
    threadId: opts?.threadId ?? null,
    rootId: opts?.rootId ?? null,
    scenario,
    listTitle: opts?.listTitle ?? null,
    turns: [],
    warmup: null,
    startedAt: new Date().toISOString(),
    dir,
    menuSent: opts?.menuSent ?? false,
    warmupDone: false,
    seedText: opts?.seedText ?? null,
    rootText: opts?.rootText ?? null,
    anchorMessageId: opts?.anchorMessageId ?? null,
    endedAt: null,
    endReason: null,
    blockUsage: null,
  };

  await writeMeta(session);
  return session;
}

const MetaSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string().nullable(),
  rootId: z.string().nullable(),
  sessionKey: z.string().min(1),
  anchorMessageId: z.string().nullable(),
  rootText: z.string().nullable(),
  scenarioId: z.string().nullable(),
  scenarioTitle: z.string().nullable(),
  seedText: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
  turnCount: z.number(),
  warmupDone: z.boolean(),
  menuSent: z.boolean(),
  blockUsage: z.record(z.string(), z.enum(['used', 'unused', 'not_reached'])).nullable(),
});

const WordSchema = z.object({
  w: z.string(),
  start: z.number(),
  end: z.number(),
  p: z.number(),
});

async function readTurnFile(dir: string, index: number): Promise<Turn | null> {
  try {
    const asr = z
      .object({ text: z.string().optional(), words: z.array(WordSchema).optional() })
      .parse(JSON.parse(await readFile(join(dir, 'asr.json'), 'utf8')));
    const reply = ReplySchema.parse(JSON.parse(await readFile(join(dir, 'llm.json'), 'utf8')));
    return { index, userText: asr.text ?? '', words: asr.words ?? [], reply };
  } catch (err) {
    console.warn(`[session] 跳过坏轮次 ${dir}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function readTurns(dir: string): Promise<{ warmup: Turn | null; turns: Turn[] }> {
  let names: string[] = [];
  try {
    names = await readdir(join(dir, 'turns'));
  } catch {
    return { warmup: null, turns: [] };
  }
  const warmup = names.includes('000-warmup')
    ? await readTurnFile(join(dir, 'turns', '000-warmup'), 0)
    : null;
  const turns: Turn[] = [];
  for (const name of names.filter((n) => /^\d{3}$/.test(n) && n !== '000').sort()) {
    const turn = await readTurnFile(join(dir, 'turns', name), Number(name));
    if (turn) turns.push(turn);
  }
  return { warmup, turns };
}

/**
 * 启动时扫 meta.json。endedAt === null 的装回内存。
 * 旧档没有 sessionKey / endedAt 的直接跳过，不把已经结束的练习复活。
 */
export async function restoreOpenSessions(
  root: string,
  resolveScenarioById: (
    scenarioId: string
  ) => { scenario: ResolvedScenario; listTitle: string } | null
): Promise<Session[]> {
  let days: string[] = [];
  try {
    days = await readdir(root);
  } catch {
    return [];
  }
  const open: Session[] = [];
  let skipped = 0;
  for (const day of days) {
    let ids: string[] = [];
    try {
      ids = await readdir(join(root, day));
    } catch {
      continue;
    }
    for (const id of ids) {
      const dir = join(root, day, id);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      } catch {
        continue;
      }
      const parsed = MetaSchema.safeParse(raw);
      if (!parsed.success) {
        const looksNew = !!raw && typeof raw === 'object' && 'sessionKey' in raw;
        if (looksNew) {
          skipped++;
          console.warn(`[session] ${dir} 的 meta 对不上，跳过`);
        }
        continue;
      }
      const meta = parsed.data;
      if (meta.endedAt !== null) continue;
      let scenario: ResolvedScenario | null = null;
      let listTitle: string | null = null;
      if (meta.scenarioId) {
        const hit = resolveScenarioById(meta.scenarioId);
        if (!hit) {
          console.warn(`[session] ${meta.sessionId} 的场景 ${meta.scenarioId} 加载不到，跳过`);
          skipped++;
          continue;
        }
        scenario = hit.scenario;
        listTitle = hit.listTitle;
      }
      const { warmup, turns } = await readTurns(dir);
      open.push({
        id: meta.sessionId,
        chatId: meta.chatId,
        sessionKey: meta.sessionKey,
        threadId: meta.threadId,
        rootId: meta.rootId,
        scenario,
        listTitle,
        turns,
        warmup,
        startedAt: meta.startedAt,
        dir,
        menuSent: meta.menuSent,
        warmupDone: meta.warmupDone,
        seedText: meta.seedText,
        rootText: meta.rootText,
        anchorMessageId: meta.anchorMessageId,
        endedAt: null,
        endReason: meta.endReason,
        blockUsage: meta.blockUsage,
      });
    }
  }
  if (skipped) console.log(`[session] 扫盘跳过 ${skipped} 份对不上的 meta`);
  return open;
}

export async function attachScenario(
  session: Session,
  scenario: ResolvedScenario,
  listTitle: string
): Promise<void> {
  session.scenario = scenario;
  session.listTitle = listTitle;
  await writeMeta(session);
}

/** 只算三个纯声学指标，不依赖 LLM */
export function metrics(words: Turn['words']) {
  if (words.length < 2) return null;
  const first = words[0]!;
  const last = words[words.length - 1]!;
  const speechMs = (last.end - first.start) * 1000;
  if (speechMs <= 0) return null;
  const minutes = speechMs / 60000;

  let longPauses = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = (words[i]!.start - words[i - 1]!.end) * 1000;
    if (gap > 1500) longPauses++;
  }

  const fillers = words.filter((w) => /^(um|uh|erm|hmm|er|ah)$/i.test(w.w)).length;

  return {
    wpm: Math.round(words.length / minutes),
    longPausePerMin: Number((longPauses / minutes).toFixed(1)),
    fillerPer100w: Number(((fillers / words.length) * 100).toFixed(1)),
    speechMs: Math.round(speechMs),
    words: words.length,
    longPauses,
    fillers,
  };
}

export type TurnResult = {
  say: string;
  flags: Reply['flags'];
  degraded: boolean;
  trace: Record<string, unknown>;
};

async function persistTurn(turnDir: string, record: Turn, asrResult: unknown, trace: Record<string, unknown>) {
  await mkdir(turnDir, { recursive: true });
  await writeFile(join(turnDir, 'asr.json'), JSON.stringify(asrResult, null, 2), 'utf8');
  await writeFile(join(turnDir, 'llm.json'), JSON.stringify(record.reply, null, 2), 'utf8');
  await writeFile(join(turnDir, 'trace.json'), JSON.stringify(trace, null, 2), 'utf8');
  await writeFile(join(turnDir, 'metrics.json'), JSON.stringify(trace.metrics ?? null, null, 2), 'utf8');
}

function requireScenario(session: Session): ResolvedScenario {
  if (!session.scenario) throw new Error('还没选场景');
  return session.scenario;
}

/** 热身：ASR + 模板。不调 LLM，成功后 warmupDone = true */
export async function runWarmup(params: {
  session: Session;
  userOpusPath: string;
  userText: string;
}): Promise<TurnResult> {
  const scenario = requireScenario(params.session);
  const turnDir = dirname(params.userOpusPath);
  const trace: Record<string, unknown> = { turn: 0, warmup: true };

  const wavPath = join(turnDir, 'user.wav');
  let t = Date.now();
  await toWav16k(params.userOpusPath, wavPath);
  trace.transcodeMs = Date.now() - t;

  t = Date.now();
  const asrResult = await asr.transcribe(wavPath);
  trace.asrMs = Date.now() - t;
  trace.words = asrResult.words.length;

  const text = asrResult.text.trim() || params.userText.trim();
  trace.metrics = metrics(asrResult.words);

  if (!text) {
    trace.missed = true;
    return {
      say: "Sorry, I didn't catch that. Could you say it again?",
      flags: [],
      degraded: true,
      trace,
    };
  }

  const say = buildWarmupLine({
    words: asrResult.words,
    text,
    opening: scenario.opening,
  });
  const reply: Reply = { say, flags: [] };
  const record: Turn = { index: 0, userText: text, words: asrResult.words, reply };
  params.session.warmup = record;
  trace.template = true;

  await persistTurn(turnDir, record, asrResult, trace);
  await writeMeta(params.session);

  return { say, flags: [], degraded: false, trace };
}

export async function runTurn(params: {
  session: Session;
  userOpusPath: string;
  userText: string;
  /** 调用方在建目录之前就算好，避免空目录把号再加一 */
  turnIndex: number;
  onProgress?: (stage: string) => void;
}): Promise<TurnResult> {
  const scenario = requireScenario(params.session);
  const { session, userOpusPath, userText } = params;
  const index = params.turnIndex;
  const turnDir = formalTurnDir(session, index);
  await mkdir(turnDir, { recursive: true });

  const trace: Record<string, unknown> = { turn: index };

  params.onProgress?.('transcode');
  const wavPath = join(turnDir, 'user.wav');
  let t = Date.now();
  await toWav16k(userOpusPath, wavPath);
  trace.transcodeMs = Date.now() - t;

  params.onProgress?.('asr');
  t = Date.now();
  const asrResult = await asr.transcribe(wavPath);
  trace.asrMs = Date.now() - t;
  trace.words = asrResult.words.length;

  const text = asrResult.text.trim() || userText.trim();
  if (!text) {
    trace.missed = true;
    return {
      say: "Sorry, I didn't catch that. Could you say it again?",
      flags: [],
      degraded: true,
      trace,
    };
  }

  trace.metrics = metrics(asrResult.words);

  let reply: Reply;
  let degraded = false;

  if (isHelpSeeking(text, asrResult.words)) {
    reply = helpSeekingReply();
    trace.help = true;
  } else {
    params.onProgress?.('llm');
    const history: Msg[] = [];
    if (session.warmup) {
      history.push(
        { role: 'user', content: session.warmup.userText },
        {
          role: 'assistant',
          content: JSON.stringify({ say: session.warmup.reply.say, flags: [] }),
        }
      );
    }
    for (const turn of session.turns) {
      history.push(
        { role: 'user', content: turn.userText },
        { role: 'assistant', content: JSON.stringify({ say: turn.reply.say, flags: [] }) }
      );
    }

    const beat = scenario.beats.find((b) => b.atTurn === index);
    const said = [
      ...(session.warmup ? [session.warmup.userText] : []),
      ...session.turns.map((turn) => turn.userText),
      text,
    ];
    const beatDirective = activeBeatDirective(beat, scenario.blocks, said);
    const messages = buildMessages({
      persona: scenario.persona,
      ...(session.warmup ? {} : { opening: scenario.opening }),
      ...(scenario.goal ? { goal: scenario.goal } : {}),
      ...(scenario.hiddenGoal ? { hiddenGoal: scenario.hiddenGoal } : {}),
      blocks: scenario.blocks.map((b) => ({ n: b.n, frame: b.frame })),
      ...(beatDirective ? { beatDirective } : {}),
      ...(session.seedText ? { seedText: session.seedText } : {}),
      history,
      userText: annotateTranscript(asrResult.words, text),
    });

    t = Date.now();
    const model = selectModel();
    const completed = await completeWithRetry(model, messages);
    trace.llmMs = Date.now() - t;
    trace.provider = model.id;
    if (completed.error) trace.llmError = completed.error;
    degraded = completed.degraded;
    reply = sanitizeReply(completed.reply, asrResult.words, text);
  }

  const record: Turn = {
    index,
    userText: text,
    words: asrResult.words,
    reply,
  };
  session.turns.push(record);

  await persistTurn(turnDir, record, asrResult, trace);
  await writeMeta(session);

  return { say: reply.say, flags: reply.flags, degraded, trace };
}

export async function speakTurn(session: Session, text: string) {
  const scenario = requireScenario(session);
  return speak(text, {
    ...(scenario.voice ? { voice: scenario.voice } : {}),
    ...(scenario.ttsRate ? { rate: scenario.ttsRate } : {}),
  });
}

export async function readMeta(dir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
}
