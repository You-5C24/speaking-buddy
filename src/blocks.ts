/**
 * 块的匹配模式派生 + 使用统计。纯函数，不依赖飞书、不调模型。
 *
 * 为什么有这个文件（见 docs/06 §3、§4.5）：
 * - whisper 的 word 不带标点（`asr.py:64` 是 `" ".join(w.word.strip())`），
 *   所以手写的 `"sorry, i wanted"` 永远命中不了
 * - 让 LLM 生成 match 更糟：它写出来"看着对、永远不中"，而且失败是静默的
 *   —— 卡片上显示 `1 ✗`，你会以为用户没说，其实是匹配没中
 *
 * 结论：match 一律从 `frame` 派生（拆槽位），不手写、不让模型写。
 * `block.match` 保留成逃生口，显式给了就用显式的。
 */

export type MatchableBlock = {
  n: number;
  /** "Could I get a ___ ?" —— 槽位用两个以上下划线 */
  frame: string;
  /** 同义说法，同样带槽位，如 "Could I have a ___ ?" */
  alternatives?: string[] | undefined;
  /** 逃生口：显式给出时优先使用（仍然会被 norm 归一化） */
  match?: string[] | undefined;
};

export type BlockUsage = 'used' | 'unused' | 'not_reached';

/**
 * 归一化：小写 + NFKC + 标点转空格 + 保留撇号和任意语言的字母数字。
 *
 * 和别的实现不一样的地方，都是有理由的：
 * - **保留任何语言的字母**（`\p{L}`）：否则 `norm('点单')` 会变成空串，
 *   §2.1 的中文别名会静默失效
 * - **NFKC + 弯引号→直引号**：`I’d like` 和 `I'd like` 必须是同一个东西
 * - **去掉所有标点**：转写里本来就没有
 */
