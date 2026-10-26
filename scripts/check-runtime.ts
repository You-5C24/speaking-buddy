/**
 * 运行时纯函数自检：prompt、护栏、热身模板、复盘卡片、选题流程、meta.scenarioId。
 * 不联网、不碰飞书。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSeedText, nextAction } from '../src/flow.js';
import {
  annotateTranscript,
  buildMessages,
  isHelpSeeking,
  sanitizeReply,
  type Reply,
} from '../src/llm.js';
import { verifySentence } from '../src/grading.js';
import {
  createSession,
  longPauseGaps,
  metrics,
  nextTurnIndex,
  readMeta,
  restoreOpenSessions,
  turnIndexFromNames,
  type Session,
  type Turn,
} from '../src/pipeline.js';
import { aggregateMetrics, buildPostmortem, renderCard } from '../src/review.js';
import { loadAll, resolveScenario } from '../src/scenarios.js';
import { activeBeatDirective } from '../src/beats.js';
import { plainTextFromPost } from '../src/lark.js';
import { anchorId, lookupKeys, primaryKey, replyInThread } from '../src/topic.js';
import { buildWarmupLine } from '../src/warmup.js';

let failed = 0;
const eq = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}\n     实际 ${a}\n     期望 ${e}`);
  }
};
const ok = (name: string, cond: boolean) => eq(name, cond, true);

const flag = (said: string, severity = 2): Reply['flags'][number] => ({
  said,
  better: 'x',
  type: 'collocation',
  severity,
  why: '因为',
});

console.log('\nannotateTranscript()');
const payWords = [
  { w: 'What', p: 0.9 },
  { w: 'is', p: 0.9 },
  { w: 'the', p: 0.9 },
  { w: 'main', p: 0.46 },
  { w: 'pay', p: 0.38 },
  { w: 'at', p: 0.9 },
  { w: 'the', p: 0.9 },
  { w: 'register', p: 0.9 },
];
eq(
  '低置信度内联，高置信度原样',
  annotateTranscript(payWords, ''),
  'What is the [main? p=0.46] [pay? p=0.38] at the register'
);
eq('没有词就退回原文', annotateTranscript([], 'hello'), 'hello');

console.log('\nsanitizeReply()');
const asWords = [
  { w: 'Could' },
  { w: 'I' },
  { w: 'get' },
  { w: 'a' },
  { w: 'medium' },
  { w: 'as' },
  { w: 'Americano' },
];
const user = 'Could I get a medium as Americano';
// 判分搬去 grading.ts 之后，sanitizeReply 只留 say。
const cleaned = sanitizeReply({
  say: 'A medium Americano?',
  rewrite: 'Could I get a medium Americano?',
  flags: [flag('mean'), flag('as', 1)],
});
eq('只留 say', cleaned.say, 'A medium Americano?');
eq('flags 不再从对话轮出来', cleaned.flags, []);

console.log('\nverifySentence()');
const gWords = [
  { w: 'I', p: 0.9 },
  { w: 'paid', p: 0.7 },
  { w: 'by', p: 0.9 },
  { w: 'cash.', p: 0.4 },
];
const gTurn = { index: 1, text: 'I paid by cash.', words: gWords };

eq(
  'unclear 不给改法',
  (() => {
    const v = verifySentence(
      {
        turn: 1,
        form: 'full',
        verdict: 'unclear',
        said: 'cash',
        fix: 'card',
        better: 'I paid by card.',
        why: '没听清',
      },
      gTurn
    );
    return [v.fix, v.better];
  })(),
  [null, null]
);
eq(
  'ok 不留下 said / better',
  (() => {
    const v = verifySentence(
      { turn: 1, form: 'full', verdict: 'ok', said: 'x', fix: 'y', better: 'z' },
      gTurn
    );
    return [v.said, v.fix, v.better];
  })(),
  [null, null, null]
);
eq(
  '编出来的片段被丢掉',
  verifySentence({ turn: 1, form: 'full', verdict: 'wrong', said: 'enlarge', fix: 'large' }, gTurn).said,
  null
);
eq(
  '转写里真有的片段留着',
  verifySentence({ turn: 1, form: 'full', verdict: 'wrong', said: 'paid by cash', fix: 'paid in cash' }, gTurn).said,
  'paid by cash'
);
eq(
  '热身轮不判 wrong',
  verifySentence({ turn: 0, form: 'full', verdict: 'wrong', said: 'paid', fix: 'pay' }, { ...gTurn, index: 0 })
    .verdict,
  'ok'
);
eq(
  '要改的词是猜测 → 降成 unclear 且不给改法',
  (() => {
    // cash 的 p=0.4 是猜的；改法把 cash 换成了 card，所以这是「没听清」
    const v = verifySentence(
      { turn: 1, form: 'full', verdict: 'wrong', said: 'by cash', fix: 'by card' },
      gTurn
    );
    return [v.verdict, v.fix];
  })(),
  ['unclear', null]
);
eq(
  '要改的词听得清 → 照常判',
  (() => {
    // 改的是 by（p=0.9），cash 是猜的不影响
    const v = verifySentence(
      { turn: 1, form: 'full', verdict: 'wrong', said: 'paid by', fix: 'paid in' },
      gTurn
    );
    return v.verdict;
  })(),
  'wrong'
);
eq(
  '模型说 unclear 时当作没判，不降成问题',
  verifySentence({ turn: 1, form: 'full', verdict: 'unclear', said: 'cash' }, gTurn).verdict,
  'ok'
);

console.log('\nisHelpSeeking()');
ok('中文是求助', isHelpSeeking('拿铁怎么说', []));
ok(
  '一整句都低于标注线才是求助',
  isHelpSeeking('what is the main pay', [
    { p: 0.4 },
    { p: 0.4 },
    { p: 0.46 },
    { p: 0.38 },
  ])
);
ok('单个低置信度英文词不是求助', !isHelpSeeking('Black', [{ p: 0.538 }]));
ok('正常英文不是求助', !isHelpSeeking('Could I get a latte', [{ p: 0.9 }, { p: 0.4 }]));

console.log('\nbuildMessages()');
const beat = buildMessages({
  persona: 'a barista',
  goal: '点一杯咖啡',
  blocks: [{ n: 1, frame: 'Could I get a ___ ?' }],
  beatDirective: 'This turn, mishear one detail of their order.',
  history: [],
  userText: 'A latte.',
}).find((m) => m.role === 'system')!.content;
ok('goal 进 prompt', beat.includes('Scenario goal: 点一杯咖啡'));
// 三句卡是用户的脚手架，不是模型的剧本。进了 prompt 它会往那三句上引，对话就固定了。
ok('块不进对话 prompt', !beat.includes('Could I get a ___'));
ok('beat 是硬注入', beat.includes('THIS TURN ONLY: This turn, mishear one detail of their order.'));
ok('不写成软要求', !beat.includes('if you like') && !beat.includes('you might'));

const freePrompt = buildMessages({
  persona: 'a friend',
  hiddenGoal: '讲完一件完整的小事',
  seedText: '今天去爬山了',
  history: [],
  userText: 'I went hiking.',
}).find((m) => m.role === 'system')!.content;
ok('hiddenGoal 进 prompt 且要求别说破', freePrompt.includes('never state it') && freePrompt.includes('讲完一件完整的小事'));
ok('没有 goal 就不写 Scenario goal', !freePrompt.includes('Scenario goal:'));
ok('种子进 prompt', freePrompt.includes('What they mentioned when starting: 今天去爬山了'));

const quiet = buildMessages({
  persona: 'a barista',
  history: [],
  userText: 'Hi',
}).find((m) => m.role === 'system')!.content;
ok('没 beat 就不写 THIS TURN ONLY', !quiet.includes('THIS TURN ONLY'));

console.log('\ntopic()');
const chat = 'oc_g';
eq(
  '单聊键退化成 chatId',
  primaryKey({ chatId: chat, messageId: 'om_1', chatType: 'p2p' }),
  `${chat}:${chat}`
);
ok('单聊不进话题', !replyInThread('p2p'));
ok('群回复落在话题里', replyInThread('group'));
const root = { chatId: chat, messageId: 'om_root', chatType: 'group' };
eq('话题根消息先挂在 messageId 上', primaryKey(root), `${chat}:om_root`);
eq('根消息的锚点是它自己', anchorId(root), 'om_root');
const follow = {
  chatId: chat,
  messageId: 'om_2',
  chatType: 'group',
  threadId: 'omt_1',
  rootId: 'om_root',
};
eq('下一条用 threadId 做主键', primaryKey(follow), `${chat}:omt_1`);
eq(
  '下一条仍能顺着 rootId 找到根消息登记的那场',
  lookupKeys(follow).includes(`${chat}:om_root`) && lookupKeys(follow).includes(`${chat}:omt_1`),
  true
);
const other = { chatId: chat, messageId: 'om_other', chatType: 'group', threadId: 'omt_2' };
ok('两个话题不是同一个键', primaryKey(follow) !== primaryKey(other));
eq('有 root 时锚点是根消息', anchorId(follow), 'om_root');

// 普通群：root_id 是回复链的根，不是话题 id。退回 chatId，否则每说一句新开一场
const plain1 = { chatId: chat, messageId: 'om_a', chatType: 'group', chatMode: 'group' };
const plain2 = { chatId: chat, messageId: 'om_b', chatType: 'group', chatMode: 'group' };
const plainReply = {
  chatId: chat,
  messageId: 'om_c',
  chatType: 'group',
  chatMode: 'group',
  rootId: 'om_a',
};
eq('普通群退回 chatId', primaryKey(plain1), `${chat}:${chat}`);
eq('普通群里两条独立语音是同一场', primaryKey(plain1), primaryKey(plain2));
eq('普通群里回复别人的消息也还是同一场', primaryKey(plainReply), `${chat}:${chat}`);
eq('普通群只有一个查找键', lookupKeys(plainReply), [`${chat}:${chat}`]);
ok(
  '话题群仍然按话题隔离',
  primaryKey({ ...follow, chatMode: 'topic' }) !==
    primaryKey({ ...other, chatMode: 'topic' })
);
ok(
  '群模式查不到时按话题隔离（宁可多分一间）',
  primaryKey({ ...plain1, chatMode: undefined }) !== `${chat}:${chat}`
);
eq(
  '话题富文本里的 1 能读出来',
  plainTextFromPost({
    zh_cn: { title: '', content: [[{ tag: 'text', text: '1' }]] },
  }),
  '1'
);
eq(
  '富文本里的 @ 不算正文',
  plainTextFromPost({
    content: [[{ tag: 'at', user_name: '口语搭子' }, { tag: 'text', text: ' 点单' }]],
  }),
  '点单'
);

console.log('\nmetrics() — 测不出来写 null，不写 0');
const twoWords = [
  { w: 'Could', start: 0, end: 0.4, p: 0.9 },
  { w: 'I', start: 0.4, end: 0.6, p: 0.9 },
];
const flat = metrics(twoWords)!;
eq('没有长停顿，但记录为 null 不是 0', flat.longPausePerMin, null);
eq('没有填充词，也记 null 不是 0', flat.fillerPer100w, null);
eq('语速照常算', flat.wpm, 200);
eq('单轮数词仍然保留', flat.words, 2);
eq('间隙为空', longPauseGaps(twoWords), []);

const gappy = [
  { w: 'Well', start: 0, end: 0.4, p: 0.9 },
  { w: 'um', start: 2.5, end: 2.7, p: 0.9 },
  { w: 'sure', start: 2.7, end: 3.1, p: 0.9 },
];
eq('有真实间隙时能测出来', longPauseGaps(gappy).length, 1);
eq('间隙是 2.1 秒', Math.round(longPauseGaps(gappy)[0]!.gapMs), 2100);
ok('有间隙时长停顿不是 null', metrics(gappy)!.longPausePerMin !== null);
ok('有填充词时填充率不是 null', metrics(gappy)!.fillerPer100w !== null);

console.log('\naggregateMetrics()');
const aggSession = { turns: [{ index: 1, userText: 'x', words: twoWords, reply: { say: 'y', flags: [] } }] } as unknown as Session;
const agg = aggregateMetrics(aggSession);
eq('全轮都没测出停顿 → null', agg.longPausePerMin, null);
eq('全轮都没测出填充 → null', agg.fillerPer100w, null);
eq('语速仍然有值', agg.wpm, 200);

const emptyAgg = aggregateMetrics({ turns: [] } as unknown as Session);
eq('没有轮次时三个都 null', emptyAgg, { wpm: null, longPausePerMin: null, fillerPer100w: null });

console.log('\nbuildWarmupLine()');
const opening = 'Hi! What can I get for you today?';
eq(
  '抽出实词再接开场',
  buildWarmupLine({
    words: [
      { w: 'Could', p: 0.9 },
      { w: 'I', p: 0.9 },
      { w: 'get', p: 0.8 },
      { w: 'a', p: 0.9 },
      { w: 'medium', p: 0.7 },
      { w: 'latte', p: 0.95 },
    ],
    text: 'Could I get a medium latte',
    opening,
  }),
  `Nice, a medium latte. Okay — ${opening}`
);
eq(
  '抽不出来就只说开场',
  buildWarmupLine({ words: [{ w: 'No', p: 0.9 }], text: 'No', opening }),
  `Okay — ${opening}`
);

console.log('\nnextAction()');
eq('打 1 直接开场', nextAction(null, { kind: 'text', alias: true, endCommand: false }), 'start');
eq('打 hi 出菜单', nextAction(null, { kind: 'text', alias: false, endCommand: false }), 'menu');
eq('单聊先发语音出菜单', nextAction(null, { kind: 'audio', alias: false, endCommand: false }), 'audio-menu');
eq(
  '菜单里回 2 选场景',
  nextAction({ ended: false, hasScenario: false, warmupDone: false }, { kind: 'text', alias: true, endCommand: false }),
  'choose'
);
eq(
  '热身前的文字不推进',
  nextAction({ ended: false, hasScenario: true, warmupDone: false }, { kind: 'text', alias: false, endCommand: false }),
  'need-voice'
);
eq(
  '热身是语音',
  nextAction({ ended: false, hasScenario: true, warmupDone: false }, { kind: 'audio', alias: false, endCommand: false }),
  'warmup'
);
eq(
  '热身之后才是正式轮',
  nextAction({ ended: false, hasScenario: true, warmupDone: true }, { kind: 'audio', alias: false, endCommand: false }),
  'turn'
);
eq(
  '结束后不自动重开',
  nextAction({ ended: true, hasScenario: true, warmupDone: true }, { kind: 'audio', alias: false, endCommand: false }),
  'audio-ended'
);
ok('今天去爬山了是种子', isSeedText('今天去爬山了'));
ok('练口语太短，不是种子', !isSeedText('练口语'));
ok('hi 不是种子', !isSeedText('hi'));
eq(
  '一段话直接进自由聊',
  nextAction(null, { kind: 'text', alias: false, endCommand: false, seed: true }),
  'start-seed'
);
eq(
  '菜单发出去之后长句仍然重发菜单',
  nextAction(
    { ended: false, hasScenario: false, warmupDone: false },
    { kind: 'text', alias: false, endCommand: false, seed: true }
  ),
  'repeat-menu'
);
eq('轮次号跳过热身目录', turnIndexFromNames(['000-warmup', '001', '002']), 3);
eq('缺号不回填', turnIndexFromNames(['001', '003']), 4);
eq(
  '结束后打短名才开新的一场',
  nextAction({ ended: true, hasScenario: true, warmupDone: true }, { kind: 'text', alias: true, endCommand: false }),
  'restart'
);

function fakeTurn(index: number, userText: string, reply: Partial<Reply> & { say: string }): Turn {
  return {
    index,
    userText,
    words: [
      { w: 'Could', start: 0, end: 0.3, p: 0.9 },
      { w: 'I', start: 0.3, end: 0.4, p: 0.9 },
    ],
    reply: { flags: [], ...reply },
  };
}

console.log('\nbuildReview()');
const { scenarios } = await loadAll();
const cafe = resolveScenario(scenarios.find((s) => s.id === 'cafe-1')!);
const free = resolveScenario(scenarios.find((s) => s.id === 'free-1')!);
const askBeat = cafe.beats.find((b) => b.atTurn === 3)!;
const mishearBeat = cafe.beats.find((b) => b.atTurn === 2)!;
ok(
  '还没说过 for here / to go，第 3 轮仍然要问',
  activeBeatDirective(askBeat, cafe.blocks, ['Could I get a medium latte'])!.startsWith('Ask whether')
);
ok(
  '已经说过 to go，第 3 轮不再问',
  activeBeatDirective(askBeat, cafe.blocks, ['Could I get a latte', 'to go'])!.includes('Do not ask')
);
ok(
  '听错那一轮不因为点过单就被取消',
  activeBeatDirective(mishearBeat, cafe.blocks, ['Could I get a latte', 'to go'])!.includes('mishear')
);
const mediumOrder = activeBeatDirective(mishearBeat, cafe.blocks, [
  'Could I get a medium Americano?',
  'to go',
]);
ok(
  '听错点名把 medium 换成 large',
  !!mediumOrder?.includes('Change only the word "medium" to "large"')
);
const largeOrder = activeBeatDirective(mishearBeat, cafe.blocks, [
  'Could I get a large iced coffee?',
]);
ok(
  '听错优先换杯型，不换冷热',
  !!largeOrder?.includes('Change only the word "large" to "medium"') &&
    !largeOrder.includes('"iced"')
);
ok(
  '问 for here 的指令不追加换词',
  !activeBeatDirective(askBeat, cafe.blocks, ['Could I get a medium latte'])!.includes('Change only')
);

const dir = await mkdtemp(join(tmpdir(), 'sb-review-'));
/** 判分要联网，本地自检只喂现成的判定结果 —— buildPostmortem/renderCard 都是纯函数 */
const graded = (turns: { turn: number; verdict: 'ok' | 'unnatural' | 'wrong' | 'unclear'; said?: string; fix?: string; better?: string; why?: string; note?: string; form?: 'full' | 'fragment' }[]) => ({
  sentences: turns.map((t) => ({ form: 'full' as const, ...t })),
  drills: [],
});

