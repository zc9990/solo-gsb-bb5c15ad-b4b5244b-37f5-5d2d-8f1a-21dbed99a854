'use strict';

/* 现场盘点引擎单元测试：node test/stocktake.test.js */

const assert = require('assert');
const { stocktake, CATEGORY } = require('../src/stocktake');
const { WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const byName = (out, name) => out.entries.find((e) => e.propName === name);

// 1. 只重放盘点分钟及以前：第 3 分钟时账面为李四（第 8 分钟的交接尚未发生）
test('截断到盘点分钟：较晚交接不影响账面持有人', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
    rec('p0', 8, '李四', WAREHOUSE),
  ]);
  const out = stocktake(data, 3, [{ name: '剑', holder: '李四' }]);
  assert.strictEqual(byName(out, '剑').category, CATEGORY.MATCH);
  assert.strictEqual(byName(out, '剑').bookHolder, '李四');
});

// 2. 同分钟链式交接（A→B、B→C）全部完成后再取账面持有人
test('盘点分钟内所有交接完成后取账面持有人', () => {
  const data = mkData(['枪'], [
    rec('p0', 5, WAREHOUSE, '甲'),
    rec('p0', 5, '甲', '乙'),
    rec('p0', 5, '乙', '丙'),
  ]);
  const out = stocktake(data, 5, [{ name: '枪', holder: '丙' }]);
  assert.strictEqual(byName(out, '枪').category, CATEGORY.MATCH);
  assert.strictEqual(byName(out, '枪').bookHolder, '丙');
});

// 3. 实物持有人与账面不符
test('持有人不符 -> MISMATCH 且附账面持有人', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三')]);
  const out = stocktake(data, 2, [{ name: '剑', holder: '李四' }]);
  const e = byName(out, '剑');
  assert.strictEqual(e.category, CATEGORY.MISMATCH);
  assert.strictEqual(e.bookHolder, '张三');
});

// 4. 盘点行重名：每次出现单列为重复录入，不以后项覆盖
test('重名行各自单列 -> DUPLICATE，保留各行实物持有人', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三')]);
  const out = stocktake(data, 1, [
    { name: '剑', holder: '张三' },
    { name: '剑', holder: '李四' },
  ]);
  const dups = out.entries.filter((e) => e.category === CATEGORY.DUPLICATE);
  assert.strictEqual(dups.length, 2);
  assert.deepStrictEqual(dups.map((e) => e.actualHolder), ['张三', '李四']);
  assert.deepStrictEqual(dups.map((e) => e.duplicate.index), [1, 2]);
  assert.strictEqual(dups[0].duplicate.total, 2);
  assert.strictEqual(byName(out, '剑').bookHolder, '张三'); // 账面仍可附带参考
});

// 5. 未登记名称 -> 账外
test('未登记名称 -> OFF_BOOK', () => {
  const data = mkData(['剑'], []);
  const out = stocktake(data, 0, [
    { name: '剑', holder: WAREHOUSE },
    { name: '火箭筒', holder: '王五' },
  ]);
  assert.strictEqual(byName(out, '火箭筒').category, CATEGORY.OFF_BOOK);
  assert.strictEqual(byName(out, '火箭筒').registered, false);
});

// 6. 未填的已登记道具 -> 未盘
test('未填写的已登记道具 -> NOT_COUNTED', () => {
  const data = mkData(['剑', '扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p1', 1, WAREHOUSE, '李四'),
  ]);
  const out = stocktake(data, 2, [{ name: '剑', holder: '张三' }]);
  const fan = byName(out, '扇');
  assert.strictEqual(fan.category, CATEGORY.NOT_COUNTED);
  assert.strictEqual(fan.actualHolder, null);
  assert.strictEqual(fan.bookHolder, '李四');
});

// 7. 此前交接链冲突 -> 无法判定（多条可接续）
test('盘点分钟及以前出现歧义冲突 -> UNDETERMINED', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'),
  ]);
  const out = stocktake(data, 6, [{ name: '扇', holder: '王五' }]);
  const e = byName(out, '扇');
  assert.strictEqual(e.category, CATEGORY.UNDETERMINED);
  assert.ok(e.conflict);
});

