/**
 * 话题 id 三段回落。纯函数，不碰飞书 SDK。
 *
 * 单聊没有话题，键退化成 chatId，一场对话一场练习。
 * 群里优先 thread_id，其次 root_id，话题根消息两者都空时用 messageId，
 * 不能退回 chatId——否则同一群的两个新话题会写进同一场练习。
 */

export type TopicRef = {
  chatId: string;
  messageId: string;
  chatType: string;
  threadId?: string | null;
  rootId?: string | null;
};

function present(id: string | null | undefined): string | undefined {
  const t = id?.trim();
  return t ? t : undefined;
}

export function sessionKey(chatId: string, topicId: string): string {
  return `${chatId}:${topicId}`;
}

/** 这条消息现在该挂在哪个键上。后来若 reply 带回 thread_id，再补登记一次 */
export function primaryKey(m: TopicRef): string {
  if (m.chatType === 'p2p') return sessionKey(m.chatId, m.chatId);
  const topic = present(m.threadId) || present(m.rootId) || m.messageId;
  return sessionKey(m.chatId, topic);
}

/**
 * 查找顺序：当前主键，再加上这条消息带的其它 id。
 * 根消息先登记在 messageId 下，下一条带着 thread_id / root_id 时仍能找到它。
 */
export function lookupKeys(m: TopicRef): string[] {
  if (m.chatType === 'p2p') return [sessionKey(m.chatId, m.chatId)];
  const ids = [present(m.threadId), present(m.rootId), m.messageId];
  const keys: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const key = sessionKey(m.chatId, id);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * 单聊一定 false。群里一定 true。
 * 话题根消息经常还没有 thread_id，若因此传 false，回复会新开一个话题。
 */
export function replyInThread(chatType: string): boolean {
  return chatType !== 'p2p';
}

/** 话题里所有回复挂在根消息上；根消息自己还没有 root_id，就挂在自己身上 */
export function anchorId(m: TopicRef): string {
  return present(m.rootId) || m.messageId;
}