try {
  const session = await createSession('oc_test', cafe, { dir, listTitle: '点单 · 店员会听错一次' });
  const meta = (await readMeta(dir)) as { scenarioId: string | null };
  eq('meta.scenarioId 是 cafe-1', meta.scenarioId, 'cafe-1');

  session.warmup = fakeTurn(0, 'Could I get a medium latte', { say: 'Nice, a medium latte.' });
  session.turns = [fakeTurn(1, 'No.', { say: "Got it. That's $3.25" })];
  const card = renderCard(session, buildPostmortem(session, graded([
    { turn: 0, verdict: 'ok' },
    { turn: 1, verdict: 'ok' },
  ])));
  ok('1 号块算上热身', card.includes('1 ✓'));
  ok('还没问到的块是 —', card.includes('2 —') && card.includes('3 —'));
  ok('不把没轮到写成 ✗', !card.includes('2 ✗') && !card.includes('3 ✗'));
  ok('卡片不印语速', !card.includes('wpm') && !card.includes('语速'));
  ok('卡片不出现 bot 的台词', !card.includes("Got it. That's $3.25"));
  ok('卡片不出现隐藏目标字段名', !card.includes('hiddenGoal'));

  // 四档 + 逐句都要出现
  const withMarks = await createSession('oc_test', cafe, {
    dir: join(dir, 'rw'),
    listTitle: '点单 · 店员会听错一次',
  });
  withMarks.warmupDone = true;
  withMarks.turns = [
    fakeTurn(1, 'I want to enlarge the iced Americano', { say: 'One large?' }),
    fakeTurn(2, 'A regular ice tea is better for me', { say: 'Ok.' }),
    fakeTurn(3, 'Do you have some coupons?', { say: 'No.' }),
    fakeTurn(4, 'For here', { say: 'Got it.' }),
  ];
  const card2 = renderCard(
    withMarks,
    buildPostmortem(withMarks, {
      sentences: [
        { turn: 1, form: 'full', verdict: 'unnatural', said: 'enlarge the', fix: 'a large', better: 'Could I get a large iced Americano?', why: '点单不说 enlarge' },
        { turn: 2, form: 'full', verdict: 'unclear', said: 'ice', why: '这个词没听清' },
        { turn: 3, form: 'full', verdict: 'wrong', said: 'some', fix: 'any', better: 'Do you have any coupons?', why: '疑问句用 any' },
        { turn: 4, form: 'full', verdict: 'ok' },
      ],
      drills: ['Do you have any ___ ? — 疑问句用 any'],
    })
  );
  ok('不地道给整句改写', card2.includes('~') && card2.includes('Could I get a large iced Americano?'));
  ok('没听清明确说不判', card2.includes('?') && card2.includes('这次不判'));
  ok('要改指出具体片段', card2.includes('some → any'));
  ok('没问题也逐句列出', card2.includes('For here'));
  ok('四档都计数', card2.includes('✓ 1 句没问题') && card2.includes('✗ 1 句要改'));
  ok('练习项来自本场', card2.includes('下次先练这组') && card2.includes('any'));

  // 判分整场挂掉也要出卡片
  const broken = renderCard(session, buildPostmortem(session, { sentences: [], drills: [] }));
  ok('判分失败仍出卡片', broken.includes('没判出来'));

  const freeSession: Session = await createSession('oc_test', free, {
    dir: join(dir, 'free'),
    listTitle: '自由聊 · 随便说，我接住',
  });
  freeSession.turns = [fakeTurn(1, 'I went hiking', { say: 'How long did you walk?' })];
  const freeCard = renderCard(
    freeSession,
    buildPostmortem(freeSession, graded([{ turn: 1, verdict: 'ok' }]))
  );
  ok('rewrite 卡片不显示块使用', !freeCard.includes('三句用了'));
  ok('隐藏目标不上卡片', free.hiddenGoal ? !freeCard.includes(free.hiddenGoal) : true);

  const freeMeta = (await readMeta(join(dir, 'free'))) as { scenarioId: string | null };
  eq('meta.scenarioId 能切到 free-1', freeMeta.scenarioId, 'free-1');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('\nrestoreOpenSessions()');
const scratch = await mkdtemp(join(tmpdir(), 'sb-restore-'));
try {
  const openDir = join(scratch, '2026-10-25', '20261025-0000-open');
  await mkdir(join(openDir, 'turns', '001'), { recursive: true });
  await mkdir(join(openDir, 'turns', '000-warmup'), { recursive: true });
  const meta = {
    sessionId: '20261025-0000-open',
    chatId: 'oc_r',
    threadId: 'omt_r',
    rootId: 'om_r',
    sessionKey: 'oc_r:omt_r',
    anchorMessageId: 'om_r',
    rootText: '1',
    scenarioId: 'cafe-1',
    scenarioTitle: '点单，店员听错了一次',
    seedText: null,
    startedAt: '2026-10-25T00:00:00.000Z',
    endedAt: null,
    endReason: null,
    turnCount: 1,
    warmupDone: true,
    menuSent: false,
    blockUsage: null,
  };
  await writeFile(join(openDir, 'meta.json'), JSON.stringify(meta));
  await writeFile(
    join(openDir, 'turns', '000-warmup', 'asr.json'),
    JSON.stringify({ text: 'Could I get a medium latte', words: [] })
  );
  await writeFile(
    join(openDir, 'turns', '000-warmup', 'llm.json'),
    JSON.stringify({ say: 'Nice, a medium latte.', flags: [] })
  );
  await writeFile(
    join(openDir, 'turns', '001', 'asr.json'),
    JSON.stringify({ text: 'to go', words: [{ w: 'to', start: 0, end: 0.2, p: 0.9 }] })
  );
  await writeFile(
    join(openDir, 'turns', '001', 'llm.json'),
    JSON.stringify({ say: 'Large latte to go.', flags: [] })
  );
  const endedDir = join(scratch, '2026-10-25', '20261025-0000-end');
  await mkdir(endedDir, { recursive: true });
  await writeFile(join(endedDir, 'meta.json'), JSON.stringify({ ...meta, sessionId: 'ended', endedAt: '2026-10-25T01:00:00.000Z' }));
  await writeFile(join(scratch, '2026-10-25', 'junk.json'), '{');
  const oldDir = join(scratch, '2026-10-25', 'old');
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'meta.json'), JSON.stringify({ sessionId: 'old', chatId: 'oc_r' }));

  const { open: found, orphaned } = await restoreOpenSessions(scratch, (id) =>
    id === 'cafe-1'
      ? { kind: 'ok', scenario: cafe, listTitle: '点单 · 店员会听错一次' }
      : { kind: 'missing', scenarioId: id }
  );
  eq('只恢复未结束的一场', found.map((s) => s.id), ['20261025-0000-open']);
  eq('轮次从盘上读回来', found[0]?.turns.map((t) => t.userText), ['to go']);
  eq('热身也读回来', found[0]?.warmup?.userText, 'Could I get a medium latte');
  eq('场景接回来', found[0]?.scenario?.id, 'cafe-1');
  eq('空目录的下一轮是 2', await nextTurnIndex(openDir), 2);

  // 场景文件不在了：不恢复，但要留下能通知用户的记录，不能静默
  const missingDir = join(scratch, '2026-10-25', '20261025-0000-gone');
  await mkdir(join(missingDir, 'turns'), { recursive: true });
  await writeFile(
    join(missingDir, 'meta.json'),
    JSON.stringify({ ...meta, sessionId: '20261025-0000-gone', scenarioId: 'retired-1', scenarioTitle: '退货' })
  );
  // 只让 retired-1 缺失，cafe-1 正常，这样这个用例只测「缺失」这一件事
  const gone = await restoreOpenSessions(scratch, (id) =>
    id === 'cafe-1'
      ? { kind: 'ok', scenario: cafe, listTitle: '点单' }
      : { kind: 'missing', scenarioId: id }
  );
  eq('只把场景缺失的那场挑出来', gone.orphaned.map((o) => o.sessionId), ['20261025-0000-gone']);
  eq('场景文件没了就不恢复它', gone.open.map((s) => s.id), ['20261025-0000-open']);
  eq('但要记下来通知谁', gone.orphaned.map((o) => o.chatId), [meta.chatId]);
  eq('通知要用锚点消息', gone.orphaned[0]?.anchorMessageId, 'om_r');
  eq('通知要带上场景名', gone.orphaned[0]?.scenarioTitle, '退货');

  // 场景只是校验没过：照常恢复，配置里的错不能吃掉用户的练习
  const degraded = await restoreOpenSessions(scratch, (id) =>
    id === 'cafe-1'
      ? { kind: 'degraded', scenario: cafe, listTitle: '点单', problem: '块数必须为 3' }
      : { kind: 'missing', scenarioId: id }
  );
  eq('校验没过的场景仍然恢复', degraded.open.map((s) => s.id), ['20261025-0000-open']);
  eq('恢复后场景仍然可用', degraded.open[0]?.scenario?.id, 'cafe-1');
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n❌ ${failed} 条失败\n` : '\n✅ 全部通过\n');
process.exit(failed ? 1 : 0);
