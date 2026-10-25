/**
 * 场景配置 v2：加载 + 校验 + 选题路由。纯函数，不碰飞书、不调模型。
 *
 * 运行时从这里加载（`pipeline.ts` 的 `createSession` / `attachScenario`）。
 *
 * 三条硬规则：
 * 1. **块数必须是 3**（§3 的三句卡）
 * 2. **每块必须带槽位**，否则只剩照念
 * 3. **`match` 一律派生，不读配置里的手写值**（§4.5）
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { deriveMatch, norm, validateBlocks, type MatchableBlock } from './blocks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = join(HERE, '..', 'config', 'scenarios');

// ────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────

export const BlockSchema = z.object({
  n: z.number().int().positive(),
  frame: z.string().min(1),
  example: z.string().optional(),
  swaps: z.array(z.string()).optional(),
  alternatives: z.array(z.string()).optional(),
  /** 逃生口。正常情况下留空，由 deriveMatch 生成 */
  match: z.array(z.string()).optional(),
});

export const BeatSchema = z.object({
  /** 正式轮次，热身不占号；生成场景时钳到 [2, 3] */
  atTurn: z.number().int().min(1),
  need: z.string().min(1),
  directive: z.string().min(1),
  /**
   * 这个 beat 给哪一块制造开口机会。
   * 还没轮到时，那一块记 `not_reached` 而不是 `unused`（§4）。
   */
  forBlock: z.number().int().positive().optional(),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  level: z.string().min(1),
  goal: z.string().optional(),
  hiddenGoal: z.string().optional(),
  persona: z.string().min(1),
  opening: z.string().min(1),
  voice: z.string().optional(),
  ttsRate: z.string().optional(),
  blocks: z.array(BlockSchema),
  beats: z.array(BeatSchema),
  cardStyle: z.enum(['blocks', 'rewrite']).optional(),
  source: z.enum(['handwritten', 'generated']).optional(),
});

export const IndexEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  level: z.string().min(1),
  aliases: z.array(z.string()).optional(),
});

export type Block = z.infer<typeof BlockSchema>;
export type Beat = z.infer<typeof BeatSchema>;
export type ScenarioDef = z.infer<typeof ScenarioSchema>;
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

/** 派生出 match 之后的样子。运行时只用这个，不读 `block.match` */
export type ResolvedBlock = Block & { patterns: string[] };
export type ResolvedScenario = Omit<ScenarioDef, 'blocks'> & { blocks: ResolvedBlock[] };

// ────────────────────────────────────────────────────────────
// 校验
// ────────────────────────────────────────────────────────────

/** A2 第一批不该出现的表达。§3 已逐条论证过 */
const BANNED = ['kinda', 'sorta', 'gonna', 'wanna', 'i was wondering'];

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/**
 * 校验一个场景。返回问题列表，空数组 = 通过。
 *
 * 每一条都是**确定性判定**，不依赖模型：这是「生成物能不能用」和
 * 「手写配置有没有写错」共用的同一道闸（§4.5）。
 */
export function validateScenario(s: ScenarioDef): string[] {
  const problems: string[] = [];

  if (s.blocks.length !== 3) {
    problems.push(`块数必须为 3，现在是 ${s.blocks.length}`);
  }

  for (const b of s.blocks) {
    const hasSlot = /_{2,}/.test(b.frame);
    const hasChoice = (b.alternatives?.length ?? 0) > 0 || (b.swaps?.length ?? 0) > 0;

    // 「块 + 槽」是首选，但固定句 + 替换项同样成立（`For here, please.` / `To go, please.`）。
    // 真正要挡的是**既没有槽、也没有替换**的那种：那是一整句照念，检索量最小（§3）。
    if (!hasSlot && !hasChoice) {
      problems.push(`块 ${b.n} 既没有槽位也没有替换项（frame="${b.frame}"）——只剩照念`);
    }

    // 槽位两侧最长的那一段决定长度
    const longest = b.frame
      .split(/_{2,}/)
      .map((x) => words(norm(x)).length)
      .reduce((a, c) => Math.max(a, c), 0);
    if (longest > 8) {
      problems.push(`块 ${b.n} 拆槽后最长片段 ${longest} 词，超过 A2 的 8 词上限`);
    }
  }

  const lowered = norm(
    s.blocks.map((b) => `${b.frame} ${(b.alternatives ?? []).join(' ')}`).join(' ')
  );
  for (const bad of BANNED) {
    if (lowered.includes(bad)) problems.push(`出现 A2 第一批不该有的表达：${bad}`);
  }

  // 派生层面的问题（空 match、块号重复）
  for (const p of validateBlocks(s.blocks as MatchableBlock[])) {
    problems.push(`块 ${p.n}：${p.problem}`);
  }

  if (s.beats.length) {
    const hasFriction = s.beats.some((b) =>
      /mishear|misunderstand|confus|wrong|interrupt|ask again|repeat/i.test(b.directive)
    );
    if (!hasFriction) {
      problems.push('beats 里没有一条带摩擦动作（听错 / 误解 / 打断）——纯角色扮演，用户三句后就没方向');
    }
    for (const b of s.beats) {
      if (b.atTurn > 3) {
        problems.push(`beat atTurn=${b.atTurn} 太靠后——§4 的教训是第 3 轮就可能 /end`);
      }
      if (b.forBlock != null && !s.blocks.some((bl) => bl.n === b.forBlock)) {
        problems.push(`beat atTurn=${b.atTurn} 的 forBlock=${b.forBlock} 不是这个场景的块号`);
      }
    }
  }

  if (!s.goal && !s.hiddenGoal) {
    problems.push('既没有 goal 也没有 hiddenGoal——没有目标的对话 20 分钟内必然塌缩（04 §2）');
  }

  return problems;
}

