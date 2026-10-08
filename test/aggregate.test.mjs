/**
 * 周期聚合引擎单测 —— 零依赖
 *   node --test test/aggregate.test.mjs
 *
 * 这些用例不需要网络: server.js 被 require 时不自动 listen(见文件末尾 require.main 守卫),
 * 因此 aggregateBars / bucketStart 可以当纯函数直接测。
 *
 * 守的核心: 长周期(周/月/季/年)是从低周期真实聚合出来的, 一旦算错就是"看起来合法的假数据",
 * 比报错更危险 —— 所以边界、取值口径、排序都要钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { aggregateBars, bucketStart, sanitizeBars } = require('../server.js');

/* 北京时间 HH:MM 的当天零点时间戳 */
const SH = 8 * 3600 * 1000;
const day = (y, m, d) => Date.UTC(y, m - 1, d) - SH;
const iso = (t) => new Date(t + SH).toISOString().slice(0, 10);

const bar = (t, o, h, l, c, v = 1) => ({ t, o, h, l, c, v });

test('1. bucketStart: 边界必须落在日历起点 (北京时间口径)', () => {
  // 2024-03-04 是周一
  assert.equal(iso(bucketStart(day(2024, 3, 4), '1w')), '2024-03-04', '周一当天应归到本周一起点');
  assert.equal(iso(bucketStart(day(2024, 3, 6), '1w')), '2024-03-04', '周三也应归到同一周(周一)起点');
  assert.equal(iso(bucketStart(day(2024, 3, 10), '1w')), '2024-03-04', '周日属于本周, ISO 周从周一起算');
  assert.equal(iso(bucketStart(day(2024, 3, 11), '1w')), '2024-03-11', '下一个周一起新桶');

  assert.equal(iso(bucketStart(day(2024, 3, 31), '1M')), '2024-03-01');
  assert.equal(iso(bucketStart(day(2024, 3, 1), '1M')), '2024-03-01');

  // 季度: 1-4 / 5-7 / 8-10 / 11-12 月各自归到季首月
  for (const [m, want] of [[1, 1], [3, 1], [4, 4], [6, 4], [7, 7], [9, 7], [10, 10], [12, 10]]) {
    assert.equal(iso(bucketStart(day(2024, m, 15), '1q')), `2024-${String(want).padStart(2, '0')}-01`, `季度边界 ${m} 月`);
  }
  assert.equal(iso(bucketStart(day(2024, 12, 31), '1Y')), '2024-01-01');
  assert.equal(bucketStart(day(2024, 5, 5), 'nope'), null, '未知周期返回 null');
});

test('2. 日线 → 周线: 跨月的一周不能被切成两截', () => {
  // 2024-03-25(一) ~ 2024-03-29(五) 与 2024-04-01(一) ~ 04-03 属于不同周
  const bars = [];
  for (const [m, d] of [[3, 25], [3, 26], [3, 27], [3, 28], [3, 29], [4, 1], [4, 2], [4, 3]]) {
    bars.push(bar(day(2024, m, d), 10, 12, 9, 11, 1));
  }
  const wk = aggregateBars(bars, '1w');
  assert.equal(wk.length, 2, '3月末周与4月首周应是两根独立的周线');
  assert.equal(iso(wk[0].t), '2024-03-25');
  assert.equal(iso(wk[1].t), '2024-04-01');
  assert.equal(wk[0].v, 5, '第一周含 5 个交易日');
  assert.equal(wk[1].v, 3, '第二周含 3 个交易日');
});

test('3. OHLC 口径: 开=区间首根开盘, 收=末根收盘, 高低=区间极值', () => {
  // 刻意让 o/h/l/c 互不相同且单调下跌后回升, 任何一种取错都会被抓出来
  const bars = [
    bar(day(2024, 1, 2), 100, 105, 95, 98, 10),
    bar(day(2024, 1, 3), 99, 120, 80, 90, 20),
    bar(day(2024, 1, 4), 88, 92, 70, 91, 30),
  ];
  const [m] = aggregateBars(bars, '1M');
  assert.equal(m.o, 100, '开盘必须是区间内第一根的开盘');
  assert.equal(m.c, 91, '收盘必须是区间内最后一根的收盘');
  assert.equal(m.h, 120, '最高价必须是区间极值');
  assert.equal(m.l, 70, '最低价必须是区间极值');
  assert.equal(m.v, 60, '成交量必须求和');
  // high/low 必须包住 open/close, 否则 K 线画出来是"穿头破脚"的畸形样本
  assert.ok(m.h >= Math.max(m.o, m.c) && m.l <= Math.min(m.o, m.c));
});

