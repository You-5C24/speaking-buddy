/**
 * 飞书接入：WS 长连接收事件 + REST 收发消息。
 *
 * 三条硬规则（写在这里，别在别处重复）：
 * 1. 先 ack 再干活 —— handler 里只做去重 + 入队 + 加 reaction 然后立刻返回。
 *    飞书对超时事件会重推，重推会导致重复回复。
 * 2. 按 event_id 去重，落 seen-events.json，重启不丢。
 * 3. 按 chat_id 串行，同一个会话同一时刻只能有一个 turn 在跑。
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** text 消息的正文；audio 为空 */
  text: string;
};

export type BotOptions = {
  appId: string;
  appSecret: string;
  onMessage: (msg: IncomingVoice) => Promise<void>;
};

export type Bot = {
  client: Lark.Client;
  sendText(chatId: string, text: string): Promise<string | undefined>;
  sendOpus(chatId: string, opusPath: string, durationMs: number): Promise<string | undefined>;
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
// 按 chat_id 串行
// ────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<void>>();

export function enqueue(chatId: string, job: () => Promise<void>): void {
  const prev = chains.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(job)
    .catch((err) => console.error(`[queue ${chatId}]`, err));
  chains.set(chatId, next);
  void next.finally(() => {
    if (chains.get(chatId) === next) chains.delete(chatId);
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

    async sendText(chatId, text) {
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

    /**
     * 发语音：先上传拿 file_key，再 message.create。
     * duration 必须按毫秒整数填，填错进度条错位甚至发送失败。
     */
    async sendOpus(chatId, opusPath, durationMs) {
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

      const res = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'audio',
          content: JSON.stringify({ file_key: fileKey, duration: durationMs }),
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
    'im.message.receive_v1': async (data) => {
      const m = data.message;
      const eventId = (data as { event_id?: string }).event_id ?? '';
      const msgType = m.message_type;

      // 只处理单聊 + 语音/文字
      if (m.chat_type !== 'p2p') return;

      const parsed = parseContent(msgType, m.content);

      const msg: IncomingVoice = {
        eventId,
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        msgType: msgType === 'audio' || msgType === 'text' ? msgType : 'other',
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        text: parsed.text,
        ...(parsed.fileKey ? { fileKey: parsed.fileKey } : {}),
        ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
      };

      // ① 去重（必须在任何 await 之前完成判断）
      if (eventId && (await seen.has(eventId))) return;

      // ② 立即 ack：加 reaction，然后把活扔进队列
      void bot.react(m.message_id, 'OnIt');

      // ③ 入队，串行处理
      enqueue(m.chat_id, async () => {
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

function parseContent(
  msgType: string,
  content: string
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
      return { text: t };
    }

    return { text: '' };
  } catch {
    return { text: '' };
  }
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
