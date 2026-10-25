/**
 * §4.5 第 2 步：用同一个输入跑 N 次生成，看它到底稳不稳。
 *
 *   pnpm probe:gen                      → 5 次「我想做机场值机」
 *   pnpm probe:gen -- 3 "我想做酒店入住" → 3 次，换输入
 *
 * 只验三件事（§4.5「动手前先花十分钟验」）：
 * 1. blocks 是不是都在 A2 以内（沿用 validateScenario 的确定性规则）
 * 2. 每次都有「摩擦」那条 beat 吗
 * 3. frame 有没有带两个以上槽位的
 *
 * 这是诊断脚本，不是运行时。它自己发一次 HTTP，不经过 llm.ts 的 ChatModel —
 * 因为那边只认 Reply schema，而这里要看的是场景 JSON。**不改任何运行路径。**
 */

import { loadAll, validateScenario, ScenarioSchema, type ScenarioDef } from './scenarios.js';
import { findGenericFrames } from './blocks.js';

const BASE = 'https://api.moonshot.cn/v1';
// 场景生成不跟在线对话模型走。highspeed 关不掉思考，但这一步不在 5 秒预算里。
const MODEL = process.env.SCENARIO_MODEL ?? 'kimi-k2.7-code-highspeed';

const SYSTEM = `You design short English speaking-practice scenarios for an A2 learner.

Return ONLY a JSON object:
{
  "id": "kebab-case-ascii-id",
  "title": "<10 个汉字以内的中文名>",
  "level": "A2",
  "goal": "<一句中文：用户要完成什么>",
  "hiddenGoal": "<一句中文：bot 的隐藏议程，用户看不到>",
  "persona": "<English: who the bot plays, 1-2 sentences, with one constraint that creates friction>",
  "opening": "<English: the bot's first spoken line>",
  "blocks": [
    { "n": 1, "frame": "<English sentence with one ___ slot>", "example": "<filled example>" }
  ],
  "beats": [
    { "atTurn": 2, "need": "<中文>", "directive": "<English, this-turn-only instruction>" }
  ]
}

Hard rules — violating any one makes the scenario unusable:
- EXACTLY 3 blocks. Each block is one sentence with EXACTLY ONE ___ slot.
- After removing the ___, no fragment may exceed 8 words. This is A2.
- Banned: kinda, sorta, gonna, wanna, "I was wondering".
- Every block must be something the learner MUST say for this task, and would
  NOT say in a different topic. No generic filler phrases.
- The persona must create friction: the other side mishears, misunderstands,
  interrupts, or gets something wrong once.
- beats: 1-2 items. At least one MUST command a concrete mistake from the bot
  (mishear / misunderstand / interrupt). atTurn must be 2 or 3, never later.
- goal AND hiddenGoal are both required.
- No markdown, no commentary, no code fences. JSON only.`;

type GenResult = {
  run: number;
  ms: number;
  raw: string;
  scenario?: ScenarioDef;
  parseError?: string;
  problems: string[];
  doubleSlot: boolean;
  hasFriction: boolean;
};

async function callOnce(request: string): Promise<{ raw: string; ms: number }> {
  const key = process.env.MOONSHOT_API_KEY;
  if (!key) throw new Error('缺少 MOONSHOT_API_KEY（放在 .env 里）');

  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `场景请求（用户原文，最多 100 字）：\n"""${request}"""` },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content ?? '';
  if (!raw.trim()) throw new Error('返回空 content');
  return { raw, ms: Date.now() - t0 };
}

function analyze(run: number, raw: string, ms: number): GenResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const result: GenResult = { run, ms, raw: cleaned, problems: [], doubleSlot: false, hasFriction: false };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    result.parseError = err instanceof Error ? err.message : String(err);
    return result;
  }

  const parsed = ScenarioSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    result.parseError = `${i?.path.join('.')} ${i?.message}`;
    return result;
  }

  result.scenario = parsed.data;
  result.problems = validateScenario(parsed.data);
  result.doubleSlot = parsed.data.blocks.some((b) => /_{2,}.*_{2,}/.test(b.frame));
  result.hasFriction = parsed.data.beats.some((b) =>
    /mishear|misunderstand|confus|wrong|interrupt|ask again|repeat/i.test(b.directive)
  );
  return result;
}

function dump(r: GenResult) {
  const head = `── 第 ${r.run} 次 · ${r.ms}ms ${r.problems.length ? `· ${r.problems.length} 个问题` : '· 通过'}`;
  console.log(`\n${head}`);
  if (r.parseError) {
    console.log(`  ❌ 解析失败：${r.parseError}`);
    console.log(`     raw: ${r.raw.slice(0, 200)}`);
    return;
  }
  const s = r.scenario!;
  console.log(`  ${s.title} · ${s.level}`);
  console.log(`  persona: ${s.persona.slice(0, 90)}`);
  s.blocks.forEach((b) => {
    const slots = (b.frame.match(/_{2,}/g) ?? []).length;
    console.log(`  块 ${b.n} [${slots} 槽] ${b.frame}`);
  });
  s.beats.forEach((b) => console.log(`  beat@${b.atTurn}: ${b.directive.slice(0, 90)}`));
  if (r.doubleSlot) console.log('  ⚠️ 有块带两个以上槽位');
  if (!r.hasFriction) console.log('  ⚠️ beats 里没有摩擦动作');
  for (const p of r.problems) console.log(`  ❌ ${p}`);
}

