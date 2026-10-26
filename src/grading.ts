/**
 * 逐句评分。**和对话轮完全分开**（docs/04 §三、04 §四）。
 *
 * 为什么不能边聊边判：
 * - 同一个模型又在演角色又在打分，它会拿「你点的是茶不是咖啡」当语言错误
 *   （`20261026-1428-yv5d` 第 3 轮）。判的是你选了什么，不是你这句话对不对。
 * - 对话轮有 5 秒预算，评分没有。评分要的是判得准，慢一点没关系。
 *
 * 三条实测结论写在这里，改之前先看：
 * 1. **必须一句一调**。8 句一次判时，同一份输入跑两遍，8 句里 3 句在两档之间摇
 *    （第 5 轮 ✗/~、第 6 轮 ✓/✗）。一句一调后档位两遍完全一致。
 * 2. **不要传 temperature**。kimi-k2.6 只接受 1，传 0 直接 HTTP 400。
 * 3. **关掉思考**。关掉后整场 8 句 16–20 秒；开着要 3–4 分钟。
 */

import { z } from 'zod';
import { CONFIDENCE_MARK, callChat, firstJsonObject, moonshotConfig, stripFence } from './llm.js';

// ────────────────────────────────────────────────────────────
// 契约
// ────────────────────────────────────────────────────────────

export const Verdict = z.enum(['ok', 'unnatural', 'wrong', 'unclear']);
export type Verdict = z.infer<typeof Verdict>;

/**
 * 模型只回答三档。**`unclear` 不在里面**——那是代码按 ASR 置信度算出来的。
 *
 * 为什么：`unclear` 一旦成为模型可选项，它就是逃生口。模型拿不准就退过去，
 * 退不退是随机的，同一句三次跑出 ok / unclear / wrong 三种结果。
 * 而「这个词是不是转写猜的」本来就该看 `p`，不该问模型。
 */
export const ModelVerdict = z.enum(['ok', 'unnatural', 'wrong', 'unclear']);
export type ModelVerdict = z.infer<typeof ModelVerdict>;

export const SentenceSchema = z.object({
  turn: z.number().int().min(0),
  /** 这轮是不是一个能独立成立的回答。词少不代表不是（"For here." 就是） */
  form: z.enum(['full', 'fragment']),
  verdict: ModelVerdict,
  /** 出问题的最小片段，原样取自转写。只有 wrong / unnatural 有 */
  said: z.string().nullable().optional(),
  /** 上面那一个片段的正确写法 */
  fix: z.string().nullable().optional(),
  /** 整句更自然的版本 */
  better: z.string().nullable().optional(),
  /** 一句中文，点名到具体的词 */
  why: z.string().nullable().optional(),
  /** 内容和场景对不上时提一句。**不影响 verdict** */
  note: z.string().nullable().optional(),
});

export type ModelSentence = z.infer<typeof SentenceSchema>;
/**
 * 落地用的句子：`verdict` 可能是模型给的三档，也可能是代码降下来的 `unclear`。
 *
 * `agreement` = 多数票占几成（1 = 三次全一致，0.34 = 三次全不同）。
 * 卡片不显示它，但**必须落盘**：没有这个数，事后看不出哪些句子是判得稳的、
 * 哪些是在摇摆，也就没法判断卡片的可信度。
 */
export type Sentence = Omit<ModelSentence, 'verdict'> & {
  verdict: Verdict;
  agreement: number;
};
export type SessionGrade = {
  sentences: Sentence[];
  drills: string[];
  /** 本次判分的耗时，用来判断 /end 的等待是否可以接受 */
  gradeMs: number;
};

// ────────────────────────────────────────────────────────────
// Prompt
// ────────────────────────────────────────────────────────────