export const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(/[‘’ʼ`´]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokens = (s: string): string[] => (s ? s.split(' ') : []);

/** 槽位的写法：连续两个以上下划线 */
const SLOT = /_{2,}/;

/** 前导话语标记：用户不一定说，说了也不带信息 */
const LEADING_MARKERS = new Set([
  'sorry',
  'well',
  'oh',
  'ah',
  'um',
  'uh',
  'hmm',
  'hey',
  'okay',
  'ok',
  'actually',
]);

/** 尾部客套语：用户可能省略，也可能换成别的 */
const TRAILING_MARKERS = new Set(['please', 'thanks']);

/** 缩写 → 展开形式。whisper 常把 I'd 输出成 I would，两种都要能中 */
const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bi'd\b/g, 'i would'],
  [/\bi'll\b/g, 'i will'],
  [/\bi'm\b/g, 'i am'],
  [/\bi've\b/g, 'i have'],
  [/\bcan't\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bdidn't\b/g, 'did not'],
  [/\bisn't\b/g, 'is not'],
  [/\baren't\b/g, 'are not'],
  [/\bwouldn't\b/g, 'would not'],
  [/\bcouldn't\b/g, 'could not'],
];

/**
 * 把一帧拆成"应该在转写里出现的片段"。
 *
 * - 没有槽位 → 整句是一段
 * - 有槽位 → 槽位两侧各一段；**只保留 ≥2 词的段**
 *   （单令牌的段（如双槽位里的 `with`）会把什么都匹配上）
 * - 全都太短 → 退而保留最长的那段，但至少要 1 个词
 */
function slotSegments(frame: string): string[] {
  const raw = frame.split(SLOT).map(norm).filter(Boolean);
  if (raw.length <= 1) return raw;

  const strong = raw.filter((s) => tokens(s).length >= 2);
  if (strong.length) return strong;

  const longest = raw.reduce((a, b) => (tokens(b).length > tokens(a).length ? b : a));
  return [longest];
}

/** 一段的等价写法：原文 / 去掉前导话语标记 / 去掉尾部客套 / 缩写展开 */
function variants(seg: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = tokens(s);
    // 少于 2 个词的片段太泛，宁可漏匹配也不要误判（§3「允许误判，但不能乱判」）
    if (t.length >= 2) out.add(t.join(' '));
  };

  const t = tokens(seg);
  add(seg);

  let head = [...t];
  while (head.length && LEADING_MARKERS.has(head[0]!)) head = head.slice(1);
  add(head.join(' '));

  let tail = [...t];
  while (tail.length && TRAILING_MARKERS.has(tail[tail.length - 1]!)) tail = tail.slice(0, -1);
  add(tail.join(' '));

  const both = (() => {
    let x = [...t];
    while (x.length && LEADING_MARKERS.has(x[0]!)) x = x.slice(1);
    while (x.length && TRAILING_MARKERS.has(x[x.length - 1]!)) x = x.slice(0, -1);
    return x.join(' ');
  })();
  add(both);

  for (const [re, expanded] of CONTRACTIONS) {
    for (const s of [...out]) {
      const e = s.replace(re, expanded);
      if (e !== s) add(e);
    }
  }

  return [...out];
}

/**
 * 从 frame（+ 同义说法）派生要匹配的片段。
 *
 * 返回空数组表示"这个块派生不出任何可匹配的东西"——调用方**不能**拿空串去
 * `includes`（那会全部命中），而应该把它当成配置错误：`validateBlocks()` 会报出来。
 * 静默返回"永远不命中"是最坏的结果——卡片上显示 `1 ✗`，你会以为用户没说。
 */
export function deriveMatch(frame: string, alternatives: string[] = []): string[] {
  const out = new Set<string>();
  for (const f of [frame, ...alternatives]) {
    if (!f) continue;
    for (const seg of slotSegments(f)) {
      for (const v of variants(seg)) out.add(v);
    }
  }
  return [...out];
}

/**
 * 加载配置时调用：派生不出匹配片段的块必须被拒绝，不能静默通过。
 *
 * 典型触发：frame 几乎全是套话（`___ , please.`）、或同义说法里只有单令牌片段。
 * 修法是给 frame 换一个信息量更大的部分，或补 `alternatives`。
 */
export function validateBlocks(blocks: MatchableBlock[]): { n: number; problem: string }[] {
  const problems: { n: number; problem: string }[] = [];
  const seen = new Set<number>();
  for (const b of blocks) {
    if (seen.has(b.n)) problems.push({ n: b.n, problem: '块号重复' });
    seen.add(b.n);

    const explicit = b.match?.map(norm).filter(Boolean) ?? [];
    if (explicit.length) continue;

    if (!deriveMatch(b.frame, b.alternatives ?? []).length) {
      problems.push({
        n: b.n,
        problem: `派生不出可匹配片段（frame="${b.frame}"）——加一个字多的 frame，或补 alternatives`,
      });
    }
  }
  return problems;
}

/**
 * 块的"骨架"：把槽位换成 `_`，只看句式。
 *
 * ⚠️ 不能先 `norm(frame)` 再替换 —— `norm` 会连 `___` 一起抹掉（它只留字母数字），
 * 骨架就成了普通句子，跨话题比对时永远看不出"同一公式换了名词"。必须**先拆再归一**。
 */
export function frameSkeleton(frame: string): string {
  const parts = frame.split(SLOT).map(norm);
  let out = parts[0] ?? '';
  for (let i = 1; i < parts.length; i++) out += ` _ ${parts[i]}`;
  return out.replace(/\s+/g, ' ').trim();
}

/** 骨架的词（含功能词，含 `_`）。按多重集比较 */
function skeletonTokens(frame: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of frameSkeleton(frame).split(' ').filter(Boolean)) {
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

/** 太短的骨架比什么都像，跳过（`Could I ___ please?` 这种） */
const SKELETON_MIN_TOKENS = 5;

/**
 * 找出"换个话题照样能用"的块。**是提醒，不是判定。**
 *
 * 比较的是多重集重合度：`Could I have a ___ seat` 和 `Could I have a ___ room`
 * 只差一个名词，重合 6/7 —— 这类"同一条公式换名词"正是 §3 第 2 条要挡的句型库。
 * 阈值 0.6 没在真实数据上标定过，只用来提示人工复核，不要拿它自动删块。
 */
export function findGenericFrames(
  scenarios: { id: string; blocks: { n: number; frame: string }[] }[]
): { a: string; b: string; overlap: number }[] {
  const flat = scenarios.flatMap((s) =>
    s.blocks.map((b) => ({ key: `${s.id}#${b.n}`, tokens: skeletonTokens(b.frame) }))
  );
  const size = (m: Map<string, number>) => [...m.values()].reduce((a, c) => a + c, 0);

  const out: { a: string; b: string; overlap: number }[] = [];
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const A = flat[i]!, B = flat[j]!;
      if (A.key.split('#')[0] === B.key.split('#')[0]) continue; // 同场景内不比较

      const small = size(A.tokens) <= size(B.tokens) ? A.tokens : B.tokens;
      const big = small === A.tokens ? B.tokens : A.tokens;
      const sSize = size(small);
      if (sSize < SKELETON_MIN_TOKENS) continue;

      let hit = 0;
      for (const [t, c] of small) hit += Math.min(c, big.get(t) ?? 0);
      const overlap = hit / sSize;
      if (overlap >= 0.6) out.push({ a: A.key, b: B.key, overlap: Number(overlap.toFixed(2)) });
    }
  }
  return out.sort((x, y) => y.overlap - x.overlap);
}

