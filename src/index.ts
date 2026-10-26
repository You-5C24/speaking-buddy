/**
 * 入口：选场景 → 三句卡 → 热身（模板，含开场语音）→ 正式轮 → /end 复盘。
 *
 * 单聊的 sessionKey 退化成 chatId。群里一个话题一场练习，回复走 reply。
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { asr } from './asr.js';
import { envCredentials, startBot, type IncomingVoice, type SentMessage } from './lark.js';
import { isSeedText, nextAction } from './flow.js';
import {
  attachScenario,
  createSession,
  formalTurnDir,
  nextTurnIndex,
  restoreOpenSessions,
  runTurn,
  runWarmup,
  SESSIONS_ROOT,
  speakTurn,
  warmupDir,
  writeMeta,
  type Session,
} from './pipeline.js';
import { buildReview } from './review.js';
import {
  loadAll,
  loadIndex,
  renderMenu,
  renderScenarioCard,
  resolveByAlias,
  resolveScenario,
  type IndexEntry,
  type ResolvedScenario,
} from './scenarios.js';
import { anchorId, lookupKeys, primaryKey, replyInThread, sessionKey } from './topic.js';

type Catalog = {
  index: IndexEntry[];
  byId: Map<string, ResolvedScenario>;
};

let cached: Catalog | null = null;

async function catalog(): Promise<Catalog> {
  if (cached) return cached;
  const index = await loadIndex();
  const { scenarios, problems } = await loadAll();
  const bad = Object.entries(problems);
  if (bad.length) {
    for (const [id, list] of bad) console.error(`[scenario ${id}]`, list.join('；'));
  }
  cached = {
    index,
    byId: new Map(scenarios.filter((s) => !problems[s.id]).map((s) => [s.id, resolveScenario(s)])),
  };
  return cached;
}

/**
 * 同一个 Session 会挂在多个键上：messageId、rootId、threadId。结束后留着，避免自动重开。
 *
 * 串行只在 `lark.ts` 的 `enqueue` 里做，键是 `primaryKey(msg)`（= sessionKey）。
 * 这里不要再按 chatId 加一层锁：那会让同一群里两个话题互相等，
 * 而 §9 第 11 条要的正是「A 的 5 秒链路不卡住 B」。
 */
const sessions = new Map<string, Session>();

function findSession(msg: IncomingVoice): Session | null {
  for (const key of lookupKeys(msg)) {
    const found = sessions.get(key);
    if (found) return found;
  }
  return null;
}

function remember(session: Session, msg: IncomingVoice) {
  session.anchorMessageId = anchorId(msg);
  if (msg.threadId) session.threadId = msg.threadId;
  if (msg.rootId) session.rootId = msg.rootId;
  session.sessionKey = primaryKey(msg);
  for (const key of lookupKeys(msg)) sessions.set(key, session);
}

function adopt(session: Session, sent: SentMessage) {
  if (sent.threadId) session.threadId = sent.threadId;
  if (sent.rootId) session.rootId = sent.rootId;
  if (session.threadId) session.sessionKey = sessionKey(session.chatId, session.threadId);
  else if (session.rootId) session.sessionKey = sessionKey(session.chatId, session.rootId);
  for (const id of [sent.threadId, sent.rootId, sent.messageId, session.threadId, session.rootId]) {
    if (id) sessions.set(sessionKey(session.chatId, id), session);
  }
}

function rememberRestored(session: Session) {
  sessions.set(session.sessionKey, session);
  for (const id of [session.threadId, session.rootId, session.anchorMessageId]) {
    if (id) sessions.set(sessionKey(session.chatId, id), session);
  }
}

function forget(session: Session) {
  for (const [key, value] of sessions) {
    if (value === session) sessions.delete(key);
  }
}

function targetOf(msg: IncomingVoice) {
  return {
    chatId: msg.chatId,
    anchorMessageId: anchorId(msg),
    inThread: replyInThread(msg.chatType),
  };
}

async function replyText(
  bot: ReturnType<typeof startBot>,
  msg: IncomingVoice,
  session: Session | null,
  text: string
) {
  const sent = await bot.sendText(targetOf(msg), text);
  if (session) {
    const learned = (!session.threadId && sent.threadId) || (!session.rootId && sent.rootId);
    adopt(session, sent);
    if (learned) await writeMeta(session);
  }
  return sent;
}

function isEndCommand(text: string): boolean {
  return /^\s*\/(end|stop|结束)\s*$/i.test(text);
}

