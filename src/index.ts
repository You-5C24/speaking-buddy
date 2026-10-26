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
  /** 校验没过但仍然可用的场景。恢复存量 session 时要区分「有配置错」和「文件没了」 */
  problems: Record<string, string[]>;
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
    problems,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 把这一轮的回复送到用户手上。**任何一步失败都不能让回复无声消失。**
 *
 * 为什么不能只是「失败了就 throw」（#1）：这一轮此时已经 `persistTurn` 落盘、
 * 也已经 push 进 `session.turns`。用户没听到，但下一轮的对话历史里已经有这条
 * assistant 发言了 —— 用户会以为自己漏听了一句，而且这一轮的分析还会进复盘卡片。
 *
 * 三级兜底，从「最好的」到「至少能看懂」：
 * 1. 语音正常发（绝大多数情况）
 * 2. 语音重试 3 次，间隔递增（飞书 5xx / 上传抖动）
 * 3. 还是不行就发文字（04 §七 明确允许：故障兜底时发文字）
 *
 * 只有三级全失败才抛错，交给调用方提示用户。
 */
async function sendVoice(bot: ReturnType<typeof startBot>, msg: IncomingVoice, session: Session, say: string) {
  const target = targetOf(msg);

  const rememberSent = async (sent: SentMessage) => {
    const learned = (!session.threadId && sent.threadId) || (!session.rootId && sent.rootId);
    adopt(session, sent);
    if (learned) await writeMeta(session);
  };

  // ① TTS。失败也不是终点 —— 直接跳到文字兜底，语音合成挂了但话还是要说。
  let audio: Awaited<ReturnType<typeof speakTurn>> | null = null;
  try {
    audio = await speakTurn(session, say);
  } catch (err) {
    console.error('[tts]', err instanceof Error ? err.message : err);
  }

  if (audio) {
    try {
      // ② 语音发送，最多 3 次
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await rememberSent(await bot.sendOpus(target, audio.path, audio.durationMs));
          return;
        } catch (err) {
          const last = attempt === 3;
          console.error(
            `[sendOpus] 第 ${attempt} 次失败${last ? '，改发文字' : '，重试'}`,
            err instanceof Error ? err.message : err
          );
          if (!last) await sleep(attempt * 400);
        }
      }
    } finally {
      await rm(audio.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ③ 文字兜底。这一条也失败才算真失败，让调用方提示用户。
  await rememberSent(await bot.sendText(target, say));
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
  // 校验没过的场景也照常恢复：配置改错一个字不该让用户正在进行的练习凭空消失（#4）。
  // 只有文件真的不在了才放弃，且放弃时要通知用户。
  const { open: restored, orphaned } = await restoreOpenSessions(SESSIONS_ROOT, (id) => {
    const scenario = cat.byId.get(id);
    const problem = cat.problems[id];
    const listTitle = cat.index.find((e) => e.id === id)?.title ?? scenario?.title ?? id;
    if (scenario) {
      return problem
        ? { kind: 'degraded', scenario, listTitle, problem: problem.join('；') }
        : { kind: 'ok', scenario, listTitle };
    }
    return { kind: 'missing', scenarioId: id };
  });
  for (const session of restored) rememberRestored(session);
  if (restored.length) console.log(`恢复 ${restored.length} 场未结束的练习`);

  const bot = startBot({
    appId,
    appSecret,
    onMessage: (msg) => handleVoice(bot, msg),
  });

  // 场景文件没了的那些场次，主动告诉用户一声。
  // 不通知的话用户会对着一个永无回应的对话框继续说，而那是这一条要修的东西（#4）。
  for (const orphan of orphaned) {
    const text =
      `这场练习（${orphan.scenarioTitle || orphan.scenarioId}）的场景配置不在了，接不下去。` +
      '开个新话题重新开始吧。';
    const sent = orphan.anchorMessageId
      ? await bot
          .sendText(
            {
              chatId: orphan.chatId,
              anchorMessageId: orphan.anchorMessageId,
              inThread: !!orphan.threadId,
            },
            text
          )
          .catch(() => null)
      : null;
    if (!sent) await bot.postText(orphan.chatId, text).catch((err) => console.error('[orphan]', err));
  }
  if (orphaned.length) console.log(`已通知 ${orphaned.length} 场无法恢复的练习`);

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
