/**
 * LLM 层：一轮对话的结构化输出。
 *
 * 设计要点：
 * - 只有一次调用，没有任何编排。这是确定性管线，不是 agent。
 * - 两个 provider 都是 OpenAI 兼容形状，所以共用一个请求函数，
 *   差异只在 baseUrl / model / 容错策略。
 * - 失败必定有兜底，绝不让一轮卡死。
 */

import { z } from 'zod';
import { norm } from './blocks.js';

// ────────────────────────────────────────────────────────────
// 契约
// ────────────────────────────────────────────────────────────

export const Flag = z.object({
  /** 用户原句里出问题的片段，用于回溯到具体位置 */
  said: z.string(),
  /** 更自然的说法 */
  better: z.string(),
  type: z.enum(['grammar', 'collocation', 'vocab', 'fluency']),
  /** 1 = 不影响理解, 2 = 略影响, 3 = 影响理解 */
  severity: z.number().int().min(1).max(3),
  /** 中文一句话说明为什么 */
  why: z.string().optional(),
});

/**
 * 对话轮只负责「说」。判分在 `grading.ts`，`/end` 时跑，不带角色。
 *
 * 曾经对话轮同时产出 `flags` / `rewrite`，代价是：
 * - 模型带着角色去判，把你「点了茶不点咖啡」算成语言错误
 * - `rewrite` 被 `if (flags.length === 0) rewrite = undefined` 连坐，
 *   语法对但不地道的句子永远记不下来
 * - prompt 里那一大段 JSON 契约挤占了它本该用来接话的注意力
 * 那三个字段留在 schema 里只为读回旧场次（`pipeline.ts` 的 `readTurnFile`）。
 */
export const Reply = z.object({
  say: z.string().min(1).max(300),
  rewrite: z.string().max(200).nullable().optional(),
  flags: z.array(Flag).max(5).optional(),
});

export type Flag = z.infer<typeof Flag>;
export type Reply = z.infer<typeof Reply>;

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ChatModel {
  readonly id: string;
  readonly label: string;
  /** 返回结构化结果；失败会抛错，由调用方决定是否兜底 */
  complete(messages: Msg[], opts?: { signal?: AbortSignal }): Promise<Reply>;
}

// ────────────────────────────────────────────────────────────
// System prompt
// ────────────────────────────────────────────────────────────

const RULES = `
Rules:
- Reply with 1-3 sentences, under 30 words. Never write more.
- ALWAYS make one move that pushes the conversation forward: ask a question,
  or add new information. Never stall.
- Do NOT summarize what the user just said.
- If the user makes an error that hurts understanding, work the correct form
  naturally into your reply. NEVER point out the error.
- Never say "Great!", "Excellent!" or similar empty praise.
- No markdown, no lists, no emoji, no quotation marks around your reply.
- "say" is spoken aloud. Write it the way a native speaker talks: contractions, natural rhythm.
- No em dashes, no ellipsis used as a pause, no written-only punctuation.
- The learner is A2. Prefer questions they can answer in one full sentence:
  yes/no questions with a reason, A-or-B choices, "what kind of ___".
  Never ask an open question that can be answered with one word.
- Never ask "Anything else?" as your only question. It invites a one-word answer.
- Words marked like [word? p=0.38] are ASR guesses. Treat them as probably-what-they-
  said; never correct a neighbouring word just because it looks wrong next to a guess.
- If they ask how to say something, answer it in one short sentence and then keep going.
- You are NOT grading. There is no score, no correction list, no rewrite. Someone else
  reads the transcript afterwards. Your only job is to be a believable conversation
  partner and keep it moving.

Return ONLY a JSON object, nothing else:
{"say": "<your spoken reply>"}
`.trim();

export function buildMessages(params: {
  persona: string;
  opening?: string;
  goal?: string;
  hiddenGoal?: string;
  /** 这一轮的 beat。有就原样追加，不写成「可以的话」这种软要求 */
  beatDirective?: string;
  seedText?: string;
  history: Msg[];
  userText: string;
}): Msg[] {
  let system = `You are an English speaking partner.\n\nYour role: ${params.persona}\n\n${RULES}`;

  // 三句卡**不再进对话 prompt**。原来写成 `Blocks the learner prepared`，
  // 等于告诉店员「这个人手里有三张牌」，它会不自觉地往那三句上引，
  // 对话就固定死了。那三句是用户的脚手架，不是模型的剧本。
  if (params.goal) system += `\n\nScenario goal: ${params.goal}`;
  if (params.hiddenGoal) {
    system += `\n\nYour own agenda this session (never state it, just steer): ${params.hiddenGoal}`;
  }
  if (params.seedText) system += `\n\nWhat they mentioned when starting: ${params.seedText}`;
  if (params.beatDirective) system += `\n\nTHIS TURN ONLY: ${params.beatDirective}`;

  return [
    { role: 'system', content: system },
    ...(params.opening ? [{ role: 'assistant' as const, content: params.opening }] : []),
    ...params.history,
    { role: 'user', content: params.userText },
  ];
}