const ENDED_TEXT = '这次练习结束了，开个新话题继续。';

async function sendVoice(bot: ReturnType<typeof startBot>, msg: IncomingVoice, session: Session, say: string) {
  const audio = await speakTurn(session, say);
  try {
    const sent = await bot.sendOpus(targetOf(msg), audio.path, audio.durationMs);
    const learned = (!session.threadId && sent.threadId) || (!session.rootId && sent.rootId);
    adopt(session, sent);
    if (learned) await writeMeta(session);
  } finally {
    await rm(audio.dir, { recursive: true, force: true }).catch(() => {});
  }
}

function topicFields(msg: IncomingVoice) {
  return {
    sessionKey: primaryKey(msg),
    anchorMessageId: anchorId(msg),
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    ...(msg.rootId ? { rootId: msg.rootId } : {}),
  };
}

async function openMenu(bot: ReturnType<typeof startBot>, msg: IncomingVoice) {
  const cat = await catalog();
  const session = await createSession(msg.chatId, null, {
    rootText: msg.msgType === 'text' ? msg.text : null,
    menuSent: true,
    ...topicFields(msg),
  });
  remember(session, msg);
  await replyText(bot, msg, session, renderMenu(cat.index));
}

async function openScenario(
  bot: ReturnType<typeof startBot>,
  msg: IncomingVoice,
  scenario: ResolvedScenario,
  listTitle: string,
  rootText: string,
  seedText: string | null = null
) {
  const session = await createSession(msg.chatId, scenario, {
    rootText,
    listTitle,
    menuSent: false,
    seedText,
    ...topicFields(msg),
  });
  remember(session, msg);
  await replyText(
    bot,
    msg,
    session,
    renderScenarioCard(scenario, { title: listTitle, seedText: session.seedText })
  );
  console.log(`[session] 开始 ${session.id} ${scenario.id} ${session.sessionKey}`);
}

async function chooseScenario(
  bot: ReturnType<typeof startBot>,
  session: Session,
  msg: IncomingVoice,
  scenario: ResolvedScenario,
  listTitle: string
) {
  remember(session, msg);
  await attachScenario(session, scenario, listTitle);
  await replyText(
    bot,
    msg,
    session,
    renderScenarioCard(scenario, { title: listTitle, seedText: session.seedText })
  );
  console.log(`[session] 开始 ${session.id} ${scenario.id} ${session.sessionKey}`);
}

async function lookup(text: string): Promise<{ scenario: ResolvedScenario; title: string } | null> {
  const cat = await catalog();
  const id = resolveByAlias(text, cat.index);
  if (!id) return null;
  const scenario = cat.byId.get(id);
  if (!scenario) return null;
  const title = cat.index.find((e) => e.id === id)?.title ?? scenario.title;
  return { scenario, title };
}

function flowOf(session: Session | null) {
  if (!session) return null;
  return {
    ended: session.endedAt != null,
    hasScenario: session.scenario != null,
    warmupDone: session.warmupDone,
  };
}

async function handleText(bot: ReturnType<typeof startBot>, msg: IncomingVoice) {
  const session = findSession(msg);
  if (session) remember(session, msg);
  const picked = await lookup(msg.text);
  const action = nextAction(flowOf(session), {
    kind: 'text',
    alias: picked != null,
    endCommand: isEndCommand(msg.text),
    seed: isSeedText(msg.text),
  });

  switch (action) {
    case 'note-ended':
      await replyText(bot, msg, session, ENDED_TEXT);
      return;
    case 'restart':
      if (session) forget(session);
      await openScenario(bot, msg, picked!.scenario, picked!.title, msg.text);
      return;
    case 'start-seed': {
      const cat = await catalog();
      const scenario = cat.byId.get('free-1');
      const title = cat.index.find((e) => e.id === 'free-1')?.title;
      if (!scenario || !title) {
        await openMenu(bot, msg);
        return;
      }
      await openScenario(bot, msg, scenario, title, msg.text, msg.text);
      return;
    }
    case 'no-practice':
      if (session) forget(session);
      await replyText(bot, msg, null, '现在没有进行中的练习。回个数字选场景，或者直接发一条语音。');
      return;
    case 'review': {
      if (!session) return;
      session.endedAt = new Date().toISOString();
      session.endReason = 'user_end';
      const card = buildReview(session);
      await writeMeta(session);
      await replyText(bot, msg, session, card);
      return;
    }
    case 'start':
      await openScenario(bot, msg, picked!.scenario, picked!.title, msg.text);
      return;
    case 'menu':
      await openMenu(bot, msg);
      return;
    case 'choose':
      if (!session || !picked) return;
      await chooseScenario(bot, session, msg, picked.scenario, picked.title);
      return;
    case 'repeat-menu':
      await replyText(bot, msg, session, renderMenu((await catalog()).index));
      return;
    case 'need-voice':
      await replyText(bot, msg, session, '准备好了就发一条语音。');
      return;
    case 'live-text':
      await replyText(bot, msg, session, '直接发语音就行，我们练口语。发 /end 结束这次练习。');
      return;
    default:
      return;
  }
}

