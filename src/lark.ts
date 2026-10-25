/**
 * 飞书接入：WS 长连接收事件 + REST 收发消息。
 *
 * 三条硬规则（写在这里，别在别处重复）：
 * 1. 先 ack 再干活 —— handler 里只做去重 + 入队 + 加 reaction 然后立刻返回。
 *    飞书对超时事件会重推，重推会导致重复回复。
 * 2. 按 event_id 去重，落 seen-events.json，重启不丢。
 * 3. 按 sessionKey 串行。同一个群里两个话题互不卡住。
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primaryKey } from './topic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const SEEN_PATH = join(DATA_DIR, 'seen-events.json');
const SEEN_LIMIT = 500;

export type IncomingVoice = {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: string;
  msgType: 'audio' | 'text' | 'other';
  fileKey?: string;
  durationMs?: number;
  senderOpenId: string;
  /** text 消息的正文；audio 为空。群里的 @ 占位已经去掉 */
  text: string;
  threadId?: string;
  rootId?: string;
};

/** 回复挂在某条消息上。群里 inThread 必须为 true，否则会新开话题 */
export type ReplyTarget = {
  chatId: string;
  anchorMessageId: string;
  inThread: boolean;
};

export type SentMessage = {
  messageId?: string;
  threadId?: string;
  rootId?: string;
};

export type BotOptions = {
  appId: string;
  appSecret: string;
  onMessage: (msg: IncomingVoice) => Promise<void>;
};

export type Bot = {
  client: Lark.Client;
  sendText(target: ReplyTarget, text: string): Promise<SentMessage>;
  sendOpus(target: ReplyTarget, opusPath: string, durationMs: number): Promise<SentMessage>;
  /** 没有可回复的消息时用，例如被拉进群。话题群里这会变成一个新话题 */
  postText(chatId: string, text: string): Promise<string | undefined>;
  react(messageId: string, emoji: string): Promise<void>;
  unreact(messageId: string, emoji: string): Promise<void>;
  downloadResource(messageId: string, fileKey: string, savePath: string): Promise<string>;
  getIdentity(): Promise<{ openId: string; name: string }>;
};

// ────────────────────────────────────────────────────────────
// 去重
// ────────────────────────────────────────────────────────────

class SeenEvents {
  private set = new Set<string>();
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(SEEN_PATH, 'utf8');
      const arr = JSON.parse(raw) as string[];
      this.set = new Set(arr);
    } catch {
      this.set = new Set();
    }
  }

  async has(id: string): Promise<boolean> {
    await this.load();
    return this.set.has(id);
  }

  async add(id: string): Promise<void> {
    await this.load();
    this.set.add(id);
    // 滚动保留最近 N 条
    if (this.set.size > SEEN_LIMIT) {
      const keep = Array.from(this.set).slice(-SEEN_LIMIT);
      this.set = new Set(keep);
    }
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SEEN_PATH, JSON.stringify(Array.from(this.set)), 'utf8');
  }
}

export const seen = new SeenEvents();

// ────────────────────────────────────────────────────────────
// 按 sessionKey 串行
// ────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<void>>();

