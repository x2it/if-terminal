'use strict';
// IF TERMINAL 系统性审计 v2
// 维度: 报价一致性 / K线合法性 / 周期真实性(反静默降级) / 聚合正确性 / 端点与Agent指令
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const BASE = process.env.BASE || 'http://localhost:8787';
const SAMPLE = 5;

// 各类别"应当支持"的周期; 不在表内的周期必须如实报 ok:false, 不得返回数据
const SUPPORTED = {
  // 期货/外汇的上游只有日线, 周/月/季/年由服务端真实聚合
  // A股/港股/美股/指数: 免费源只有"分时(min)" + 日及以上, 没有分钟级 K 线柱 ——
  // 产品侧已如实拒绝 1m, 审计的期望必须跟着服务端的分派走, 否则会误报成失败。
  'A股': ['1d', '1w', '1M', '1q', '1Y', 'min'],
  '港股': ['1d', '1w', '1M', '1q', '1Y', 'min'],
  // 美股在腾讯源只有日及以上, 没有"分时"; 实测 /api/kline period=min 会如实报
  // "该品种不支持分时数据" —— 审计期望跟着服务端走, 不把它算成失败。
  '美股': ['1d', '1w', '1M', '1q', '1Y'],
  '指数': ['1d', '1w', '1M', '1q', '1Y'],
  '期货': ['1d', '1w', '1M', '1q', '1Y'],
  '外汇': ['1d', '1w', '1M', '1q', '1Y'],
  '加密货币': ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M', '1q', '1Y', 'min'],
};
/* K线能力边界以 server.js 为唯一真相源, 避免两边各写一份慢慢跑偏 */
const { NO_KLINE, TX_KLINE_ALIAS } = require('../server.js');

function supportedOf(it) {
  // 免费源下根本没有 K 线历史的品种(实时报价仍正常), 不参与 K 线校验
  if (NO_KLINE.has(it.code)) return [];
  const s = SUPPORTED[it.group] || ['1d'];
  // 要按"实际去请求腾讯的那个代码"判断, 而不是 CATALOG 的原始 code
  const code = TX_KLINE_ALIAS[it.code] || it.code;
  // 沪深指数(sh/sz 开头)与恒生(hkHSI)提供"分时"; 1m 柱免费源同样没有, 不再期望
  if (it.group === '指数' && (/^(sh|sz)/.test(code) || code === 'hkHSI')) return s.concat(['min']);
  return s;
}
const ALL_PERIODS = ['1d', '1w', '1M', '1q', '1Y', '1h', '4h', 'min', '1m', '5m', '15m'];
const LONG_PERIODS = new Set(['1M', '1q', '1Y']);   // 这些周期要的是历史纵深
// 1Y 用 365.25 天是为了兼容闰年; 年/季没有整数毫秒的固定间隔, 只能按平均值给容差基准
const EXPECT_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000, '1M': 30 * 86400000, '1q': 91 * 86400000, '1Y': 365.25 * 86400000 };

const fails = [];
const stats = { quotes: 0, kline: 0, pass: 0 };
const bad = (kind, sym, detail) => fails.push({ kind, sym, detail });

async function jget(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const txt = await r.text();
    clearTimeout(t);
    return { status: r.status, txt };
  } catch (e) { clearTimeout(t); return { status: 0, txt: '', err: String(e.message || e) }; }
}

// 周期真实性: 相邻 bar 时间间隔是否符合请求周期(容差 40%), 用于抓"要1h给日线"
function checkPeriodTruth(sym, period, bars) {
  if (period === 'min' || period === '1M') return;
  const exp = EXPECT_MS[period];
  if (!exp || bars.length < 3) return;
  // 日/周级会跳过周末与休市日, 间隔本就不等距, 容差放宽到 [0.9, 4] 倍
  const dayish = period === '1d' || period === '1w';
  let suspicious = 0;
  // 末根 K 线可能尚未收完(时间戳为当前), 排除它再比对间隔
  for (let i = 1; i < Math.min(bars.length - 1, 6); i++) {
    const gap = bars[i].t - bars[i - 1].t;
    const ok = dayish ? (gap >= exp * 0.9 && gap <= exp * 4) : Math.abs(gap - exp) <= exp * 0.4;
    if (!ok) suspicious++;
  }
  if (suspicious >= 2) bad('period', `${sym} ${period}`, `周期不真实: 期望间隔${exp}ms, 实际样本 ${bars.slice(0, 3).map((b) => b.t).join('/')}`);
}

