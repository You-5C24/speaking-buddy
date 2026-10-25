/**
 * 手动验证 llm.ts 的两个 adapter。
 *   pnpm probe:llm            → 只测默认 provider（moonshot）
 *   pnpm probe:llm -- both    → 两个都测
 */

import { buildMessages, completeWithRetry, moonshot, geminiRelay } from './llm.js';

const PERSONA =
  'a friendly but brisk barista at a coffee shop. You are mid-shift and the queue is long.';

const OUT_OF_ORDER = buildMessages({
  persona: PERSONA,
  opening: 'Hi! What can I get for you today?',
  history: [],
  userText: 'I very like this coffee.',
});

const cases = [
  { name: 'very 修饰动词（应为 collocation）', messages: OUT_OF_ORDER },
  {
    name: '完全正确的句子（flags 应为空）',
    messages: buildMessages({
      persona: PERSONA,
      history: [],
      userText: 'Could I get a medium oat milk latte, please?',
    }),
  },
  {
    name: '带口音特征的时态错误',
    messages: buildMessages({
      persona: PERSONA,
      history: [],
      userText: 'Yesterday I go to the store and buy a coffee.',
    }),
  },
];

async function runModel(label: string, model: ReturnType<typeof moonshot>) {
  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);

  for (const c of cases) {
    const t0 = Date.now();
    const { reply, degraded, error } = await completeWithRetry(model, c.messages);
    const ms = Date.now() - t0;

    console.log(`\n[${c.name}]  ${ms}ms${degraded ? '  ⚠️ DEGRADED' : ''}`);
    if (error) console.log(`  error: ${error}`);
    console.log(`  say: ${reply.say}`);
    for (const f of reply.flags) {
      console.log(
        `  flag: "${f.said}" → "${f.better}"  [${f.type} sev${f.severity}]` +
          (f.why ? `  ${f.why}` : '')
      );
    }
    if (reply.flags.length === 0) console.log('  (no flags)');
  }
}

const which = process.argv[2] ?? 'moonshot';

if (which === 'both' || which === 'moonshot') {
  await runModel('Moonshot · kimi-k2.7-code-highspeed', moonshot());
}

if (which === 'both' || which === 'gemini') {
  await runModel('Gemini 3.8 Flash (low) · 中转站', geminiRelay());
}

console.log('\ndone');