/** 补上派生出来的 match。这是唯一允许写 `patterns` 的地方 */
export function resolveScenario(s: ScenarioDef): ResolvedScenario {
  return {
    ...s,
    blocks: s.blocks.map((b) => ({
      ...b,
      patterns: b.match?.length ? b.match.map(norm) : deriveMatch(b.frame, b.alternatives ?? []),
    })),
  };
}

// ────────────────────────────────────────────────────────────
// 加载
// ────────────────────────────────────────────────────────────

export async function loadIndex(dir = SCENARIO_DIR): Promise<IndexEntry[]> {
  const raw = await readFile(join(dir, 'index.json'), 'utf8');
  const parsed = z.array(IndexEntrySchema).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`index.json 不合规：${parsed.error.issues[0]?.message ?? '未知'}`);
  }
  return parsed.data;
}

export async function loadScenario(id: string, dir = SCENARIO_DIR): Promise<ScenarioDef> {
  const raw = await readFile(join(dir, `${id}.json`), 'utf8');
  const parsed = ScenarioSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${id}.json 不合规：${issue?.path.join('.')} ${issue?.message}`);
  }
  return parsed.data;
}

/** 加载所有场景并逐条校验。返回场景和问题清单，不抛错 */
export async function loadAll(
  dir = SCENARIO_DIR
): Promise<{ scenarios: ScenarioDef[]; problems: Record<string, string[]> }> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const scenarios: ScenarioDef[] = [];
  const problems: Record<string, string[]> = {};
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    try {
      const s = await loadScenario(id, dir);
      const p = validateScenario(s);
      if (p.length) problems[id] = p;
      scenarios.push(s);
    } catch (err) {
      problems[id] = [err instanceof Error ? err.message : String(err)];
    }
  }
  return { scenarios, problems };
}

// ────────────────────────────────────────────────────────────
// 选题路由（§2.1 第 0 层）
// ────────────────────────────────────────────────────────────

/**
 * 根消息 → 场景 id。命中不了返回 null（调用方发菜单）。
 *
 * **归一化后整句相等**，不做包含、不做模糊。理由（§2.1）：
 * - 包含匹配会让 `我不想点单` 命中 `点单`，用户想要什么都会反着来
 * - 模糊匹配在 `hi` 这种输入上误判率高，且无法向用户解释
 */
export function resolveByAlias(text: string, index: IndexEntry[]): string | null {
  const t = norm(text);
  if (!t) return null;
  for (const entry of index) {
    for (const alias of entry.aliases ?? []) {
      if (norm(alias) === t) return entry.id;
    }
  }
  return null;
}

/** 菜单文本。由 index.json 渲染，不手写（§2 / §4） */
export function renderMenu(index: IndexEntry[]): string {
  const lines = ['这次练什么？', ''];
  index.forEach((entry, i) => {
    lines.push(`${i + 1}  ${entry.title}${' '.repeat(Math.max(2, 34 - entry.title.length - String(i + 1).length))}${entry.level}`);
  });
  lines.push('', '回数字，或者打个场景名。');
  return lines.join('\n');
}

/**
 * 三句卡。开场前一次性文字，对话开始后不再发（§3）。
 * `hiddenGoal` 不进这张卡。
 */
export function renderScenarioCard(
  scenario: ResolvedScenario,
  opts?: { title?: string; seedText?: string | null }
): string {
  const title = opts?.title || scenario.title;
  const lines: string[] = [
    `━━━ ${title} ━━━`,
    '今天用这三句，别的不会说也没关系：',
    '',
  ];

  for (const block of [...scenario.blocks].sort((a, b) => a.n - b.n)) {
    lines.push(`${block.n}  ${block.frame}`);
    if (block.example && norm(block.example) !== norm(block.frame)) {
      lines.push(`   ${block.example}`);
    }
    if (block.swaps?.length) {
      const label = /_{2,}/.test(block.frame) ? '也可以换' : '或者';
      lines.push(`   ${label}：${block.swaps.join(' / ')}`);
    }
    lines.push('');
  }

  lines.push(warmupPrompt(scenario, opts?.seedText));
  return lines.join('\n').replace(/\n+$/, '');
}

/** 热身任务那一行。没有 goal 的场景（free-1）不要求念 1 号句 */
function warmupPrompt(scenario: ResolvedScenario, seedText?: string | null): string {
  if (!scenario.goal && scenario.hiddenGoal) {
    if (seedText) return '准备好了发一条语音，先用英文说一句你今天干嘛了。';
    return '准备好了发一条语音，随便说一句你今天做了什么。';
  }
  return '准备好了发一条语音，先用 1 号句造一句。';
}
