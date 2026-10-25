/**
 * 纯函数自检：deriveMatch / matchesBlock / computeBlockUsage。
 *
 * 跑法：pnpm check:blocks
 * 不联网、不读数据库，输入全是硬编码的真实案例（acf8 那 6 轮 + cafe-1 的三块）。
 */

import {
  assignNotReached,
  computeBlockUsage,
  deriveMatch,
  findGenericFrames,
  frameSkeleton,
  matchesBlock,
  norm,
  validateBlocks,
} from '../src/blocks.js';

let failed = 0;
const eq = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n     实际 ${a}\n     期望 ${e}`);
  }
};
const ok = (name: string, cond: boolean) => eq(name, cond, true);

// ────────────────────────────────────────────────────────────
console.log('\nnorm()');
eq('标点去掉、小写', norm('Sorry,  I meant Oat Milk!'), 'sorry i meant oat milk');
eq('弯引号归一', norm('I’d like'), norm("I'd like"));
eq('中文保留（§2.1 的别名依赖这一条）', norm('我想点单'), '我想点单');
eq('中文含标点', norm('点单。'), '点单');
eq('全空', norm('  !!  '), '');

// ────────────────────────────────────────────────────────────
console.log('\nderiveMatch()');
const block1ForValidation = { n: 1, frame: 'Could I get a ___ ?' };
const cafe1 = deriveMatch('Could I get a ___ ?');
ok('cafe-1 块 1 派生非空', cafe1.length > 0);
ok("包含 'could i get a'", cafe1.includes('could i get a'));
ok('不包含单令牌片段', cafe1.every((p) => p.split(' ').length >= 2));

const clarify = deriveMatch('Sorry, I meant ___ .', ['Sorry, I wanted ___ .']);
ok("带标点的 frame 也派生出 'i meant'", clarify.includes('i meant'));
ok('前导 sorry 的两种写法都在', clarify.includes('sorry i meant') && clarify.includes('i meant'));
ok("同义说法 'i wanted' 在", clarify.includes('i wanted'));

const aid = deriveMatch("I'd like a ___ , please.");
ok("缩写展开成 'i would like a'", aid.includes('i would like a'));
ok("原写法也在", aid.includes("i'd like a"));

// 双槽位：中间那个单令牌片段不能单独成为模式
const doubleSlot = deriveMatch('Could I get a ___ with ___ ?');
ok('双槽位不产生 "with"', !doubleSlot.includes('with'));
ok("双槽位仍保留 'could i get a'", doubleSlot.includes('could i get a'));

// 全是单令牌的退化情况：派生出空 → 交给 validateBlocks 报错，而不是静默永远不命中
eq('退化情况派生为空', deriveMatch('___ please'), []);
eq(
  'validateBlocks 能报出退化块',
  validateBlocks([{ n: 1, frame: '___ please' }]).length,
  1
);
eq('validateBlocks 对正常块不报错', validateBlocks([block1ForValidation]), []);
eq(
  'validateBlocks 报块号重复',
  validateBlocks([
    { n: 1, frame: 'Could I get a ___ ?' },
    { n: 1, frame: 'For here, please.' },
  ])[0]?.problem,
  '块号重复'
);

// ────────────────────────────────────────────────────────────
console.log('\nmatchesBlock() — acf8 六轮真实转写');
const block1 = { n: 1, frame: 'Could I get a ___ ?' };
const block2 = { n: 2, frame: 'For here, please.', alternatives: ['To go, please.'] };
const block3 = { n: 3, frame: 'Sorry, I meant ___ .', alternatives: ['Sorry, I wanted ___ .'] };

// 「could i get a medium as americano」——whisper 输出，无标点
ok('块 1 命中', matchesBlock(block1, 'could i get a medium as americano'));
ok('大小写无关', matchesBlock(block1, 'Could I Get A medium latte'));
ok('can i get 不算块 1 的 frame（未给同义说法）', !matchesBlock(block1, 'can i get a latte'));
ok(
  '给了同义说法后 can i get 命中',
  matchesBlock({ n: 1, frame: 'Could I get a ___ ?', alternatives: ['Can I get a ___ ?'] }, 'can i get a latte')
);
ok('块 2 命中 for here', matchesBlock(block2, 'for here please'));
ok('块 2 命中 to go', matchesBlock(block2, 'to go'));
ok('块 2 前导无 sorry 也命中', matchesBlock({ n: 2, frame: 'Sorry, for here.' }, 'for here'));
ok('块 3 命中 i meant', matchesBlock(block3, 'sorry i meant oat milk not soy'));
ok('块 3 命中 i wanted', matchesBlock(block3, 'sorry i wanted a medium'));

// 必须不能命中的
ok('❌ "No." 不命中任何块', ![block1, block2, block3].some((b) => matchesBlock(b, 'no')));
ok('❌ "Cash, please." 不命中块 2', !matchesBlock(block2, 'cash please'));
ok('❌ 空转写不命中', !matchesBlock(block2, ''));
ok('❌ 片段不能脱离上下文乱命中（只有 meant）', !matchesBlock(block3, 'that meant a lot to me'));

// 子串不能误命中：'could i get' 不该被 'could i gotten' 命中
ok('❌ 词边界正确', !matchesBlock(block1, 'could i gotten a latte'));

// 显式 match 的逃生口优先
ok(
  '显式 match 优先',
  matchesBlock({ n: 9, frame: '完全不同的句子', match: ['i meant'] }, 'sorry i meant it')
);

// 空 match 不能全命中
ok('❌ 派生为空时不命中', !matchesBlock({ n: 9, frame: '' }, '任何内容 any content'));

// ────────────────────────────────────────────────────────────
console.log('\ncomputeBlockUsage() — 含热身轮');
const usage = computeBlockUsage([block1, block2, block3], [
  'Could I get a medium latte', // ← 热身轮
  'No',
  'Tom',
  'What is the main pay at the register',
  'Cash, please',
  'Okay, here we go',
]);
eq('块 1 来自热身轮 → used', usage['1'], 'used');
eq('块 2 没用到 → unused', usage['2'], 'unused');
eq('块 3 没用到 → unused', usage['3'], 'unused');

const usage2 = computeBlockUsage(
  [{ ...block1, alternatives: ['I would like a ___ .'] }, block2, block3],
  [
  'i would like a medium latte',
  'for here',
  'sorry i meant oat milk',
  ]
);
eq('三块全中', usage2, { '1': 'used', '2': 'used', '3': 'used' });

// i'd like 是块 1 的常见替代说法，但 frame 里没有它 → 不该命中
const usage3 = computeBlockUsage([block1], ["I'd like a latte"]);
eq("i'd like 不在 frame 里 → 不命中（同义说法要显式给）", usage3['1'], 'unused');
const usage4 = computeBlockUsage(
  [{ n: 1, frame: 'I’d like a ___ .', alternatives: ['I would like a ___ .'] }],
  ['i would like a latte']
);
eq('同义说法命中', usage4['1'], 'used');

// ────────────────────────────────────────────────────────────
console.log('\nfindGenericFrames() — 通用句型库识别');

// 骨架几乎一样、只换名词 → 应被标记
const genericHit = findGenericFrames([
  { id: 'a', blocks: [{ n: 1, frame: 'Could I have a ___ seat, please?' }] },
  { id: 'b', blocks: [{ n: 1, frame: 'Could I have a ___ room, please?' }] },
]);
eq('换名词的同一公式被标记', genericHit.length, 1);
// 骨架 could i have a _ seat please = 7 词；只差 seat/room 一个 → 6/7 = 0.86
eq('重合度 0.86（只差一个名词）', genericHit[0]?.overlap, 0.86);
eq('标记的是两块', [genericHit[0]?.a, genericHit[0]?.b], ['a#1', 'b#1']);

// 内容词完全不同 → 不应标记
eq(
  '不同任务的块不标记',
  findGenericFrames([
    { id: 'a', blocks: [{ n: 1, frame: 'My flight number is ___ .' }] },
    { id: 'b', blocks: [{ n: 1, frame: 'Sorry, I meant ___ .' }] },
  ]),
  []
);

// 同场景内部不比较
eq(
  '同场景内不比较',
  findGenericFrames([
    { id: 'a', blocks: [
      { n: 1, frame: 'Could I have a ___ seat?' },
      { n: 2, frame: 'Could I have a ___ room?' },
    ] },
  ]),
  []
);

// 空块 / 纯功能词 → 不制造假阳性
eq(
  '功能词占满的块不产生重合',
  findGenericFrames([
    { id: 'a', blocks: [{ n: 1, frame: 'Could I ___ please?' }] },
    { id: 'b', blocks: [{ n: 1, frame: 'Can I ___ please?' }] },
  ]),
  []
);

console.log('\nassignNotReached() — 还没轮到的块不是 ✗');
const usedUnused = { '1': 'used' as const, '2': 'unused' as const, '3': 'unused' as const };
const cafeBeats = [
  { atTurn: 2, forBlock: 3 },
  { atTurn: 3, forBlock: 2 },
];
eq('只有热身：2 和 3 都还没轮到', assignNotReached(usedUnused, cafeBeats, 0), {
  '1': 'used',
  '2': 'not_reached',
  '3': 'not_reached',
});
eq('正式 2 轮：听错已经发生，但用户还没机会澄清；for here 还没问', assignNotReached(usedUnused, cafeBeats, 2), {
  '1': 'used',
  '2': 'not_reached',
  '3': 'not_reached',
});
eq('正式 3 轮：澄清的机会到了，for here 的回答还没有', assignNotReached(usedUnused, cafeBeats, 3), {
  '1': 'used',
  '2': 'not_reached',
  '3': 'unused',
});
eq('正式 4 轮：两块都问过了，没用就是 ✗', assignNotReached(usedUnused, cafeBeats, 4), {
  '1': 'used',
  '2': 'unused',
  '3': 'unused',
});
eq('提前用了的块保持 used', assignNotReached({ '1': 'used', '2': 'used', '3': 'unused' }, cafeBeats, 0), {
  '1': 'used',
  '2': 'used',
  '3': 'not_reached',
});

console.log('\nframeSkeleton()');
eq(
  '槽位归一成 _',
  frameSkeleton('Could I get a ___ ?'),
  'could i get a _'
);
eq('两个槽位都归一', frameSkeleton('___ and ___'), '_ and _');

// ────────────────────────────────────────────────────────────
console.log(failed ? `\n❌ ${failed} 条失败\n` : '\n✅ 全部通过\n');
process.exit(failed ? 1 : 0);