export const SYSTEM = `You grade one learner's spoken English, one sentence.
You are NOT role-playing. You are a careful teacher reading a transcript.

The learner is A2 (elementary). Their speech was transcribed by ASR: no punctuation,
and some words are guesses. Guesses are marked like [word? p=0.19].

## Decide exactly one verdict. There are only three.

- "ok" — grammatical AND a native speaker would say it. Short answers are fine
  ("For here.", "No, thanks.").
- "unnatural" — grammatical, but no native speaker would put it that way.
- "wrong" — a concrete form error from the closed checklist below.

Order: form error from the checklist → "wrong". Form right but not native → "unnatural".
Otherwise → "ok".

There is no "unclear" verdict and no "I can't tell" option. Guessy words are handled
elsewhere: if the word you would correct happens to be an ASR guess, that is checked
mechanically afterwards, not by you. So judge every sentence on what it says.

## Closed checklist — these are always "wrong", never "unnatural"

articles (a/an/the, missing or extra) · singular/plural ·
verb form (3rd-person -s, past -ed, after modal) ·
preposition · countable/uncountable (some/any, much/many) ·
wrong chunk/collocation · word class (very + verb, adjective used as noun) ·
question word order · comparative/superlative.

If the problem is on this list, the verdict is "wrong" even when the meaning is clear.
"I very like this coffee" is "wrong": very cannot modify a verb, no matter that it is
understandable.

## "unnatural" — look for it before you say "ok"

Grammatical but not what a native speaker would say. Common in transcribed speech, and
it is exactly what the learner needs to hear:

- Chinese-shaped phrasing built word for word: "I want to enlarge the cup"
- the wrong chunk for the function: "I paid by cash" (in cash) · "open the light"
- register nobody uses here: "I want a coffee" at a counter
- two verbs welded without a connector: "I stay home play basketball"

"unnatural" is not on the checklist. But it must name the exact chunk to replace AND
give the whole native version in "better". If you cannot do both, go back to "ok".

## Judge every sentence anyway

Some words are transcribed as guesses. That is not a reason to skip the sentence:
- "To go" is a complete correct answer; a low score on "to" changes nothing.
- "For here" is correct even if "For" scored 0.36.
- Do not write guessed words back into "said", and do not "fix" one. Pick a fragment
  that is clearly what they said.

## Verb tense: judge ONLY with evidence inside the sentence

Give "wrong" for tense only when the sentence itself carries the evidence:
- a time marker that pins it: "yesterday I go" · "this morning I wake up at 6"
- the sentence changes tense mid-clause: "I got up early and I wake up at 6"

If judging tense would need the counterpart's question, and the question does not
clearly pin past or present, do not judge tense.

Worked example — get this right:
  Counterpart: "What do you usually do when you have a whole day at home?"
  Learner: "I will stay home all day."
  → The question asks about HABIT. "will" is stilted, so at most "unnatural", and
  "better" may use "I stay home all day". NEVER "I stayed" — nothing here is past.

## Content is not form

Do not judge whether the choice fits the scenario. Whether they ordered tea or coffee
is not a language question. If the learner says fine English that does not fit the role
(they answer as the barista, or it makes no sense as a reply), still judge the SENTENCE
— usually "ok" — and put a short Chinese remark in "note". The note never changes the
verdict. Example: "Hi, what can I get for you today?" said to the barista → "ok",
note "这句是店员说的，你是顾客".

## These are correct. Never flag them

- "I don't know how to say X in English." / "How do you say X in English?"
  / "What do you call X in English?" — all natural. This is the escape hatch an A2
  learner needs; marking it wrong teaches them to stay silent.
- "What does it mean, X?" — spoken right-dislocation, normal in conversation.
- short answers that work: "For here." · "To go." · "Cash, please." · "No, thanks."
- starting a spoken turn with "And", "So", "Yeah", "Okay".

**Never invent an error.** If you cannot name the exact word to change, the verdict is
"ok". Do not flag style preferences, contractions, or normal casual speech.

## Fields

- "form": "full" if the turn stands on its own as an answer; "fragment" if they only got
  out a word or two. Short fixed expressions count as "full".
- "said": the smallest fragment containing the problem, copied verbatim from the
  transcript (bracket markers stripped). Not the whole sentence. null for "ok".
- "fix": what that fragment should be. Same size as "said". null for "ok".
- "better": the whole sentence the way a native speaker would say it, same meaning.
  Give it for "unnatural" and "wrong". null for "ok".
- "why": ONE Chinese sentence naming the specific word. Not a grammar lecture.
  Simplified Chinese (简体中文) only, never Traditional.
  Good: "付现金用 in cash，by 只跟 by card 连用". Bad: "介词使用不当".

Return ONLY this JSON, for the one turn you were given:
{"turn":1,"form":"full","verdict":"wrong","said":"...","fix":"...","better":"...","why":"...","note":null}`;

