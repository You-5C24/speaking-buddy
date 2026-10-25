/**
 * 一轮对话的编排。MVP 阶段：无状态机、无持久化。
 * 上下文就是一个内存数组，进程重启就丢（可接受）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asr } from './asr.js';
import { speak, toWav16k } from './tts.js';
import { buildMessages, completeWithRetry, selectModel, type Msg, type Reply } from './llm.js';
import type { IncomingVoice } from './lark.js';

export type Scenario = {
  id: string;
  title: string;
  level: string;
  goal: string;
  persona: string;
  opening: string;
  ttsRate?: string;
  voice?: string;
  beats: { need: string; hint: string }[];
};

export type Turn = {
  index: number;
  userText: string;
  words: { w: string; start: number; end: number; p: number }[];
  reply: Reply;
};

export type Session = {
  id: string;
  chatId: string;
  scenario: Scenario;
  turns: Turn[];
  startedAt: string;
  dir: string;
};

let scenarioCache: Scenario | null = null;

export async function loadScenario(): Promise<Scenario> {
  if (scenarioCache) return scenarioCache;
  const raw = await readFile(new URL('../config/scenario.json', import.meta.url), 'utf8');
  scenarioCache = JSON.parse(raw) as Scenario;
  return scenarioCache;
}

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
  return join(process.cwd(), 'data', 'sessions', day, sessionId);
}

export async function ensureSession(chatId: string): Promise<Session> {
  const scenario = await loadScenario();
  const id = newSessionId();
  const dir = sessionDir(id);
  await mkdir(join(dir, 'turns'), { recursive: true });

  const session: Session = {
    id,
    chatId,
    scenario,
    turns: [],
    startedAt: new Date().toISOString(),
    dir,
  };

  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        sessionId: id,
        chatId,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        startedAt: session.startedAt,
        endReason: null,
        turnCount: 0,
      },
      null,
      2
    ),
    'utf8'
  );

  return session;
}

/** 只算三个纯声学指标，不依赖 LLM */
export function metrics(words: Turn['words']) {
  if (words.length < 2) return null;
  const first = words[0]!;
  const last = words[words.length - 1]!;
  // 分母是「首词 start → 末词 end」，不是音频文件长度 —— 否则停顿会被算进去
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
  };
}

export type TurnResult = {
  say: string;
  flags: Reply['flags'];
  degraded: boolean;
  trace: Record<string, unknown>;
};

export async function runTurn(params: {
  session: Session;
  userOpusPath: string;
  userText: string;
  onProgress?: (stage: string) => void;
}): Promise<TurnResult> {
  const { session, userOpusPath, userText } = params;
  const index = session.turns.length + 1;
  const turnDir = join(session.dir, 'turns', String(index).padStart(3, '0'));
  await mkdir(turnDir, { recursive: true });

  const trace: Record<string, unknown> = { turn: index };

  // ① 转码
  params.onProgress?.('transcode');
  const wavPath = join(turnDir, 'user.wav');
  let t = Date.now();
  await toWav16k(userOpusPath, wavPath);
  trace.transcodeMs = Date.now() - t;

  // ② ASR
  params.onProgress?.('asr');
  t = Date.now();
  const asrResult = await asr.transcribe(wavPath);
  trace.asrMs = Date.now() - t;
  trace.words = asrResult.words.length;

  // ASR 可能听不出来，退回飞书气泡的文本（如果有）或直接说没听清
  const text = asrResult.text.trim() || userText.trim();
  if (!text) {
    return {
      say: "Sorry, I didn't catch that. Could you say it again?",
      flags: [],
      degraded: true,
      trace,
    };
  }

  // ③ 指标
  trace.metrics = metrics(asrResult.words);

  // ④ LLM
  params.onProgress?.('llm');
  const history: Msg[] = session.turns.flatMap((turn) => [
    { role: 'user' as const, content: turn.userText },
    { role: 'assistant' as const, content: `{"say":${JSON.stringify(turn.reply.say)},"flags":[]}` },
  ]);

  const messages = buildMessages({
    persona: session.scenario.persona,
    opening: session.scenario.opening,
    history,
    userText: text,
  });

  t = Date.now();
  const model = selectModel();
  const { reply, degraded, error } = await completeWithRetry(model, messages);
  trace.llmMs = Date.now() - t;
  trace.provider = model.id;
  if (error) trace.llmError = error;

  // ⑤ 落盘
  const record: Turn = {
    index,
    userText: text,
    words: asrResult.words,
    reply,
  };
  session.turns.push(record);

  await writeFile(join(turnDir, 'asr.json'), JSON.stringify(asrResult, null, 2), 'utf8');
  await writeFile(join(turnDir, 'llm.json'), JSON.stringify(reply, null, 2), 'utf8');
  await writeFile(join(turnDir, 'trace.json'), JSON.stringify(trace, null, 2), 'utf8');
  await writeFile(
    join(turnDir, 'metrics.json'),
    JSON.stringify(trace.metrics ?? null, null, 2),
    'utf8'
  );

  return { say: reply.say, flags: reply.flags, degraded, trace };
}

export async function speakTurn(session: Session, text: string) {
  return speak(text, {
    ...(session.scenario.voice ? { voice: session.scenario.voice } : {}),
    ...(session.scenario.ttsRate ? { rate: session.scenario.ttsRate } : {}),
  });
}
