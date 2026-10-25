/**
 * 热身那句「重铸 + 开场」。模板，不调 LLM（§3）。
 * 抽不出来就只说开场，这一步不允许失败、也不允许变慢。
 */

const FUNCTION = new Set([
  'a', 'an', 'the', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'me', 'my', 'your',
  'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or', 'but', 'please', 'thanks', 'thank',
  'hi', 'hello', 'hey', 'ok', 'okay', 'yes', 'no', 'yeah', 'yep', 'nope', 'sorry',
  'could', 'can', 'would', 'will', 'should', 'get', 'have', 'like', 'want',
  'this', 'that', 'just', 'very', 'really', 'um', 'uh', 'er', 'ah', 'hmm', 'oh', 'well',
]);

function contentTokens(words: { w: string; p: number }[]): { w: string; p: number; i: number }[] {
  const out: { w: string; p: number; i: number }[] = [];
  words.forEach((word, i) => {
    const w = word.w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
    if (w.length < 2) return;
    if (!/^[\x00-\x7F]+$/.test(w)) return;
    if (FUNCTION.has(w.toLowerCase())) return;
    out.push({ w, p: word.p, i });
  });
  return out;
}

/** 置信度最高的 1–2 个实词，按出现顺序拼回去 */
export function pickupNoun(words: { w: string; p: number }[], text: string): string {
  const fromWords = contentTokens(words);
  const tokens = fromWords.length
    ? fromWords
    : contentTokens(text.split(/\s+/).filter(Boolean).map((w) => ({ w, p: 1 })));
  const top = [...tokens].sort((a, b) => b.p - a.p || a.i - b.i).slice(0, 2);
  top.sort((a, b) => a.i - b.i);
  return top.map((t) => t.w).join(' ');
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

export function buildWarmupLine(params: {
  words: { w: string; p: number }[];
  text: string;
  opening: string;
}): string {
  const noun = pickupNoun(params.words, params.text);
  if (!noun) return `Okay — ${params.opening}`;
  return `Nice, ${article(noun)} ${noun}. Okay — ${params.opening}`;
}
