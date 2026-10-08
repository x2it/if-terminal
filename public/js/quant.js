/* 量化引擎: 指标库 + 回测器 (沙盒执行用户策略) */

/* ---------- 指标库 ---------- */
export function SMA(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
export function EMA(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < arr.length; i++) {
    e = e == null ? arr[i] : arr[i] * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
}
export function MACD(arr, fast = 12, slow = 26, sig = 9) {
  const ef = EMA(arr, fast), es = EMA(arr, slow);
  const dif = arr.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const valid = dif.map(v => v == null ? 0 : v);
  const deaRaw = EMA(valid, sig);
  const dea = dif.map((v, i) => v == null ? null : deaRaw[i]);
  const hist = dif.map((v, i) => v == null || dea[i] == null ? null : (v - dea[i]) * 2);
  return { dif, dea, hist };
}
export function RSI(arr, n = 14) {
  const out = new Array(arr.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    const up = Math.max(0, d), dn = Math.max(0, -d);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
export function ATR(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let a = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - p), Math.abs(b.l - p));
    a = a == null ? tr : (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}
export function BOLL(arr, n = 20, k = 2) {
  const mid = SMA(arr, n);
  const up = [], dn = [];
  for (let i = 0; i < arr.length; i++) {
    if (mid[i] == null) { up.push(null); dn.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (arr[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    up.push(mid[i] + k * sd); dn.push(mid[i] - k * sd);
  }
  return { mid, up, dn };
}
export const IND = { SMA, EMA, MACD, RSI, ATR, BOLL };

/* ---------- 回测引擎 ----------
 * 策略代码中定义函数 onBar(ctx, bar, i)，逐根K线调用:
 *   ctx.pos   当前仓位比例 0~1      ctx.buy(frac)  买入至 frac 仓位 (收盘价成交)
 *   ctx.sell(frac) 卖出 frac 仓位   ctx.price/bar  当前价格/K线   ctx.log(...) 调试
 *   ind: close/sma(n)/ema(n)/rsi(n)/atr(n)/boll(n,k)/macd(a,b,c) — 全指标库
 * 返回 {equity, trades, stats, logs}
 */
export function backtest(bars, code, { cash0 = 100000, fee = 5e-4, period = 252 } = {}) {
  let cash = cash0, shares = 0, avgEntry = 0;
  const ctx = {
    get pos() { const eq = cash + shares * (ctx.price || 0); return eq > 0 ? Math.min(1, shares * (ctx.price || 0) / eq) : 0; },
    get price() { return bars[0] ? bars[Math.min(iCur, bars.length - 1)].c : null; },
    get bar() { return bars[Math.min(iCur, bars.length - 1)]; },
    equity: cash0,
    buy(frac = 1) { order = Math.min(1, Math.max(0, frac)); side = 1; },
    sell(frac = 1) { order = Math.min(1, Math.max(0, frac)); side = -1; },
    log(...a) { if (logs.length < 60) logs.push(`#${iCur} ${a.join(' ')}`); },
  };
  let order = 0, side = 0, iCur = 0;
  const logs = [];
  const closes = bars.map(b => b.c);
  const ind = {
    close: closes,
    sma: (n, arr) => SMA(arr || closes, n),
    ema: (n, arr) => EMA(arr || closes, n),
    rsi: (n, arr) => RSI(arr || closes, n),
    atr: n => ATR(bars, n),
    boll: (n, k) => BOLL(closes, n, k),
    macd: (a, b, c) => MACD(closes, a, b, c),
    IND,
  };
  const fn = new Function('ctx', 'bar', 'i', 'ind', `"use strict";\n${code}\n;`);
  const equity = [], trades = [];
  for (iCur = 0; iCur < bars.length; iCur++) {
    const b = bars[iCur];
    order = 0; side = 0;
    try { fn(ctx, b, iCur, ind); } catch (e) { throw new Error(`第 ${iCur} 根K线策略报错: ${e.message}`); }
    // 收盘价执行
    const p = b.c;
    if (side === 1) {
      const eqv = cash + shares * p;
      const targetShares = order * eqv / p;
      const add = targetShares - shares;
      if (add > 0) {
        const cost = Math.min(cash, add * p);
        const bought = cost / p;
        avgEntry = shares + bought > 0 ? (avgEntry * shares + p * bought) / (shares + bought) : p;
        cash -= cost * (1 + fee);
        shares += bought;
        if (shares - bought === 0) trades.push({ side: 'open', price: p, t: b.t, shares });
      }
    } else if (side === -1 && shares > 0) {
      const sellS = Math.min(shares, shares * order);
      const proceeds = sellS * p * (1 - fee);
      const basis = sellS * avgEntry;
      cash += proceeds;
      shares -= sellS;
      trades.push({ side: 'close', price: p, t: b.t, pnl: proceeds - basis, pnlPct: (p - avgEntry) / avgEntry * 100 });
      if (shares <= 1e-9) { shares = 0; avgEntry = 0; }
    }
    ctx.equity = cash + shares * p;
    equity.push({ t: b.t, v: ctx.equity });
  }
  const ret = equity.length ? equity[equity.length - 1].v / cash0 - 1 : 0;
  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i].v / equity[i - 1].v - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const sharpe = sd ? mean / sd * Math.sqrt(period) : 0;
  let peak = -Infinity, maxDD = 0;
  for (const e of equity) { peak = Math.max(peak, e.v); maxDD = Math.max(maxDD, 1 - e.v / peak); }
  const closed = trades.filter(t => t.side === 'close');
  const wins = closed.filter(t => t.pnl > 0).length;
  const gp = closed.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(closed.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  return {
    equity, trades, logs,
    stats: {
      ret: ret * 100, sharpe, maxDD: maxDD * 100,
      trades: closed.length, winRate: closed.length ? wins / closed.length * 100 : 0,
      profitFactor: gl ? gp / gl : gp ? 99 : 0,
      final: equity.length ? equity[equity.length - 1].v : cash0,
      benchmark: closes.length ? (closes[closes.length - 1] / closes[0] - 1) * 100 : 0,
    },
  };
}

export const STRATEGY_EXAMPLES = {
  '双均线趋势': `// 金叉买入 死叉卖出
let prev = null;
function onBar(ctx, bar, i, ind) {
  const f = ind.sma(5), s = ind.sma(20);
  if (f[i] == null || s[i] == null) return;
  const gold = f[i] > s[i];
  if (gold && ctx.pos === 0) ctx.buy(1);
  if (!gold && ctx.pos > 0) ctx.sell(1);
}`,
  'RSI均值回归': `// RSI<30 买入, >70 卖出
function onBar(ctx, bar, i, ind) {
  const r = ind.rsi(14);
  if (r[i] == null) return;
  if (r[i] < 30 && ctx.pos === 0) ctx.buy(1);
  if (r[i] > 70 && ctx.pos > 0) ctx.sell(1);
}`,
  '布林带突破': `// 收盘上轨买入, 中轨下方卖出
function onBar(ctx, bar, i, ind) {
  const b = ind.boll(20, 2);
  if (!b.mid[i]) return;
  if (bar.c > b.up[i] && ctx.pos === 0) ctx.buy(1);
  if (bar.c < b.mid[i] && ctx.pos > 0) ctx.sell(1);
}`,
  'ATR趋势跟踪': `// 唐奇安通道突破 + ATR止损
let stop = null;
function onBar(ctx, bar, i, ind) {
  const a = ind.atr(14);
  if (i < 20 || !a[i]) return;
  const hh = Math.max(...ind.close.slice(i - 20, i));
  if (ctx.pos === 0 && bar.c > hh) { ctx.buy(1); stop = bar.c - 2 * a[i]; }
  if (ctx.pos > 0) {
    stop = Math.max(stop, bar.c - 2 * a[i]);
    if (bar.c < stop) ctx.sell(1);
  }
}`,
  '网格交易': `// 以20日均价为中枢 ±2% 网格
function onBar(ctx, bar, i, ind) {
  const m = ind.sma(20);
  if (!m[i]) return;
  const z = (bar.c - m[i]) / m[i];
  if (z < -0.02 && ctx.pos < 0.5) ctx.buy(0.5);
  if (z < -0.04 && ctx.pos < 1) ctx.buy(1);
  if (z > 0.02 && ctx.pos > 0.5) ctx.sell(0.5);
  if (z > 0.04 && ctx.pos > 0) ctx.sell(1);
}`,
};