// 7b. 断链冲突 -> 无法判定
test('盘点分钟及以前出现断链冲突 -> UNDETERMINED', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五'),
    rec('p0', 4, '李四', '钱七'),
  ]);
  const out = stocktake(data, 4, [{ name: '灯', holder: '王五' }]);
  assert.strictEqual(byName(out, '灯').category, CATEGORY.UNDETERMINED);
});

// 8. 关键：较晚分钟的冲突不影响本次盘点
test('盘点分钟之后的冲突被忽略', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'), // 第 5 分钟歧义
  ]);
  const out = stocktake(data, 3, [{ name: '扇', holder: '张三' }]);
  const e = byName(out, '扇');
  assert.strictEqual(e.category, CATEGORY.MATCH);
  assert.strictEqual(e.bookHolder, '张三');
  assert.strictEqual(e.conflict, null);
});

// 9. 此前无记录的道具，账面持有人恒为仓库
test('截断后无记录 -> 账面持有人为仓库', () => {
  const data = mkData(['剑'], [rec('p0', 5, WAREHOUSE, '张三')]);
  const out = stocktake(data, 4, [{ name: '剑', holder: WAREHOUSE }]);
  assert.strictEqual(byName(out, '剑').category, CATEGORY.MATCH);
  assert.strictEqual(byName(out, '剑').bookHolder, WAREHOUSE);
});

// 10. 汇总计数与 hasDifference
test('summary 分类计数正确', () => {
  const data = mkData(['好', '坏', '缺', '齐'], [
    rec('p0', 1, WAREHOUSE, '甲'),
    rec('p1', 1, WAREHOUSE, '乙'),
    rec('p3', 1, WAREHOUSE, '甲'),
  ]);
  const out = stocktake(data, 2, [
    { name: '好', holder: '甲' },           // MATCH
    { name: '坏', holder: '丙' },           // MISMATCH
    { name: '不存在', holder: '丁' },        // OFF_BOOK
    { name: '齐', holder: '甲' },           // DUPLICATE x2
    { name: '齐', holder: '甲' },
  ]);
  const s = out.summary;
  assert.strictEqual(s.match, 1);
  assert.strictEqual(s.mismatch, 1);
  assert.strictEqual(s.offBook, 1);
  assert.strictEqual(s.duplicate, 2);
  assert.strictEqual(s.notCounted, 1); // 缺
  assert.strictEqual(s.undetermined, 0);
  assert.strictEqual(s.hasDifference, true);
});

// 11. 行号按录入顺序保留；未盘道具排在行结论之后
test('行号与排序：盘点行在前，未盘在后', () => {
  const data = mkData(['B', 'A'], [rec('p0', 1, WAREHOUSE, '甲')]);
  const out = stocktake(data, 2, [{ name: 'A', holder: WAREHOUSE }]);
  assert.strictEqual(out.entries[0].line, 1);
  assert.strictEqual(out.entries[0].propName, 'A');
  assert.strictEqual(out.entries[1].propName, 'B');
  assert.strictEqual(out.entries[1].line, null);
});

// 12. 重名且未登记：仍列重复录入，并标记 registered=false
test('未登记名称重名 -> DUPLICATE 且 registered=false', () => {
  const data = mkData(['剑'], []);
  const out = stocktake(data, 0, [
    { name: '伞', holder: '甲' },
    { name: '伞', holder: '乙' },
  ]);
  const dups = out.entries.filter((e) => e.propName === '伞');
  assert.strictEqual(dups.length, 2);
  assert.ok(dups.every((e) => e.category === CATEGORY.DUPLICATE && e.registered === false));
});

// 13. 盘点不改写输入数据
test('盘点是只读计算，不修改 props/records', () => {
  const data = mkData(['剑'], [rec('p0', 0, WAREHOUSE, '张三')]);
  const snapshot = JSON.stringify(data);
  stocktake(data, 0, [{ name: '剑', holder: '李四' }]);
  assert.strictEqual(JSON.stringify(data), snapshot);
});

console.log(`\n全部 ${passed} 个测试通过 ✔`);