/** 一个块在给定转写里是否被用到了 */
export function matchesBlock(block: MatchableBlock, text: string): boolean {
  const explicit = block.match?.map(norm).filter(Boolean) ?? [];
  const patterns = explicit.length
    ? explicit
    : deriveMatch(block.frame, block.alternatives ?? []);
  if (!patterns.length) return false;

  const hay = ` ${norm(text)} `;
  return patterns.some((p) => hay.includes(` ${p} `));
}

/**
 * 逐块统计使用情况。
 *
 * **只可能返回 `used` / `unused`。** `not_reached` 由调用方赋值——
 * 那是"会话没走到那一步"，属于流程信息，不是文本信息，这里看不出来（§4）。
 *
 * `texts` 必须**包含热身轮**：用户唯一一次用 1 号块的地方就是热身，
 * 只扫正式轮次的话卡片上 1 号永远是 ✗（§3、§11 验收第 1 条）。
 */
export function computeBlockUsage(
  blocks: MatchableBlock[],
  texts: string[]
): Record<string, Exclude<BlockUsage, 'not_reached'>> {
  const corpus = texts.filter(Boolean).join(' \n ');
  const out: Record<string, Exclude<BlockUsage, 'not_reached'>> = {};
  for (const b of blocks) {
    out[String(b.n)] = matchesBlock(b, corpus) ? 'used' : 'unused';
  }
  return out;
}

/**
 * 把「会话还没走到那一步」从 `unused` 里分出来。
 *
 * `forBlock` 指向这个 beat 给哪一块制造开口机会。bot 在用户的第 `atTurn`
 * 轮才说出那个 beat，用户最早要到下一轮才答得上，所以
 * `formalTurns < atTurn + 1` 时记 `not_reached`，卡片上是 `—` 不是 `✗`。
 * 已经用过的块不动——提前说了也算用了。
 */
export function assignNotReached(
  usage: Record<string, Exclude<BlockUsage, 'not_reached'>>,
  beats: { atTurn: number; forBlock?: number | undefined }[],
  formalTurns: number
): Record<string, BlockUsage> {
  const gate = new Map<number, number>();
  for (const beat of beats) {
    if (beat.forBlock == null) continue;
    const prev = gate.get(beat.forBlock);
    if (prev == null || beat.atTurn < prev) gate.set(beat.forBlock, beat.atTurn);
  }

  const out: Record<string, BlockUsage> = {};
  for (const [n, state] of Object.entries(usage)) {
    const at = gate.get(Number(n));
    out[n] = state === 'unused' && at != null && formalTurns < at + 1 ? 'not_reached' : state;
  }
  return out;
}