function checkBars(sym, period, d) {
  if (!d || d.ok !== true) return false;
  const bars = d.bars || [];
  if (!bars.length) return false;
  for (const b of bars) {
    const [o, h, l, c] = [+b.o, +b.h, +b.l, +b.c];
    if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) { bad('ohlc', `${sym} ${period}`, '非正数/NaN: ' + JSON.stringify(b)); return true; }
    if (h < Math.max(o, c, l) - 1e-9) { bad('ohlc', `${sym} ${period}`, 'high 不是最高: ' + JSON.stringify(b)); return true; }
    if (l > Math.min(o, c, h) + 1e-9) { bad('ohlc', `${sym} ${period}`, 'low 不是最低: ' + JSON.stringify(b)); return true; }
    if (!Number.isFinite(+b.t) || +b.t <= 0) { bad('ohlc', `${sym} ${period}`, '时间戳非法: ' + b.t); return true; }
  }
  checkPeriodTruth(sym, period, bars);
  return true;
}

(async () => {
  const uni = JSON.parse((await jget(`${BASE}/api/universe`)).txt);
  const groups = {};
  for (const it of uni.catalog) (groups[it.group] = groups[it.group] || []).push(it);

  // ---- 1) 全品种报价 ----
  console.log(`[1/5] 报价一致性: ${uni.catalog.length} 品种`);
  const syms = uni.catalog.map((x) => x.sym);
  for (let i = 0; i < syms.length; i += 30) {
    const slice = syms.slice(i, i + 30);
    const r = await jget(`${BASE}/api/quotes?syms=${encodeURIComponent(slice.join(','))}`, 25000);
    if (r.status !== 200) { bad('quotes', `batch${i}`, `HTTP ${r.status}`); continue; }
    const arr = JSON.parse(r.txt);
    if (arr.length !== slice.length) {
      const got = new Set(arr.map((x) => x.sym));
      bad('quotes', `batch${i}`, `请求${slice.length} 返回${arr.length}, 缺失: ${slice.filter((s) => !got.has(s)).join(',')}`);
    }
    for (const q of arr) {
      stats.quotes++;
      if (!(Number(q.price) > 0)) { bad('quote', q.sym, `price 非法 ${q.price}`); continue; }
      if (Number(q.high) < Number(q.low)) { bad('quote', q.sym, 'high<low'); continue; }
      if (Number(q.prev) > 0 && Number.isFinite(Number(q.pct))) {
        const exp = ((Number(q.price) - Number(q.prev)) / Number(q.prev)) * 100;
        if (Math.abs(Number(q.pct) - exp) > 0.5) bad('quote', q.sym, `pct 不符: ${q.pct} vs ${exp.toFixed(3)}`);
      }
      stats.pass++;
    }
  }
  console.log(`      完成, 累计失败 ${fails.length}`);

  // ---- 2) K线: 支持矩阵 + 反静默降级 ----
  console.log('[2/5] K线合法性 + 周期真实性');
  for (const g of Object.keys(groups)) {
    // 品种少的组(如指数 11 个)全量覆盖 —— 只抽前 5 个时, 排在后面的坏品种会一直躲过审计
    const pool = groups[g].length <= 12 ? groups[g] : groups[g].slice(0, SAMPLE);
    for (const it of pool) {
      const supported = supportedOf(it);
      for (const p of ALL_PERIODS) {
        stats.kline++;
        await new Promise((r) => setTimeout(r, 120)); // 节流: 避免自身高频触发上游限流
        const r = await jget(`${BASE}/api/kline?sym=${encodeURIComponent(it.sym)}&period=${p}&limit=6`, 20000);
        if (r.status !== 200) { bad('kline', `${it.sym} ${p}`, `HTTP ${r.status}`); continue; }
        const d = JSON.parse(r.txt);
      const hasData = checkBars(it.sym, p, d);
      if (supported.includes(p)) {
        if (!hasData) bad('kline', `${it.sym} ${p}`, `应支持但未返回数据: ${d.error || 'bars 空'}`);
        // 长周期只返回 1~2 根同样等于不可用(历史纵深不足), 不能因为"有数据"就放过
        else if (LONG_PERIODS.has(p) && d.bars.length < 3) bad('thin', `${it.sym} ${p}`, `长周期仅 ${d.bars.length} 根, 无分析价值`);
        else stats.pass++;
      } else if (hasData) {
          bad('downgrade', `${it.sym} ${p}`, `不支持的周期却返回了数据(静默降级)`);
        } else stats.pass++;
      }
    }
    console.log(`      ${g}: ${groups[g].slice(0, SAMPLE).length}品种 × ${ALL_PERIODS.length}周期, 累计失败 ${fails.length}`);
  }

  // ---- 3) 交叉验证 ----
  console.log('[3/5] 跨接口交叉验证: 日K末收 vs 实时价');
  for (const g of ['A股', '港股', '美股', '加密货币']) {
    for (const it of (groups[g] || []).slice(0, 4)) {
      if (NO_KLINE.has(it.code)) continue;   // 明确无 K 线的品种不必再验(如实报错才是它的正确行为)
      const [q, k] = await Promise.all([
        jget(`${BASE}/api/quotes?syms=${encodeURIComponent(it.sym)}`),
        jget(`${BASE}/api/kline?sym=${encodeURIComponent(it.sym)}&period=1d&limit=2`),
      ]);
      try {
        const qq = JSON.parse(q.txt)[0]; const kk = JSON.parse(k.txt);
        if (!kk.bars?.length) { bad('xcheck', it.sym, '无日K可供交叉验证'); continue; }
        const lastC = +kk.bars[kk.bars.length - 1].c, price = +qq.price;
        const diff = Math.abs(lastC - price) / price * 100;
        if (diff > 5) bad('xcheck', it.sym, `日K末收${lastC} vs 实时${price} 偏差${diff.toFixed(2)}%`);
        else stats.pass++;
      } catch (e) { bad('xcheck', it.sym, '异常 ' + e.message); }
    }
  }

  // ---- 3b) 聚合正确性 ----
  // 长周期不是上游直出、而是本地聚合出来的。只做"格式合法"检查抓不住算错:
  // 开盘取成最小值、跨 UTC 时区把 1 月 1 日算到去年 —— 结果依然是一根合法的假 K 线。
  // 所以这里用一个**独立实现**按同样的日历口径重算一遍, 再和服务端逐根比对(要求完全一致)。
  console.log('[3/5b] 聚合正确性: 由低周期独立重算, 逐根比对');
  const SH = 8 * 3600000;
  const DAY = 86400000;
  // 独立实现: 口径与服务端一致(bj=北京时间 / utc=币安), 但代码路径完全不同
  const refBucket = (ts, unit, align) => {
    const off = align === 'utc' ? 0 : SH;
    const d0 = Math.floor((+ts + off) / DAY) * DAY;
    const dt = new Date(d0);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
    const mStart = (mm) => Date.UTC(y, mm - 1, 1) - off;
    if (unit === '1w') return d0 - ((dt.getUTCDay() + 6) % 7) * DAY - off;
    if (unit === '1M') return mStart(m);
    if (unit === '1q') return mStart(Math.floor((m - 1) / 3) * 3 + 1);
    if (unit === '1Y') return mStart(1);
    return null;
  };
  const refAgg = (bars, unit, align) => {
    const g = new Map();
    for (const b of [...bars].sort((a, b2) => a.t - b2.t)) {
      const t = refBucket(b.t, unit, align);
      if (t == null) continue;
      if (!g.has(t)) g.set(t, []);
      g.get(t).push(b);
    }
    return [...g.entries()].sort((a, b2) => a[0] - b2[0]).map(([t, rows]) => ({
      t, o: rows[0].o, c: rows[rows.length - 1].c,
      h: Math.max(...rows.map((r) => r.h)), l: Math.min(...rows.map((r) => r.l)),
      v: rows.reduce((s, r) => s + (r.v || 0), 0),
    }));
  };
  const getKline = async (sym, p, limit = 300) => {
    const r = await jget(`${BASE}/api/kline?sym=${encodeURIComponent(sym)}&period=${p}&limit=${limit}`, 25000);
    return r.status === 200 ? JSON.parse(r.txt) : null;
  };
  // base → target: 目标周期由哪个基础周期聚合而来
  const AGG_CASES = [
    { sym: 'cn:sh600519', base: '1M', targets: ['1q', '1Y'] },
    { sym: 'idx:sh000001', base: '1M', targets: ['1q', '1Y'] },
    { sym: 'crypto:BTCUSDT', base: '1M', targets: ['1q', '1Y'] },
    { sym: 'fut:hf_GC', base: '1d', targets: ['1w', '1M', '1q', '1Y'] },
    { sym: 'fx:fx_susdcny', base: '1d', targets: ['1w', '1M', '1q', '1Y'] },
  ];
  for (const c of AGG_CASES) {
    // 基准必须"够长": 服务端内部取 1M 时用 Math.max(limit*12,400) 再钳到 640。
    // 若这里只取 300 根月线, 两者的历史起点不同, 第一根季线本来就该不一样 —— 那是比对方法错, 不是聚合错。
    const baseDoc = await getKline(c.sym, c.base, 640);
    if (!baseDoc?.ok || !baseDoc.bars?.length) { bad('agg', c.sym, `拿不到基准周期 ${c.base}`); continue; }
    for (const tp of c.targets) {
      await new Promise((r) => setTimeout(r, 150));
      const got = await getKline(c.sym, tp);
      if (!got?.ok) { bad('agg', `${c.sym} ${tp}`, `服务端返回不可用: ${got?.error || ''}`); continue; }
      // 两次请求可能命中不同上游(腾讯 qfq / 新浪不复权), 口径不同则无法比对 —— 如实跳过, 不硬判失败
      const gotBase = String(got.src || '').replace(/\+agg$/, '');
      if (gotBase && baseDoc.src && gotBase !== baseDoc.src) {
        console.log(`      ${c.sym} ${tp}: 跳过比对 (源不一致 服务端${gotBase} vs 基准${baseDoc.src})`);
        continue;
      }
      const wantAll = refAgg(baseDoc.bars, tp, got.align);
      // 服务端宣称的日历口径, 必须与我们独立重算出的每一根都严丝合缝
      for (const w of wantAll) {
        if (refBucket(w.t, tp, got.align) !== w.t) {
          bad('agg', `${c.sym} ${tp} align=${got.align}`, '桶起点不自洽(该口径下重新分桶得到不同的起点)');
          break;
        }
      }
      // 只比对两者时间交集内的部分, 规避首尾半截数据带来的差异
      const from = Math.max(got.bars[0].t, wantAll[0].t);
      const gotCmp = got.bars.filter((b) => b.t >= from);
      const want = wantAll.filter((b) => b.t >= from);
      if (want.length < 2) { bad('agg', `${c.sym} ${tp}`, `基准 ${c.base} 只有 ${baseDoc.bars.length} 根, 不足以聚合出 2 根 ${tp}`); continue; }
      if (gotCmp.length !== want.length) {
        bad('agg', `${c.sym} ${tp}`, `根数不符: 服务端 ${gotCmp.length} vs 独立重算 ${want.length} (比对区间自 ${new Date(from).toISOString().slice(0, 10)} 起)`);
        continue;
      }
      // 最后一根通常尚未收完, 会随行情实时变动 —— 两次请求之间差个 0.01 是正常的, 不参与逐根比对
      const cmpN = want.length - 1;
      let mismatch = null;
      for (let i = 0; i < cmpN; i++) {
        const [a, b] = [gotCmp[i], want[i]];
        if (a.t !== b.t) { mismatch = `第${i}根时间戳: 服务端 ${a.t} vs 重算 ${b.t}`; break; }
        for (const k of ['o', 'h', 'l', 'c']) {
          if (Math.abs(a[k] - b[k]) > 1e-6) { mismatch = `第${i}根 ${k}: 服务端 ${a[k]} vs 重算 ${b[k]}`; break; }
        }
        if (mismatch) break;
      }
      if (mismatch) bad('agg', `${c.sym} ${tp}`, mismatch);
      else stats.pass++;
    }
    console.log(`      ${c.sym}: ${c.base} → ${c.targets.join('/')}, 累计失败 ${fails.length}`);
  }

  // ---- 4) 端点 ----
  console.log('[4/5] 端点可达性');
  for (const ep of ['/api/health', '/api/news', '/api/agent', '/api/agent/log', '/api/universe']) {
    const r = await jget(BASE + ep, 15000);
    if (r.status !== 200) { bad('endpoint', ep, `HTTP ${r.status}`); continue; }
    try { JSON.parse(r.txt); stats.pass++; } catch { bad('endpoint', ep, 'JSON 解析失败'); }
  }

  // ---- 5) Agent 指令 ----
  console.log('[5/5] Agent 指令总线');
  const schema = JSON.parse((await jget(BASE + '/api/agent')).txt).schema || [];
  for (const c of schema) {
    const resp = await fetch(BASE + '/api/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: c.cmd, args: c.args || {}, from: 'audit' }),
    });
    if (resp.status >= 400) bad('agent', c.cmd, `HTTP ${resp.status}`); else stats.pass++;
  }
  console.log(`      ${schema.length} 条指令已下发`);

  console.log('\n============ 审计汇总 ============');
  console.log(`报价 ${stats.quotes} 条 | K线请求 ${stats.kline} 次 | 通过 ${stats.pass}`);
  console.log(`失败: ${fails.length}`);
  const by = {}; for (const f of fails) by[f.kind] = (by[f.kind] || 0) + 1;
  console.log('分类:', JSON.stringify(by));
  console.log('\n---- 明细(前30) ----');
  for (const f of fails.slice(0, 30)) console.log(`[${f.kind}] ${f.sym} :: ${f.detail}`);
  // 失败明细落盘, 便于逐条排查; 路径可用 AUDIT_OUT 覆盖
  const out = process.env.AUDIT_OUT || 'audit-fails.json';
  (await import('node:fs')).writeFileSync(out, JSON.stringify(fails, null, 2));
  console.log(`\n失败明细已写入: ${out}`);
  process.exitCode = fails.length ? 1 : 0;   // 有失败则非零退出, 便于接进 CI
})();