const DRILL_SYSTEM = `You write the practice list at the end of an English speaking session.

You are given the turns the learner got wrong or said unnaturally, with the correction.

Write 2-3 patterns to practise next time.
- Take them from THESE actual problems. Never a generic textbook list.
- Each is the English pattern plus a short Chinese label:
  "I'll pay in cash. / Could I pay by card? — 付现金用 in"
- Simplified Chinese only.
- Nothing worth practising → return {"drills": []}.

Return ONLY: {"drills":["...","..."]}`;

// ────────────────────────────────────────────────────────────
// Prompt 拼装
// ────────────────────────────────────────────────────────────

export type GradeTurn = {
  index: number;
  text: string;
  words: { w: string; p: number }[];
  /** 这一轮 bot 说了什么。上一轮的这个值才是「用户说话前的提问」 */
  botSay?: string;
};

const edgePunct = (w: string) => w.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '');

/** 和运行时同一套标注：低置信度内联标出来 */
export function annotate(words: { w: string; p: number }[], fallback: string): string {
  if (!words.length) return fallback;
  return words
    .map((w) => {
      const token = edgePunct(w.w) || w.w;
      return w.p < CONFIDENCE_MARK ? `[${token}? p=${w.p.toFixed(2)}]` : token;
    })
    .join(' ');
}

/**
 * 上一轮 bot 说的话才是这一轮的「前台词」。
 *
 * 曾经把**本轮** botSay 标成 counterpart，模型读成「用户说话前对方这么问」，
 * 于是凭空编出语境（yv5d 第 3 轮那句「对方问 for here or to go」是在用户答完才说的）。
 */
export function askedBefore(turns: GradeTurn[]): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]!;
    if (prev.botSay) out.set(turns[i]!.index, prev.botSay);
  }
  return out;
}

