/**
 * 周期桶: 前端实现 vs 服务端实现 交叉验证
 *   node --test test/period.test.mjs
 *
 * 为什么要有这个文件:
 *   实时贴价要求前端能独立算出"现在这个 tick 该落在哪一根 bar 上"。server.js 是 CJS,
 *   浏览器是 ESM, 两份实现无法共用同一个文件 —— 于是这里用测试把它们锁在一起:
 *   只要任一侧改了口径却没同步另一侧, 下面这些断言立刻变红, 而不是等到用户发现
 *   "周线图每到周末就会多出一根不存在的 K 线"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const server = require('../server.js');                                  // bucketStart / aggregateBars (CJS)
const FE = await import('../public/js/period.js');                       // 同名函数的浏览器侧实现 (ESM)

const SH = 8 * 3600000, DAY = 86400000;
const iso = (s) => +new Date(s);                                          // '2025-03-02T00:00:00+08:00'
/* 造一串连续交易日(含周末也在序列里 —— 服务端本来就要把 7 天合成 1 根周线) */
const mkDays = (n, from) => Array.from({ length: n }, (_, i) => {
  const t = iso(from) + i * DAY;
  return { t, o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: 1000 };
});

test('前端与服务端 bucketStart 完全同口径 (bj / utc 两种日历)', () => {
  const units = ['1w', '1M', '1q', '1Y'];
  // 刻意覆盖: 周一起点 / 周日 23:59 / 月初 / 月末 / 季边界 3-31 与 4-1 / 年边界 12-31 与 1-1
  const marks = [
    '2025-02-28T23:59:59+08:00', '2025-03-01T00:00:00+08:00', '2025-03-02T00:00:00+08:00',
    '2025-03-31T23:59:59+08:00', '2025-04-01T00:00:00+08:00', '2025-06-30T15:00:00+08:00',
    '2025-07-01T09:30:00+08:00', '2025-09-30T23:59:59+08:00', '2025-10-01T00:00:01+08:00',
    '2024-12-31T23:59:59+08:00', '2025-01-01T00:00:00+08:00', '2020-02-29T12:00:00+08:00',
    '2021-02-28T20:00:00+08:00', '2025-12-28T00:00:00+08:00', '2026-01-04T00:00:00+08:00',
  ].map(iso);
  const probes = marks.slice();
  let seed = 20250101;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 1500; i++) probes.push(iso('2018-01-01T00:00:00+08:00') + Math.floor(rnd() * 9 * 365 * DAY));

  for (const align of ['bj', 'utc']) {
    for (const unit of units) {
      for (const t of probes) {
        assert.equal(FE.bucketStart(t, unit, align), server.bucketStart(t, unit, align),
          `${unit}/${align} @ ${new Date(t + SH).toISOString()} 前端与服务端算出了不同的桶`);
      }
    }
  }
});

test('前端 1d 桶 = UTC+8 日历日起点', () => {
  assert.equal(FE.bucketStart(iso('2025-06-15T23:59:59+08:00'), '1d'), iso('2025-06-15T00:00:00+08:00'));
  assert.equal(FE.bucketStart(iso('2025-06-16T00:00:00+08:00'), '1d'), iso('2025-06-16T00:00:00+08:00'));
  // 同一时刻在东八区是 6/16 凌晨, 在 UTC 还是 6/15 —— 桶必须按东八区走
  assert.equal(FE.bucketStart(+new Date('2025-06-15T16:30:00Z'), '1d'), iso('2025-06-16T00:00:00+08:00'));
});

test('分钟/小时桶用 UTC epoch 对齐, 不掺时区', () => {
  const cases = [
    ['min', '2025-06-16T09:30:00+08:00'], ['1m', '2025-06-16T09:30:00+08:00'],
    ['5m', '2025-06-16T09:35:00+08:00'], ['15m', '2025-06-16T09:45:00+08:00'],
    ['1h', '2025-06-16T10:00:00+08:00'], ['4h', '2025-06-16T12:00:00+08:00'],
  ];
  for (const [unit, s] of cases) {
    const t = iso(s);
    assert.equal(FE.bucketStart(t, unit), t, `${unit} 应把自己所在的桶起点原样命中`);
  }
  // 币安 4h 的桶一定是 00/04/08/12/16/20 点 (UTC), 不能因为东八区偏移而错位
  for (let h = 0; h < 24; h += 3) {
    const t = +new Date(`2025-06-16T${String(h).padStart(2, '0')}:30:00Z`);
    const b = FE.bucketStart(t, '4h');
    assert.equal(new Date(b).getUTCHours() % 4, 0, `4h 桶必须落在 4 小时的整数倍上 (${new Date(t).toISOString()})`);
  }
});

test('幂等: 桶起点的桶起点还是它自己', () => {
  for (const unit of ['min', '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M', '1q', '1Y']) {
    for (const t of [iso('2025-06-16T17:23:45+08:00'), iso('2025-01-01T00:00:01+08:00'), iso('2025-12-31T23:59:59+08:00')]) {
      const b = FE.bucketStart(t, unit);
      assert.equal(FE.bucketStart(b, unit), b, `${unit} 桶计算不幂等`);
    }
  }
});

