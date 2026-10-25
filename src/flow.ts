/**
 * 单聊里一场练习走到哪一步。纯函数，给 index.ts 用，也给自检用。
 * 字段含义见 docs/06 §8。
 * 种子只在还没有这场练习时生效：去掉标点和空白后至少 4 个字。
 * 更短的（hi、练口语）继续发菜单。菜单发出去之后再打长句，仍然重发菜单。
 */

export type FlowSession = {
  ended: boolean;
  hasScenario: boolean;
  warmupDone: boolean;
};

export type FlowAction =
  | 'note-ended'
  | 'restart'
  | 'no-practice'
  | 'review'
  | 'start'
  | 'start-seed'
  | 'menu'
  | 'choose'
  | 'repeat-menu'
  | 'need-voice'
  | 'live-text'
  | 'audio-ended'
  | 'audio-menu'
  | 'audio-need-choice'
  | 'warmup'
  | 'turn';

/** 一段话，不是短问候。不做模糊匹配，只数字母和数字。 */
export function isSeedText(text: string): boolean {
  const chars = [...text].filter((c) => /\p{L}|\p{N}/u.test(c));
  return chars.length >= 4;
}

export function nextAction(
  session: FlowSession | null,
  input: { kind: 'text' | 'audio'; alias: boolean; endCommand: boolean; seed?: boolean }
): FlowAction {
  if (input.kind === 'audio') {
    if (!session) return 'audio-menu';
    if (session.ended) return 'audio-ended';
    if (!session.hasScenario) return 'audio-need-choice';
    if (!session.warmupDone) return 'warmup';
    return 'turn';
  }

  if (session?.ended) return input.alias && !input.endCommand ? 'restart' : 'note-ended';
  if (input.endCommand) return session?.hasScenario ? 'review' : 'no-practice';
  if (!session) {
    if (input.alias) return 'start';
    if (input.seed) return 'start-seed';
    return 'menu';
  }
  if (!session.hasScenario) return input.alias ? 'choose' : 'repeat-menu';
  if (!session.warmupDone) return 'need-voice';
  return 'live-text';
}
