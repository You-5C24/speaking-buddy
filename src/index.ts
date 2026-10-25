/**
 * 入口：WS 长连接收语音 → ASR → LLM → TTS → 发回去。
 *
 * MVP 不做状态机持久化。会话存在内存里，进程重启就丢，重发一句即可。
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { asr } from './asr.js';
import { envCredentials, startBot, type IncomingVoice } from './lark.js';
import {
  ensureSession,
  runTurn,
  sessionDir,
  speakTurn,
  type Session,
} from './pipeline.js';
import { buildReview } from './review.js';

/** 单用户单聊：一个 chat 对应一个进行中的会话 */
const sessions = new Map<string, Session>();

function isEndCommand(text: string): boolean {
  return /^\s*\/(end|stop|结束)\s*$/i.test(text);
}

async function handleVoice(bot: ReturnType<typeof startBot>, msg: IncomingVoice) {
  const { chatId } = msg;

  // 文字命令：结束 / 开始
  if (msg.msgType === 'text') {
    if (isEndCommand(msg.text)) {
      const session = sessions.get(chatId);
      if (!session) {
        await bot.sendText(chatId, '现在没有进行中的练习。直接发一条语音就能开始。');
        return;
      }
      const card = buildReview(session);
      await bot.sendText(chatId, card);
      sessions.delete(chatId);
      return;
    }

    await bot.sendText(
      chatId,
      '直接发语音就行，我们练口语。发 /end 结束这次练习。'
    );
    return;
  }

  if (msg.msgType !== 'audio' || !msg.fileKey) {
    await bot.sendText(chatId, '我们先用语音练 —— 按住说话，随便说一句就行。');
    return;
  }

  let session = sessions.get(chatId);
  const isNew = !session;
  if (!session) {
    session = await ensureSession(chatId);
    sessions.set(chatId, session);
  }

  const turnIndex = session.turns.length + 1;
  const turnDir = join(session.dir, 'turns', String(turnIndex).padStart(3, '0'));

  try {
    // ① 下载原始 opus（保留，复盘可回放）
    await mkdir(turnDir, { recursive: true });
    const opusPath = join(turnDir, 'user.opus');
    const t0 = Date.now();
    await bot.downloadResource(msg.messageId, msg.fileKey, opusPath);

    // ② ASR → 指标 → LLM
    const result = await runTurn({
      session,
      userOpusPath: opusPath,
      userText: msg.text,
    });

    // ③ TTS
    const audio = await speakTurn(session, result.say);

    // ④ 发送
    try {
      await bot.sendOpus(chatId, audio.path, audio.durationMs);
    } finally {
      await rm(audio.dir, { recursive: true, force: true }).catch(() => {});
    }

    const total = Date.now() - t0;
    console.log(
      `[turn ${turnIndex}] ${total}ms  asr=${result.trace.asrMs}ms llm=${result.trace.llmMs}ms` +
        (result.degraded ? '  ⚠️ degraded' : '')
    );

    // 开场时把 bot 的第一句也说一遍（用户已经听到 "Hi! What can I get for you today?"）
    if (isNew) {
      console.log(`[session] 开始 ${session.id}`);
    }
  } catch (err) {
    console.error('[handleVoice]', err);
    const message = err instanceof Error ? err.message : String(err);
    await bot
      .sendText(chatId, `我这边出了点问题：${message.slice(0, 120)}。再说一次试试？`)
      .catch(() => {});
  }
}

async function main() {
  const { appId, appSecret } = envCredentials();
  const bot = startBot({
    appId,
    appSecret,
    onMessage: (msg) => handleVoice(bot, msg),
  });

  const identity = await bot.getIdentity().catch(() => ({ openId: '', name: '' }));
  console.log(`已连接：${identity.name || '(未知 bot)'}`);

  // 预热 ASR：冷启动 77 秒，挪到用户发第一条语音之前
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