test('1w 起点必须是北京时间周一零点, 不能偏 8 小时', () => {
  /* 这是个真实踩过的坑: 桶算成"UTC 日起点"时周线会落在周一 08:00,
   * 与上游原生周K(腾讯 week 参数给的就是周一 00:00+08)对不上,
   * 而服务端与审计脚本各自复制了同一份错误实现, 交叉验证反而自洽、测不出来。 */
  const agg = server.aggregateBars(mkDays(30, '2025-06-02T00:00:00+08:00'), '1w');
  assert.ok(agg.length >= 2);
  for (const b of agg) {
    const d = new Date(b.t + SH);                     // 抬到北京时间看日历
    assert.equal(d.getUTCHours(), 0, `周线不是零点: ${new Date(b.t + SH).toISOString()}`);
    assert.equal(d.getUTCMinutes(), 0);
    assert.equal(d.getUTCDay(), 1, `周线不是周一: ${new Date(b.t + SH).toISOString()}`);
  }
  // 同一个日线序列, 前端算出来的必须是同一个桶
  for (const b of agg) assert.equal(FE.bucketStart(b.t, '1w', 'bj'), b.t);
});

test('utc 口径: 桶起点落在 UTC 零点 (币安的真实口径)', () => {
  /* 币安日/周/月 K 的 open time 就是 UTC 零点。前端要判断 tick 归哪一根, 必须用同一套,
   * 否则北京时间每天 00:00~08:00 这段会被判成"该开新的一根", 凭空画出半根假 K 线。 */
  for (const unit of ['1d', '1w', '1M', '1q', '1Y']) {
    const b = FE.bucketStart(iso('2026-03-17T04:00:00+08:00'), unit, 'utc');
    assert.equal(b % DAY, 0, `${unit} 的 utc 桶必须整除日`);
    assert.equal(new Date(b).getUTCHours(), 0);
  }
  assert.equal(FE.bucketStart(iso('2026-03-17T04:00:00+08:00'), '1d', 'utc'), +new Date('2026-03-16T00:00:00Z'));
  // 币安周线 = UTC 周一零点 == 北京时间周一 08:00
  const wk = FE.bucketStart(iso('2026-10-06T23:00:00+08:00'), '1w', 'utc');
  assert.equal(new Date(wk).getUTCDay(), 1);
  assert.equal(new Date(wk).getUTCHours(), 0);
  // 同一时刻按北京时间算, 仍然是北京时间周一零点 —— 两种口径差 8 小时, 不可混用
  assert.equal(FE.bucketStart(iso('2026-10-06T23:00:00+08:00'), '1w', 'bj'), wk - SH);
});

test('服务端真实产出的 bar.t, 必须能被前端 bucketStart 的桶包含', () => {
  /* 这是整套实时贴价的地基: 如果前端算出来的桶不包含上游 bar 的 t,
   * applyLive 就会判定"跨了一根", 然后每几秒 reload 一次或者画出一根假 bar。 */
  for (const align of ['bj', 'utc']) {
    for (const unit of ['1w', '1M', '1q', '1Y']) {
      const agg = server.aggregateBars(mkDays(400, '2024-01-02T00:00:00+08:00'), unit, align);
      assert.ok(agg.length >= 2, `至少要聚合出 2 根 ${unit}/${align}`);
      for (const b of agg) {
        assert.equal(FE.bucketStart(b.t, unit, align), b.t, `${unit}/${align} bar.t 不是前端认可的桶起点`);
        assert.equal(server.bucketStart(b.t, unit, align), b.t);
      }
    }
  }
});

test('分时每个点 / 币安分钟线的 t 都能被前端 1m 桶命中', () => {
  // 腾讯分时的时间戳写法: +new Date('YYYY-MM-DDT HH:mm:00+08:00')
  for (const hm of ['09:30', '10:07', '11:29', '13:01', '14:57', '15:00']) {
    const t = iso(`2025-06-16T${hm}:00+08:00`);
    assert.equal(FE.bucketStart(t, '1m'), t, `分时点 ${hm} 未命中 1m 桶`);
  }
  // 币安返回的是 UTC epoch 毫秒, 同样是整分钟
  const t0 = +new Date('2025-06-16T00:00:00Z');
  for (let k = 0; k < 300; k++) assert.equal(FE.bucketStart(t0 + k * 60000, '1m'), t0 + k * 60000);
});

test('未知周期返回 null, 不静默猜单位', () => {
  assert.equal(FE.bucketStart(Date.now(), '2h'), null);
  assert.equal(FE.bucketStart(Date.now(), 'year'), null);
  assert.equal(FE.bucketStart(NaN, '1d'), null);
  assert.equal(FE.bucketStart(undefined, '1d'), null);
});