export function enqueue(key: string, job: () => Promise<void>): void {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(job);
  const settled = run.then(
    () => {},
    (err) => console.error(`[queue ${key}]`, err)
  );
  chains.set(key, settled);
  void settled.finally(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
}

// ────────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────────

export function startBot(opts: BotOptions): Bot {
  const { appId, appSecret, onMessage } = opts;
  const client = new Lark.Client({ appId, appSecret });

  const bot: Bot = {
    client,

    async sendText(target, text) {
      return replyMessage(client, target, 'text', JSON.stringify({ text }));
    },

    /**
     * 发语音：先上传拿 file_key，再 reply。
     * duration 必须按毫秒整数填，填错进度条错位甚至发送失败。
     */
    async sendOpus(target, opusPath, durationMs) {
      const uploaded = await client.im.v1.file.create({
        data: {
          file_type: 'opus',
          file_name: 'reply.opus',
          duration: durationMs,
          file: createReadStream(opusPath),
        },
      });
      const fileKey = uploaded?.file_key;
      if (!fileKey) throw new Error('上传语音失败：没有 file_key');

      return replyMessage(
        client,
        target,
        'audio',
        JSON.stringify({ file_key: fileKey, duration: durationMs })
      );
    },

    async postText(chatId, text) {
      const res = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      return res.data?.message_id;
    },

    /** 「正在思考」的 ack。飞书 bot 没有 typing indicator，用 reaction 代替。 */
    async react(messageId, emoji) {
      await client.im.v1.messageReaction
        .create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emoji } },
        })
        .catch((err) => console.error('[react]', err));
    },

    async unreact(messageId, emoji) {
      await client.im.v1.messageReaction
        .delete({
          path: { message_id: messageId, reaction_id: emoji },
        })
        .catch(() => {
          // reaction_id 需要先查出来；MVP 阶段失败就让它留着，不影响功能
        });
    },

    /** 语音必须传 type=file，传 image 拿不到 */
    async downloadResource(messageId, fileKey, savePath) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });
      await mkdir(dirname(savePath), { recursive: true });
      await res.writeFile(savePath);
      return savePath;
    },

    async getIdentity() {
      const res = await client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });
      const botInfo = (res as { bot?: { open_id?: string; app_name?: string } }).bot;
      return {
        openId: botInfo?.open_id ?? '',
        name: botInfo?.app_name ?? '',
      };
    },
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.chat.member.bot.added_v1': async (data) => {
      const chatId = data.chat_id;
      if (!chatId) return;
      await bot
        .postText(chatId, '建一个话题就是一次练习。在话题里说一句开始。')
        .catch((err) => console.error('[bot-added]', err));
    },

    'im.message.receive_v1': async (data) => {
      const m = data.message;
      const eventId = (data as { event_id?: string }).event_id ?? '';
      const msgType = m.message_type;

      // 自己发出去的消息会随 group_msg 再回来，不处理，否则无限回复
      if (data.sender.sender_type !== 'user') return;

      const parsed = parseContent(msgType, m.content, m.mentions);
      const kind: IncomingVoice['msgType'] =
        msgType === 'audio' ? 'audio' : msgType === 'text' || msgType === 'post' ? 'text' : 'other';

      if (m.chat_type !== 'p2p') {
        console.log('[group]', {
          message_id: m.message_id,
          chat_id: m.chat_id,
          thread_id: m.thread_id,
          root_id: m.root_id,
          message_type: m.message_type,
          text: parsed.text.slice(0, 40),
        });
      }

      const threadId = presentId(m.thread_id);
      const rootId = presentId(m.root_id);
      const msg: IncomingVoice = {
        eventId,
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        msgType: kind,
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        text: parsed.text,
        ...(parsed.fileKey ? { fileKey: parsed.fileKey } : {}),
        ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
        ...(threadId ? { threadId } : {}),
        ...(rootId ? { rootId } : {}),
      };

      // ① 去重（必须在任何 await 之前完成判断）
      if (eventId && (await seen.has(eventId))) return;

      // ② 立即 ack：加 reaction，然后把活扔进队列
      void bot.react(m.message_id, 'OnIt');

      // ③ 按话题串行。两个话题的键不同，可以同时跑
      enqueue(primaryKey(msg), async () => {
        if (eventId) await seen.add(eventId);
        await onMessage(msg);
      });
    },
  });

  const wsClient = new Lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}

// ────────────────────────────────────────────────────────────
// content 解析
// ────────────────────────────────────────────────────────────

function presentId(id: string | undefined): string | undefined {
  const t = id?.trim();
  return t ? t : undefined;
}

async function replyMessage(
  client: Lark.Client,
  target: ReplyTarget,
  msgType: string,
  content: string
): Promise<SentMessage> {
  const res = await client.im.v1.message.reply({
    path: { message_id: target.anchorMessageId },
    data: {
      content,
      msg_type: msgType,
      reply_in_thread: target.inThread,
    },
  });
  const data = res.data;
  return {
    ...(data?.message_id ? { messageId: data.message_id } : {}),
    ...(data?.thread_id ? { threadId: data.thread_id } : {}),
    ...(data?.root_id ? { rootId: data.root_id } : {}),
  };
}

function parseContent(
  msgType: string,
  content: string,
  mentions?: { key: string }[]
): { text: string; fileKey?: string; durationMs?: number } {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;

    if (msgType === 'audio') {
      const fileKey = typeof obj.file_key === 'string' ? obj.file_key : undefined;
      const duration = typeof obj.duration === 'number' ? obj.duration : undefined;
      return {
        text: '',
        ...(fileKey ? { fileKey } : {}),
        ...(duration !== undefined ? { durationMs: duration } : {}),
      };
    }

    if (msgType === 'text') {
      const t = typeof obj.text === 'string' ? obj.text : '';
      return { text: stripMentions(t, mentions) };
    }

    if (msgType === 'post') {
      return { text: plainTextFromPost(obj) };
    }

    return { text: '' };
  } catch {
    return { text: '' };
  }
}

/** 话题里手打的一句话，飞书常常用 post 而不是 text。只取文字节点，@ 不算正文。 */
export function plainTextFromPost(raw: unknown): string {
  const chunks: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.tag === 'string') {
      if ((rec.tag === 'text' || rec.tag === 'a' || rec.tag === 'md') && typeof rec.text === 'string') {
        chunks.push(rec.text);
      }
      return;
    }
    if (rec.content) {
      visit(rec.content);
      return;
    }
    for (const [key, value] of Object.entries(rec)) {
      if (key === 'title') continue;
      visit(value);
    }
  };
  visit(raw);
  return chunks.join('').replace(/\s+/g, ' ').trim();
}

function stripMentions(text: string, mentions?: { key: string }[]): string {
  let out = text;
  for (const mention of mentions ?? []) {
    if (mention.key) out = out.split(mention.key).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 发一条测试 opus，用来验证飞书客户端能不能正常播放 + 显示时长 */
export function envCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  return { appId, appSecret };
}

export function dataDirExists(path: string): boolean {
  return existsSync(path);
}