/** 标注线，不是判据。低于它的词内联标出来，其余不动（§5） */
export const CONFIDENCE_MARK = 0.62;

const edgePunct = (w: string) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

/**
 * 第二层护栏：把低置信度标进转写，不另起一份名单。
 * 词不够时退回原文，避免空串进 prompt。
 */
export function annotateTranscript(
  words: { w: string; p: number }[],
  fallbackText: string
): string {
  if (!words.length) return fallbackText;
  return words
    .map((word) => {
      const token = edgePunct(word.w) || word.w;
      if (word.p < CONFIDENCE_MARK) return `[${token}? p=${word.p.toFixed(2)}]`;
      return token;
    })
    .join(' ');
}

export type CleanReply = {
  say: string;
  flags: Flag[];
  rewrite?: string;
};

/**
 * 只保留 `say`。
 *
 * 以前这里还有一层「`said` 必须是转写里真有的片段」的护栏，连同 `rewrite`
 * 的两条校验。判分搬去 `grading.ts` 之后，那套护栏跟着搬到了
 * `grading.ts` 的 `verifySentence()`——它必须在**评分**这一侧生效，
 * 而不是在对话这一侧。
 */
export function sanitizeReply(reply: Reply): CleanReply {
  return { say: reply.say, flags: [], ...(reply.rewrite ? { rewrite: reply.rewrite } : {}) };
}

const HELP_LINE = 'Try asking: "How do you say ___ in English?"';

/**
 * 转写基本是中文，或一整句每个词都低于标注线：这轮是求助。
 * 短答不算。`Black` 只有一个词、p=0.54，是在回答 Black or with milk，
 * 不该回 How do you say。那种情况交给模型，并在转写里标出置信度。
 */
export function isHelpSeeking(text: string, words: { p: number }[]): boolean {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  const nonAscii = letters.filter((c) => (c.codePointAt(0) ?? 0) > 127);
  if (nonAscii.length >= 2) return true;
  if (letters.length > 0 && nonAscii.length / letters.length >= 0.25) return true;
  if (words.length >= 4 && words.every((w) => w.p < CONFIDENCE_MARK)) return true;
  return false;
}

export function helpSeekingReply(): CleanReply {
  return { say: HELP_LINE, flags: [] };
}

// ────────────────────────────────────────────────────────────
// 通用 OpenAI 兼容调用
// ────────────────────────────────────────────────────────────

/**
 * 中转站实测会返回 ```json 包裹的内容（6 次里有 2 次）。
 * Moonshot 不会。这里统一剥一遍，成本为零。
 */
export function stripFence(s: string): string {
  const t = s.trim();
  if (!t.startsWith('```')) return t;
  return t
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** 有些模型会把多个 JSON 对象拼在一起，取第一个完整对象 */
export function firstJsonObject(s: string): string {
  const start = s.indexOf('{');
  if (start < 0) return s;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

type OpenAIResponse = {
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

export async function callChat(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Msg[];
  jsonMode: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  extra?: Record<string, unknown>;
}): Promise<{ content: string; usage: OpenAIResponse['usage']; ms: number }> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), params.timeoutMs);
  const onAbort = () => ac.abort();
  params.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(`${params.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...params.extra,
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${params.model} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new Error(`${params.model} 返回空 content`);

    return { content, usage: data.usage, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onAbort);
  }
}

// ────────────────────────────────────────────────────────────
// Adapter factory
// ────────────────────────────────────────────────────────────

export type ProviderConfig = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 是否用 response_format: json_object。中转站不可靠时可关掉。 */
  jsonMode?: boolean;
  timeoutMs?: number;
  /** 合并进请求体。kimi-k2.6 用它关思考。 */
  extra?: Record<string, unknown>;
};

export function makeChatModel(cfg: ProviderConfig): ChatModel {
  return {
    id: cfg.id,
    label: cfg.label,
    async complete(messages, opts) {
      const { content, usage, ms } = await callChat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages,
        jsonMode: cfg.jsonMode ?? true,
        timeoutMs: cfg.timeoutMs ?? 20_000,
        ...(cfg.extra ? { extra: cfg.extra } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });

      const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      // k2.6 关掉思考后仍会报 1。只有重新想起来的时候才值得记。
      if (reasoning >= 80) {
        console.warn(
          `[llm] ${cfg.model} 产生 ${reasoning} reasoning tokens（${ms}ms），正式轮会超过 5 秒`
        );
      }

      const parsed = Reply.safeParse(
        JSON.parse(firstJsonObject(stripFence(content)))
      );

      if (!parsed.success) {
        throw new Error(
          `[llm] ${cfg.id} schema 不匹配: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')} | raw=${content.slice(0, 300)}`
        );
      }
      return parsed.data;
    },
  };
}