export function buildTurnPrompt(params: {
  title: string;
  turn: GradeTurn;
  asked?: string | undefined;
}): string {
  const { title, turn, asked } = params;
  const lines: string[] = [`Scenario: ${title}`, ''];

  if (turn.index === 0) {
    lines.push('This is the WARM-UP turn: the learner is reading a prepared sentence aloud.');
    lines.push('Judge it only as "ok" or "unclear". Never "wrong".');
    lines.push('');
  } else if (asked) {
    lines.push('What the counterpart said BEFORE the learner spoke:');
    lines.push(`  ${asked}`);
    lines.push('');
  }

  lines.push('The learner said:');
  lines.push(`  ${annotate(turn.words, turn.text)}`);
  lines.push('');
  lines.push(`Return the JSON object for this one turn, with "turn": ${turn.index}.`);
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
// 代码护栏
// ────────────────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[‘’ʼ`´]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 判定权分层：**模型只说 ok / unnatural / wrong，`unclear` 是代码算的。**
 *
 * 模型拿不准的时候需要一个出口。给它 `unclear` 当出口，它就会随机退过去——
 * 同一句三次跑出 ok / unclear / wrong。所以 `unclear` 不给它，
 * 改成：它想纠正的片段**本身是 ASR 猜的**，就由代码降成 `unclear`。
 * `p` 是盘上现成的事实，不该问模型。
 *
 * 另外两条：
 * - `said` 必须是转写里真有的片段，否则模型编出来的片段不能上卡片
 * - 热身轮不许判 wrong（那是「念一句准备好的话」）
 */
export function verifySentence(
  s: ModelSentence,
  turn: GradeTurn
): Omit<Sentence, 'agreement'> {
  const hay = ` ${norm(turn.words.length ? turn.words.map((w) => w.w).join(' ') : turn.text)} `;

  const grounded = (frag: string | null | undefined) =>
    !!frag && hay.includes(` ${norm(frag)} `);

  /** 转写里这个片段有没有低置信度的词 */
  const guessed = (frag: string) => {
    const want = new Set(norm(frag).split(' ').filter(Boolean));
    return turn.words.some((w) => w.p < CONFIDENCE_MARK && want.has(norm(edgePunct(w.w) || w.w)));
  };

  /**
   * 只有**要改的那个词**是猜的，才降成 `unclear`。
   *
   * 不能拿整个片段去查：`by cash → in cash` 里 `cash` 是猜的（p=0.49），
   * 但真正要改的是 `by`（p=0.75，听得清），这一句该照常判。
   * 取 `said` 和 `fix` 的词差集，只看差集里换掉的那几个词。
   */
  const changedWordsGuessed = () => {
    if (!s.said || !s.fix) return false;
    const fixSet = new Set(norm(s.fix).split(' ').filter(Boolean));
    const gone = norm(s.said)
      .split(' ')
      .filter((w) => w && !fixSet.has(w));
    const saidSet = new Set(norm(s.said).split(' ').filter(Boolean));
    const added = norm(s.fix)
      .split(' ')
      .filter((w) => w && !saidSet.has(w));
    const others = [...gone, ...added].join(' ');
    // 没有词被换掉（只是整句改写）→ 退回查整个片段
    return others ? guessed(others) : guessed(s.said);
  };

  // 模型偶尔仍会吐出 unclear。当成 ok —— 它退到「不判」，那就别判。
  if (s.verdict === 'ok' || s.verdict === 'unclear') {
    return { ...s, verdict: 'ok', said: null, fix: null, better: null };
  }

  // 热身：只可能「没问题」或「没听清」，不判对错
  if (s.turn === 0) return { ...s, verdict: 'ok', said: null, fix: null, better: null };

  // 片段是编的 → 这一句不算有问题
  if (!grounded(s.said)) return { ...s, verdict: 'ok', said: null, fix: null, better: null };

  // 要改的那个词本身是猜的 → 没听清，不给改法（给了就是在猜用户想说什么）
  if (changedWordsGuessed()) {
    return { ...s, verdict: 'unclear', fix: null, better: null, why: null };
  }

  return s;
}

/** 从轻到重。多数平票时取**中间**那一档，不取最重也不取最轻。 */
const SEVERITY: Record<Verdict, number> = { ok: 0, unclear: 1, unnatural: 2, wrong: 3 };

/**
 * 同一句跑三次取多数。
 *
 * 为什么必须投：kimi-k2.6 只接受 `temperature: 1`，传 0 直接 HTTP 400。
 * 采样参数压不住，只能靠重复采样 + 取多数。实测不投票时同一场三次跑出三种结论
 * （第 1 轮 wrong/unclear/unclear、第 2 轮 wrong/unclear/wrong）。
 * 三次全不同时取**中间档**：既不把可疑的句子判成错，也不放过明显的错。
 */
export function vote<T extends Omit<Sentence, 'agreement'>>(samples: T[]): T {
  if (samples.length === 1) return samples[0]!;

  const count = new Map<Verdict, T[]>();
  for (const s of samples) {
    const list = count.get(s.verdict) ?? [];
    list.push(s);
    count.set(s.verdict, list);
  }

  const ranked = [...count.entries()].sort((a, b) => b[1].length - a[1].length);
  const top = ranked[0]!;
  if (top[1].length * 2 > samples.length) return top[1][0]!;

  // 没有过半：取档位居中的那一档
  const sorted = [...samples].sort((a, b) => SEVERITY[a.verdict] - SEVERITY[b.verdict]);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// ────────────────────────────────────────────────────────────
// 调用
// ────────────────────────────────────────────────────────────

async function callJson(system: string, user: string): Promise<string> {
  const cfg = moonshotConfig();
  let last = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { content } = await callChat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        jsonMode: true,
        ...(cfg.extra ? { extra: cfg.extra } : {}),
        timeoutMs: 90_000,
      });
      return content;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      // 429 是限流，等一下再来；其它 4xx 是请求本身错了，重试也白搭
      const rateLimited = /HTTP 429/.test(last);
      if (/HTTP 4\d\d/.test(last) && !rateLimited) break;
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, rateLimited ? 1500 * attempt : 500 * attempt));
      }
    }
  }
  throw new Error(last);
}