async function main() {
  // 不按位置取参数：`pnpm run x -- 3 "…"` 会把参数顺序搞乱（实测反转）。
  // 数字当次数，其余拼成输入。
  const args = process.argv.slice(2);
  const numArg = args.find((a) => /^\d+$/.test(a));
  const n = numArg ? Number(numArg) : 5;
  // 用 | 分隔多个话题：每个话题跑 n 次。这是唯一能让「通用句型库」检查真正生效的方式 ——
  // 只跑一个话题时，跨话题比对没有可比样本，那项检查等于没跑。
  const raw = args.filter((a) => a !== numArg).join(' ').trim() || '我想做机场值机';
  const requests = raw.split('|').map((s) => s.trim()).filter(Boolean);
  const request = requests[0]!;

  console.log(`模型 ${MODEL}`);
  for (const r of requests) console.log(`  输入「${r}」× ${n} 次`);

  const results: GenResult[] = [];
  let runNo = 0;
  const total = requests.length * n;
  for (const req of requests) {
    console.log(`\n${'─'.repeat(60)}\n话题：${req}\n${'─'.repeat(60)}`);
    for (let i = 1; i <= n; i++) {
      runNo++;
      try {
        const { raw, ms } = await callOnce(req);
        const r = analyze(runNo, raw, ms);
        results.push(r);
        dump(r);
      } catch (err) {
        console.log(`\n── 第 ${runNo} 次 · 调用失败`);
        console.log(`  ${err instanceof Error ? err.message : String(err)}`);
        results.push({ run: runNo, ms: 0, raw: '', problems: ['调用失败'], doubleSlot: false, hasFriction: false });
      }
    }
  }

  console.log(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}`);
  const N = total;
  const okCount = results.filter((r) => !r.parseError && r.problems.length === 0).length;
  const parsedCount = results.filter((r) => r.scenario).length;
  const frictionCount = results.filter((r) => r.hasFriction).length;
  const doubleSlotCount = results.filter((r) => r.doubleSlot).length;
  // 切题：拿输入里的汉字去比，别写死关键词（上一版写死「机场」，换酒店输入时误报）
  const hanzi = [...new Set(requests.join('').match(/[\u4e00-\u9fff]/g) ?? [])];
  const topical = results.filter(
    (r) => r.scenario && hanzi.some((c) => JSON.stringify(r.scenario).includes(c))
  ).length;

  console.log(`  解析成功      ${parsedCount}/${N}`);
  console.log(`  校验全过      ${okCount}/${N}   ← 少于 ${N} 就要加确定性校验，而不是加 prompt`);
  console.log(`  有摩擦 beat   ${frictionCount}/${N}`);
  console.log(`  双槽位 frame  ${doubleSlotCount}/${N}   ← 应接近 0`);
  console.log(`  切题          ${topical}/${N}`);
  // 通用句型库检查：跨场景（含已手写的 cafe-1 / free-1）比对块的骨架。
  // validateScenario 抓不到这一条 —— 生成的每个块单看都合规，但换话题照样能用。
  const generated = results.flatMap((r) => r.scenario ?? []);
  const { scenarios: handwritten } = await loadAll();
  const generic = findGenericFrames([...handwritten, ...generated]);
  if (generic.length) {
    console.log('\n  ⚠️ 疑似通用句型库（内容词重合 ≥ 0.6，需人工复核，不要自动删）：');
    for (const g of generic.slice(0, 8)) console.log(`    · ${g.a} ≈ ${g.b}  ${g.overlap}`);
  }

  const problems = results.flatMap((r) => r.problems);
  if (problems.length) {
    console.log('\n  全部问题：');
    for (const p of [...new Set(problems)]) console.log(`    · ${p}`);
  }

  const verdict =
    okCount === N && doubleSlotCount === 0 && frictionCount === N && generic.length === 0
      ? '✅ 稳定。§4.5 第 3 步（生成 + 落盘）可以开工。'
      : okCount === N && doubleSlotCount === 0 && frictionCount === N
        ? '⚠️ 格式全过，但有疑似通用句型库（见上）。先人工看那几条，这是内容问题不是格式问题。'
      : okCount === 0
        ? '❌ 一次都没过。先改 SYSTEM 里被违反最多的那条规则。'
        : '⚠️ 不稳定。按上面「全部问题」逐条补确定性校验，别只改 prompt。';
  console.log(`\n  ${verdict}\n`);
}

await main();