test('4. 输入乱序时先按时间排序再聚合 (不能拿乱序的"首根"当开盘)', () => {
  const bars = [
    bar(day(2024, 1, 5), 50, 51, 49, 50, 1),   // 乱序: 这一根时间最晚
    bar(day(2024, 1, 2), 10, 11, 9, 10, 1),    // 最早
    bar(day(2024, 1, 3), 20, 21, 19, 20, 1),
  ];
  const [m] = aggregateBars(bars, '1M');
  assert.equal(m.o, 10, '开盘必须取时间最早那根的开盘');
  assert.equal(m.c, 50, '收盘必须取时间最晚那根的收盘');
});

test('5. 月线 → 季线 / 年线', () => {
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(bar(day(2024, m, 15), 100 + m, 200, 50, 100 + m, m));
  const q = aggregateBars(months, '1q');
  assert.equal(q.length, 4, '12 个月应聚成 4 个季度');
  assert.deepEqual(q.map((x) => iso(x.t)), ['2024-01-01', '2024-04-01', '2024-07-01', '2024-10-01']);
  assert.equal(q[0].o, 101, '一季度开盘取 1 月');
  assert.equal(q[0].c, 103, '一季度收盘取 3 月');
  assert.equal(q[0].h, 200);

  const y = aggregateBars(months, '1Y');
  assert.equal(y.length, 1);
  assert.equal(iso(y[0].t), '2024-01-01');
  assert.equal(y[0].o, 101, '年线开盘取首月');
  assert.equal(y[0].c, 112, '年线收盘取末月');
  assert.equal(y[0].v, 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12, '年成交量为各月之和');
});

test('6. 跨年不能串在一起, 且相邻间隔符合周期语义', () => {
  const bars = [];
  for (const y of [2022, 2023, 2024]) {
    for (const m of [3, 9]) bars.push(bar(day(y, m, 15), 10, 11, 9, 10, 1));
  }
  const y3 = aggregateBars(bars, '1Y');
  assert.deepEqual(y3.map((x) => iso(x.t)), ['2022-01-01', '2023-01-01', '2024-01-01']);
  for (let i = 1; i < y3.length; i++) {
    const gap = y3[i].t - y3[i - 1].t;
    // 365 或 366 天; 这样审计里的"周期真实性"检查才能认得出这是年线而不是别的
    assert.ok(gap >= 365 * 86400000 - 1000 && gap <= 366 * 86400000 + 1000, `第 ${i} 根间隔不是一年: ${gap / 86400000} 天`);
  }
});

test('7. 脏样本与空输入不产出错数据', () => {
  assert.deepEqual(aggregateBars([], '1M'), []);
  assert.deepEqual(aggregateBars(null, '1Y'), []);
  assert.deepEqual(aggregateBars(undefined, '1w'), []);
  // 价格为 0 / NaN 的样本会被 sanitizeBars 剔除, 不参与聚合
  const dirty = [bar(day(2024, 1, 2), 0, 0, 0, 0, 1), bar(day(2024, 1, 3), NaN, 1, 1, 1, 1)];
  assert.equal(aggregateBars(dirty, '1M').length, 0, '全脏样本必须产出空数组而不是 0 值 K 线');
  // 混合: 脏样本剔除后, 好样本仍要正确聚合
  const mixed = [bar(day(2024, 1, 2), 0, 0, 0, 0, 1), bar(day(2024, 2, 5), 20, 22, 18, 21, 3)];
  const mm = aggregateBars(mixed, '1M');
  assert.equal(mm.length, 1);
  assert.equal(mm[0].o, 20, '脏样本不得污染开盘价');
});

test('8. 单根输入也能聚合 (由调用方决定够不够用)', () => {
  const one = aggregateBars([bar(day(2024, 6, 10), 5, 6, 4, 5, 1)], '1Y');
  assert.equal(one.length, 1);
  assert.equal(iso(one[0].t), '2024-01-01');
});

test('9. sanitizeBars 保证 high/low 包住实体', () => {
  const [b] = sanitizeBars([{ t: day(2024, 1, 2), o: 10, h: 9, l: 12, c: 11, v: 0 }]);
  assert.ok(b.h >= Math.max(b.o, b.c), 'h 被抬高到实体之上');
  assert.ok(b.l <= Math.min(b.o, b.c), 'l 被压低到实体之下');
});