/**
 * 同时最多几路。Moonshot 的限额是组织级 100 RPM，开太高会 429。
 * 一场 8 句 × 3 次采样 = 24 个请求，3 路并行约 10 秒，留足余量。
 */
const CONCURRENCY = 3;

/**
 * 每句采样几次。1 = 不投票（实测不稳），3 = 多数票。
 * 8 句 × 3 次 = 24 个请求，4 路并行约 10 秒。复盘不在 5 秒预算里，值得。
 */
const SAMPLES = 3;

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 判一整场。**绝不抛错**：复盘是练习的收尾，判不出来也要给用户一张卡片。
 * 判不出的轮次直接不进 `sentences`，卡片上会写「没判出来」。
 */
export async function gradeSession(params: {
  title: string;
  turns: GradeTurn[];
}): Promise<SessionGrade> {
  const startedAt = Date.now();
  const turns = params.turns.filter((t) => t.text.trim());
  if (!turns.length) return { sentences: [], drills: [], gradeMs: 0 };

  const asked = askedBefore(turns);

  const prompt = (turn: GradeTurn) =>
    buildTurnPrompt({ title: params.title, turn, asked: asked.get(turn.index) });

  /** 采一次。失败返回 null —— 投 2 票也能出结果，不必要求 3 票全到。 */
  const sample = async (turn: GradeTurn): Promise<Omit<Sentence, 'agreement'> | null> => {
    try {
      const content = await callJson(SYSTEM, prompt(turn));
      const parsed = SentenceSchema.safeParse(JSON.parse(firstJsonObject(stripFence(content))));
      if (!parsed.success) return null;
      return verifySentence({ ...parsed.data, turn: turn.index }, turn);
    } catch (err) {
      console.warn(`[grading] 第 ${turn.index} 轮判失败：`, err instanceof Error ? err.message : err);
      return null;
    }
  };

  const tasks = turns.flatMap((turn) => Array.from({ length: SAMPLES }, () => turn));

  // 采样打平：同一句的三次采样散开在队列里，不和本句的其他采样挨着
  const shuffled = tasks
    .map((turn, i) => ({ turn, k: i % SAMPLES }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.turn);

  const raw = await pool(shuffled, CONCURRENCY, sample);

  const byTurn = new Map<number, Omit<Sentence, 'agreement'>[]>();
  for (const turn of turns) byTurn.set(turn.index, []);
  raw.forEach((s, i) => {
    const turn = shuffled[i];
    if (s && turn) byTurn.get(turn.index)!.push(s);
  });

  const graded: (Sentence | null)[] = turns.map((turn) => {
    const samples = byTurn.get(turn.index) ?? [];
    if (!samples.length) return null;
    const winner = vote(samples);
    const agree = samples.filter((s) => s.verdict === winner.verdict).length / samples.length;
    return { ...winner, agreement: Number(agree.toFixed(2)) };
  });

  const sentences = graded.filter((x): x is Sentence => x !== null);

  const bad = sentences.filter((x) => x.verdict === 'wrong' || x.verdict === 'unnatural');
  let drills: string[] = [];
  if (bad.length) {
    const lines = bad
      .map((x) => {
        const t = turns.find((y) => y.index === x.turn);
        return `- said: ${t?.text ?? ''}\n  fixed: ${x.better ?? ''}\n  problem: ${x.why ?? ''}`;
      })
      .join('\n');
    try {
      const content = await callJson(DRILL_SYSTEM, lines);
      const parsed = z
        .object({ drills: z.array(z.string()).max(4) })
        .safeParse(JSON.parse(firstJsonObject(stripFence(content))));
      if (parsed.success) drills = parsed.data.drills;
    } catch (err) {
      console.warn('[grading] drills 生成失败：', err instanceof Error ? err.message : err);
    }
  }

  return { sentences, drills, gradeMs: Date.now() - startedAt };
}