// ────────────────────────────────────────────────────────────
// 具体 provider
// ────────────────────────────────────────────────────────────

export function moonshot(env = process.env): ChatModel {
  const cfg = moonshotConfig(env);
  return makeChatModel({ id: 'moonshot', label: cfg.model, ...cfg });
}

/**
 * Moonshot 的连接参数。`moonshot()` 和复盘评分（`grading.ts`）共用一份，
 * 免得评分那边自己抄一遍 baseUrl、抄错 `thinking`。
 */
export function moonshotConfig(env = process.env): {
  baseUrl: string;
  apiKey: string;
  model: string;
  extra?: Record<string, unknown>;
} {
  const key = requireEnv(env, 'MOONSHOT_API_KEY');
  // highspeed 关不掉思考。prompt 变长后推理 token 到过 1836，单轮模型 9.5 秒。
  // k2.6 可以 thinking.type=disabled。实测正式轮 0.5–1.4 秒，推理 token 为 1。
  const model = env.MOONSHOT_MODEL ?? 'kimi-k2.6';
  return {
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: key,
    model,
    ...(model === 'kimi-k2.6' ? { extra: { thinking: { type: 'disabled' } } } : {}),
  };
}

/**
 * Gemini via 中转站。默认不启用 —— TTFT 实测 3.0–4.0s，
 * 超过 1.5s 的实时线，只在显式设置 LLM_PROVIDER=gemini 时使用。
 */
export function geminiRelay(env = process.env): ChatModel {
  const key = requireEnv(env, 'FLASHWAY_API_KEY');
  return makeChatModel({
    id: 'gemini',
    label: 'Gemini 3.8 Flash (low) via relay',
    baseUrl: env.FLASHWAY_BASE_URL ?? 'https://gw.flashway.ai/v1',
    apiKey: key,
    model: env.GEMINI_MODEL ?? 'gemini-3.8-flash-low',
    // 中转站的 json_object 不强制 schema，还偶发 ```json 包裹；
    // 保留 jsonMode 但靠 stripFence + zod 兜住。
    jsonMode: true,
    timeoutMs: 25_000,
  });
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

// ────────────────────────────────────────────────────────────
// 选型 + 兜底
// ────────────────────────────────────────────────────────────

export type Provider = 'moonshot' | 'gemini';

/** 默认 moonshot：唯一实测过 1.5s 线的 */
export function selectModel(env = process.env): ChatModel {
  const which = (env.LLM_PROVIDER ?? 'moonshot') as Provider;
  return which === 'gemini' ? geminiRelay(env) : moonshot(env);
}

const FALLBACK: Reply = {
  say: "Sorry, my brain skipped for a second. Could you say that again?",
  flags: [],
};

/**
 * 带重试的调用：失败重试一次（同样的输入），再失败就用固定话术。
 * 绝不向上抛 —— 一轮对话不能因为模型抽风而卡死。
 */
export async function completeWithRetry(
  model: ChatModel,
  messages: Msg[],
  opts?: { retries?: number; signal?: AbortSignal }
): Promise<{ reply: Reply; degraded: boolean; error?: string }> {
  const retries = opts?.retries ?? 1;
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const reply = await model.complete(
        messages,
        opts?.signal ? { signal: opts.signal } : undefined
      );
      return { reply, degraded: false };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[llm] attempt ${attempt + 1} 失败: ${lastError}`);
    }
  }

  return { reply: FALLBACK, degraded: true, error: lastError };
}