async function handleAudio(bot: ReturnType<typeof startBot>, msg: IncomingVoice) {
  const session = findSession(msg);
  if (session) remember(session, msg);
  const action = nextAction(flowOf(session), { kind: 'audio', alias: false, endCommand: false });

  if (action === 'audio-ended') {
    await replyText(bot, msg, session, ENDED_TEXT);
    return;
  }
  if (action === 'audio-menu') {
    await openMenu(bot, msg);
    return;
  }
  if (!session) return;
  if (action === 'audio-need-choice') {
    await replyText(bot, msg, session, renderMenu((await catalog()).index));
    return;
  }

  const warming = action === 'warmup';
  const turnIndex = warming ? 0 : await nextTurnIndex(session.dir);
  const dir = warming ? warmupDir(session) : formalTurnDir(session, turnIndex);
  const turnLabel = warming ? 'warmup' : String(turnIndex);

  try {
    await mkdir(dir, { recursive: true });
    const opusPath = join(dir, 'user.opus');
    const t0 = Date.now();
    await bot.downloadResource(msg.messageId, msg.fileKey!, opusPath);

    const result = warming
      ? await runWarmup({ session, userOpusPath: opusPath, userText: msg.text })
      : await runTurn({ session, userOpusPath: opusPath, userText: msg.text, turnIndex });

    await sendVoice(bot, msg, session, result.say);
    if (warming && !result.trace.missed) {
      session.warmupDone = true;
      await writeMeta(session);
    }

    const total = Date.now() - t0;
    console.log(
      `[${turnLabel}] ${total}ms  asr=${result.trace.asrMs ?? '-'}ms llm=${result.trace.llmMs ?? '-'}ms` +
        (result.degraded ? '  ⚠️ degraded' : '') +
        (result.trace.help ? '  help' : '') +
        (result.trace.template ? '  template' : '')
    );
  } catch (err) {
    console.error('[handleVoice]', err);
    const message = err instanceof Error ? err.message : String(err);
    await replyText(bot, msg, session, `我这边出了点问题：${message.slice(0, 120)}。再说一次试试？`).catch(
      () => {}
    );
  }
}

async function handleVoice(bot: ReturnType<typeof startBot>, msg: IncomingVoice) {
  if (msg.msgType === 'text') {
    await handleText(bot, msg);
    return;
  }
  if (msg.msgType === 'audio' && msg.fileKey) {
    await handleAudio(bot, msg);
    return;
  }
  await replyText(bot, msg, findSession(msg), '我们先用语音练 —— 按住说话，随便说一句就行。');
}

async function main() {
  const { appId, appSecret } = envCredentials();
  const cat = await catalog();
  console.log(`场景：${[...cat.byId.keys()].join(', ') || '(无)'}`);
  const restored = await restoreOpenSessions(SESSIONS_ROOT, (id) => {
    const scenario = cat.byId.get(id);
    if (!scenario) return null;
    const listTitle = cat.index.find((e) => e.id === id)?.title ?? scenario.title;
    return { scenario, listTitle };
  });
  for (const session of restored) rememberRestored(session);
  if (restored.length) console.log(`恢复 ${restored.length} 场未结束的练习`);

  const bot = startBot({
    appId,
    appSecret,
    onMessage: (msg) => handleVoice(bot, msg),
  });

  const identity = await bot.getIdentity().catch(() => ({ openId: '', name: '' }));
  console.log(`已连接：${identity.name || '(未知 bot)'}`);

  console.log('正在加载 ASR 模型（首次约 1 分钟）…');
  asr
    .warmUp()
    .then(() => console.log('ASR 就绪'))
    .catch((err) => console.error('ASR 预热失败：', err));

  console.log('等待语音消息…');

  process.on('SIGINT', () => {
    asr.shutdown();
    process.exit(0);
  });
}

void main();
