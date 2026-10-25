/**
 * 场景配置自检：加载 + 校验 + 选题路由 + 菜单渲染。
 *
 * 跑法：pnpm check:scenarios
 * 依赖 config/scenarios/ 下的真实文件，不依赖网络和飞书。
 */

import {
  loadAll,
  loadIndex,
  renderMenu,
  renderScenarioCard,
  resolveByAlias,
  resolveScenario,
  validateScenario,
  type ScenarioDef,
} from '../src/scenarios.js';
import { matchesBlock } from '../src/blocks.js';

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

// ────────────────────────────────────────────────────────────
console.log('\n配置文件本身');
const { scenarios, problems } = await loadAll();
eq('没有校验问题', problems, {});
eq('场景数', scenarios.length, 2);
ok('cafe-1 在', scenarios.some((s) => s.id === 'cafe-1'));
ok('free-1 在', scenarios.some((s) => s.id === 'free-1'));

const cafe = scenarios.find((s) => s.id === 'cafe-1')!;
const free = scenarios.find((s) => s.id === 'free-1')!;
eq('cafe-1 卡片样式', cafe.cardStyle, 'blocks');
eq('free-1 卡片样式', free.cardStyle, 'rewrite');
eq('cafe-1 有 goal', typeof cafe.goal, 'string');
eq('free-1 没有 goal', free.goal, undefined);
eq('free-1 有 hiddenGoal', typeof free.hiddenGoal, 'string');
eq('free-1 没 beats', free.beats.length, 0);
eq('听错指向 3 号块', cafe.beats.find((b) => b.atTurn === 2)?.forBlock, 3);
eq('for here 指向 2 号块', cafe.beats.find((b) => b.atTurn === 3)?.forBlock, 2);

// ────────────────────────────────────────────────────────────
console.log('\nvalidateScenario() — 挡得住坏配置');
const clone = (s: ScenarioDef): ScenarioDef => JSON.parse(JSON.stringify(s));

ok('块数 4 → 报错', validateScenario({ ...clone(cafe), blocks: [...cafe.blocks, cafe.blocks[0]!] }).some((p) => p.includes('块数必须为 3')));
ok('块数 2 → 报错', validateScenario({ ...clone(cafe), blocks: cafe.blocks.slice(0, 2) }).some((p) => p.includes('块数必须为 3')));

const noSlot = clone(cafe);
noSlot.blocks[0] = { n: 1, frame: 'For here, please.' };
ok('既无槽又无替换 → 报错', validateScenario(noSlot).some((p) => p.includes('既没有槽位也没有替换项')));
ok('无槽但有替换 → 通过（For here / To go 这类固定句）', validateScenario(cafe).every((p) => !p.includes('既没有槽位')));

const tooLong = clone(cafe);
tooLong.blocks[0] = { n: 1, frame: 'Could I possibly ask you to get me a ___ ?' };
ok('拆槽后超 8 词 → 报错', validateScenario(tooLong).some((p) => p.includes('超过 A2 的 8 词上限')));

const slang = clone(cafe);
slang.blocks[0] = { n: 1, frame: "I'm kinda in the mood for a ___ ." };
ok('kinda → 报错', validateScenario(slang).some((p) => p.includes('kinda')));

const noFriction = clone(cafe);
noFriction.beats = [{ atTurn: 2, need: '闲聊', directive: 'Ask how their day is going.' }];
ok('beats 无摩擦 → 报错', validateScenario(noFriction).some((p) => p.includes('摩擦动作')));

const lateBeat = clone(cafe);
lateBeat.beats = [{ atTurn: 5, need: 'x', directive: 'mishear the order' }];
ok('atTurn=5 → 报错', validateScenario(lateBeat).some((p) => p.includes('太靠后')));

const badBlock = clone(cafe);
badBlock.beats = [{ atTurn: 2, forBlock: 9, need: 'x', directive: 'mishear the size' }];
ok('forBlock 指向不存在的块 → 报错', validateScenario(badBlock).some((p) => p.includes('forBlock')));

const noGoal = clone(free);
delete noGoal.hiddenGoal;
ok('既无 goal 也无 hiddenGoal → 报错', validateScenario(noGoal).some((p) => p.includes('塌缩')));

const emptyMatch = clone(cafe);
emptyMatch.blocks[0] = { n: 1, frame: '___ , please.' };
ok('派生为空 → 报错', validateScenario(emptyMatch).some((p) => p.includes('派生不出可匹配片段')));

