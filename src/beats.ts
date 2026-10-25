/**
 * 按正式轮号取出这一轮的 beat。
 * 对应的块已经说过，就不再注入原指令，避免把答过的问题再问一遍。
 */

import { matchesBlock, type MatchableBlock } from './blocks.js';

const ALREADY =
  'They already covered this. Do not ask that question again. Acknowledge what they just said and move one step forward.';

/** 只换一个词。顺序就是优先级：杯型优先于冷热，冷热优先于饮品名。 */
const SWAPS: { re: RegExp; from: string; to: string }[] = [
  { re: /\bmedium\b/i, from: 'medium', to: 'large' },
  { re: /\blarge\b/i, from: 'large', to: 'medium' },
  { re: /\biced\b/i, from: 'iced', to: 'hot' },
  { re: /\bhot\b/i, from: 'hot', to: 'iced' },
  { re: /\boat\b/i, from: 'oat', to: 'soy' },
  { re: /\bsoy\b/i, from: 'soy', to: 'oat' },
  { re: /\bamericano\b/i, from: 'americano', to: 'latte' },
  { re: /\blatte\b/i, from: 'latte', to: 'americano' },
  { re: /\bmocha\b/i, from: 'mocha', to: 'latte' },
  { re: /\bespresso\b/i, from: 'espresso', to: 'americano' },
  { re: /\bcappuccino\b/i, from: 'cappuccino', to: 'latte' },
  { re: /\bcoffee\b/i, from: 'coffee', to: 'latte' },
];

/**
 * 听错不能交给模型现编。不思考的模型看到 “to go” 会直接往下问，
 * 不会回头改上一句里的 medium。这里从用户已经说过的话里挑一个词，写死换法。
 * 从最近一轮往前找，这一轮只是 “to go” 时仍能用到上一句的点单。
 */
export function specifyMishear(directive: string, said: string[]): string {
  if (!/\bmishear\b/i.test(directive)) return directive;
  let hit: { from: string; to: string } | undefined;
  for (const text of [...said].reverse()) {
    hit = SWAPS.find((swap) => swap.re.test(text));
    if (hit) break;
  }
  if (!hit) return directive;
  return (
    `${directive}\n` +
    `Change only the word "${hit.from}" to "${hit.to}". ` +
    'Keep every other word, including to-go if they just said it. ' +
    'One short sentence. Do not add a temperature, a price, or a question. Do not apologize.'
  );
}

export function activeBeatDirective(
  beat: { directive: string; forBlock?: number | undefined } | undefined,
  blocks: MatchableBlock[],
  said: string[]
): string | undefined {
  if (!beat) return undefined;
  const block = beat.forBlock == null ? undefined : blocks.find((b) => b.n === beat.forBlock);
  if (block && said.some((text) => matchesBlock(block, text))) return ALREADY;
  return specifyMishear(beat.directive, said);
}
