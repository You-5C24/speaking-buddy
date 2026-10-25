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

export const Reply = z.object({
  say: z.string().min(1).max(300),
  flags: z.array(Flag).max(5),
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

Return ONLY a JSON object, nothing else:
{"say": "<your spoken reply>", "flags": [{"said": "...", "better": "...", "type": "grammar|collocation|vocab|fluency", "severity": 1, "why": "<一句中文说明>"}]}

flags = errors you noticed this turn. Use [] if none.
- "type": "very" modifying a verb is a COLLOCATION problem, not grammar.
- "severity": 1 = doesn't affect meaning, 2 = slightly, 3 = affects understanding.
- Be conservative. Only flag what a teacher would actually mention.
`.trim();

export function buildMessages(params: {
  persona: string;
  opening?: string;
  history: Msg[];
  userText: string;
}): Msg[] {
  const system = `You are an English speaking partner.\n\nYour role: ${params.persona}\n\n${RULES}`;

  return [
    { role: 'system', content: system },
    ...(params.opening
      ? [{ role: 'assistant' as const, content: params.opening }]
      : []),
    ...params.history,
    { role: 'user', content: params.userText },
  ];
}

// ────────────────────────────────────────────────────────────
// 通用 OpenAI 兼容调用
// ────────────────────────────────────────────────────────────

/**
 * 中转站实测会返回 ```json 包裹的内容（6 次里有 2 次）。
 * Moonshot 不会。这里统一剥一遍，成本为零。
 */
function stripFence(s: string): string {
  const t = s.trim();
  if (!t.startsWith('```')) return t;
  return t
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** 有些模型会把多个 JSON 对象拼在一起，取第一个完整对象 */
function firstJsonObject(s: string): string {
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

async function callChat(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Msg[];
  jsonMode: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
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
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });

      const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      if (reasoning > 0) {
        // 不走 throw：慢总比没有好，但要留下证据
        console.warn(
          `[llm] ${cfg.id} 产生 ${reasoning} reasoning tokens（${ms}ms），该模型不适合实时对话`
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
  const key = requireEnv(env, 'MOONSHOT_API_KEY');
  return makeChatModel({
    id: 'moonshot',
    label: 'Kimi k2.7 highspeed',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: key,
    model: env.MOONSHOT_MODEL ?? 'kimi-k2.7-code-highspeed',
  });
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