// ────────────────────────────────────────────────────────────
console.log('\nresolveScenario() — match 派生，不读配置里的手写值');
const resolved = resolveScenario(cafe);
ok('块 1 派生非空', (resolved.blocks[0]!.patterns.length ?? 0) > 0);
ok("块 1 含 'could i get a'", resolved.blocks[0]!.patterns.includes('could i get a'));
ok("块 1 含同义说法 'i would like a'", resolved.blocks[0]!.patterns.includes('i would like a'));
ok("块 3 含 'i meant'", resolved.blocks[2]!.patterns.includes('i meant'));

const withFakeMatch = resolveScenario({
  ...clone(cafe),
  blocks: [{ n: 1, frame: 'Could I get a ___ ?', match: ['手写的这一句'] }, ...cafe.blocks.slice(1)],
});
eq('显式 match 覆盖派生', withFakeMatch.blocks[0]!.patterns, ['手写的这一句']);

// ────────────────────────────────────────────────────────────
console.log('\nmatchesBlock() 用真实配置');
const b1 = resolved.blocks[0]!;
ok('could i get a medium latte 命中', matchesBlock(b1, 'could i get a medium latte'));
ok('i would like a latte 命中', matchesBlock(b1, 'i would like a latte'));
ok('no 不命中', !matchesBlock(b1, 'no'));
ok('块 2 的 to go 命中', matchesBlock(resolved.blocks[1]!, 'to go please'));
ok('块 3 的 i wanted 命中', matchesBlock(resolved.blocks[2]!, 'sorry i wanted a medium'));

// ────────────────────────────────────────────────────────────
console.log('\n选题路由（§2.1 第 0 层）');
const index = await loadIndex();
eq('打 1 → cafe-1', resolveByAlias('1', index), 'cafe-1');
eq('打 2 → free-1', resolveByAlias('2', index), 'free-1');
eq('打「点单」→ cafe-1', resolveByAlias('点单', index), 'cafe-1');
eq('打「点餐」→ cafe-1', resolveByAlias('点餐', index), 'cafe-1');
eq('打「点单。」（中文标点）→ cafe-1', resolveByAlias('点单。', index), 'cafe-1');
eq('打「自由聊」→ free-1', resolveByAlias('自由聊', index), 'free-1');
eq('打 hi → null（发菜单）', resolveByAlias('hi', index), null);
eq('打「我不想点单」→ null（不做包含匹配）', resolveByAlias('我不想点单', index), null);
eq('打空 → null', resolveByAlias('   ', index), null);
eq('打「今天去爬山了」→ null（走种子分支）', resolveByAlias('今天去爬山了', index), null);

// ────────────────────────────────────────────────────────────
console.log('\nrenderMenu()');
const menu = renderMenu(index);
ok('菜单不含未实现的场景条目', menu.split('\n').filter((l) => /^\d/.test(l)).length === index.length);
ok('菜单提示含场景名', menu.includes('打个场景名'));
console.log('\n' + menu.split('\n').map((l) => '  ' + l).join('\n'));

console.log('\nrenderScenarioCard()');
const cafeCard = renderScenarioCard(resolveScenario(cafe), {
  title: index.find((e) => e.id === 'cafe-1')?.title,
});
ok('三句卡有 1 号句', cafeCard.includes('Could I get a ___ ?'));
ok('三句卡有例子', cafeCard.includes('Could I get a medium latte?'));
ok('三句卡有替换', cafeCard.includes('也可以换：'));
ok('固定句用「或者」', cafeCard.includes('或者：'));
ok('热身要求用 1 号句', cafeCard.includes('先用 1 号句造一句'));
ok('三句卡不漏 hiddenGoal', !cafeCard.includes('hiddenGoal'));

const freeCard = renderScenarioCard(resolveScenario(free), { title: '自由聊' });
ok('自由聊热身不要求念 1 号句', freeCard.includes('随便说一句你今天做了什么'));
ok('自由聊卡不含隐藏目标', free.hiddenGoal ? !freeCard.includes(free.hiddenGoal) : true);
const seeded = renderScenarioCard(resolveScenario(free), { title: '自由聊', seedText: '今天去爬山了' });
ok('有种子时热身改口', seeded.includes('用英文说一句你今天干嘛了'));

// ────────────────────────────────────────────────────────────
console.log(failed ? `\n❌ ${failed} 条失败\n` : '\n✅ 全部通过\n');
process.exit(failed ? 1 : 0);
