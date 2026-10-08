/* 专业分析插件: 市场结构 (大盘→品类→品种 三层下钻) · 信号雷达 (机会/风险/背离/异常/共振) */
import { F } from '../fmt.js';
import { S, bus, selectSymbol, symName } from '../core.js';
import { h } from '../ui.js';
import { registerCard } from '../grid.js';
import { getKline } from '../api.js';
import { SMA, RSI } from '../quant.js';

/* ================= 市场结构: 大盘 → 品类 → 品种 =================
 * 这里的「品类」是 A股/港股/美股/加密货币/期货/外汇 这类资产分组, 不是行业板块 ——
 * 免费数据源下拿不到真实的行业板块指数, 叫「板块」就是名不副实, 一律如实写「品类」。 */
const MARKET_OF = { 'A股': 'idx:sh000001', '港股': 'idx:int_hangseng', '美股': 'idx:usIXIC', '加密货币': 'crypto:BTCUSDT', '指数': 'idx:sh000300', '期货': 'fut:hf_CL', '外汇': 'fx:fx_susdcny' };
registerCard({
  type: 'structure', title: '市场结构', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.overflowY = 'auto';
    let expand = null;   // 展开的品类名 (品种层)

    function breadth(group) {
      const pool = S.universe.filter(u => u.group === group).map(u => S.quotes[u.sym]).filter(q => q && isFinite(q.pct));
      if (!pool.length) return null;
      const up = pool.filter(q => q.pct > 0).length;
      const dn = pool.filter(q => q.pct < 0).length;
      return { up, dn, n: pool.length, upPct: up / pool.length * 100, median: medianOf(pool.map(q => q.pct)) };
    }
    const medianOf = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

    function render() {
      bd.innerHTML = '';
      /* --- 大盘层 --- */
      const mk = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '6px 8px', borderBottom: '1px solid var(--line)' } });
      for (const [group, idxSym] of Object.entries(MARKET_OF)) {
        const Q = S.quotes[idxSym], br = breadth(group);
        if (!Q && !br) continue;
        const cls = F.cls(Q?.pct);
        mk.append(h('div', { style: { cursor: 'pointer', minWidth: '104px', flex: '1' }, onclick: () => idxSym && selectSymbol(idxSym) },
          h('div', { class: 'dim', style: { fontSize: '9px' } }, group + ' 大盘'),
          h('div', { class: 'num ' + cls, style: { fontSize: '13px' } }, F.price(Q?.price), ' ', h('span', { style: { fontSize: '10px' } }, F.pct(Q?.pct))),
          h('div', { style: { display: 'flex', height: '4px', borderRadius: '2px', overflow: 'hidden', margin: '3px 0', background: 'var(--line)' }, title: `上涨${br?.up || 0} / 下跌${br?.dn || 0}` },
            h('div', { style: { width: (br ? br.upPct : 0) + '%', background: 'var(--up)', transition: 'width .5s' } }),
            h('div', { style: { flex: '1', background: 'var(--down)', opacity: .8 } })),
          h('div', { class: 'dim', style: { fontSize: '9px' } }, br ? `广度 ${br.up}↑/${br.dn}↓ 中位 ${F.pct(br.median)}` : '')));
      }
      bd.append(mk);

      /* --- 品类层 + 品种层 (下钻) --- */
      const groups = [...new Set(S.universe.map(u => u.group))];
      for (const g of groups) {
        const members = S.universe.filter(u => u.group === g && S.quotes[u.sym]);
        if (g === '指数' || !members.length) continue;
        const br = breadth(g);
        const sorted = members.map(u => S.quotes[u.sym]).sort((a, b) => (b.pct || -1e9) - (a.pct || -1e9));
        const leader = sorted[0], laggard = sorted[sorted.length - 1];
        const hot = br && (br.upPct >= 65 || br.upPct <= 35);
        const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 10px', cursor: 'pointer', borderBottom: '1px solid color-mix(in srgb, var(--line) 40%, transparent)' }, onclick: () => { expand = expand === g ? null : g; render(); } },
          h('span', { class: hot ? 'up' : 'dim', style: { width: '64px' } }, g),
          h('div', { style: { flex: 1, height: '5px', background: 'var(--line)', borderRadius: '3px', overflow: 'hidden' } },
            h('div', { style: { width: (br?.upPct || 0) + '%', height: '100%', background: (br?.upPct || 0) >= 50 ? 'var(--up)' : 'var(--down)', transition: 'width .5s' } })),
          h('span', { class: 'num dim', style: { fontSize: '10px' } }, br ? F.pct(br.median) : ''),
          h('span', { class: 'num ' + F.cls(leader?.pct), style: { fontSize: '10px', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '强 ' + (leader?.name || '')),
          h('span', { class: 'num ' + F.cls(laggard?.pct), style: { fontSize: '10px', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '弱 ' + (laggard?.name || '')),
          h('span', { class: 'dim' }, expand === g ? '▾' : '▸'));
        bd.append(head);
        if (expand === g) {
          for (const Q of sorted.slice(0, 10)) {
            bd.append(h('div', { class: 'symrow', style: { display: 'flex', gap: '10px', padding: '3px 10px 3px 26px', borderBottom: '1px solid color-mix(in srgb, var(--line) 25%, transparent)', cursor: 'pointer' }, onclick: () => selectSymbol(Q.sym) },
              h('span', { style: { flex: 1 } }, Q.name || Q.sym),
              h('span', { class: 'num' }, F.price(Q.price)),
              h('span', { class: 'num ' + F.cls(Q.pct) }, F.pct(Q.pct)),
              h('span', { class: 'num dim', style: { fontSize: '10px' } }, F.big(Q.amt || 0))));
          }
        }
      }
      card.setBadge(`${groups.filter(g => g !== '指数').length} 品类`);
    }
    render();
    const offQ = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(render, 1200); });
    card.api.destroy = () => offQ();
    card.api.refresh = render;
  },
});

/* ================= 信号雷达: 机会 / 风险 / 背离 / 异常 / 共振 ================= */
const SCAN_EXTRA = ['idx:sh000001', 'idx:sz399006', 'idx:usDJI', 'idx:usIXIC', 'idx:usINX', 'idx:int_hangseng', 'idx:int_nikkei', 'idx:int_ftse', 'fut:hf_CHA50CFD', 'fut:hf_GC', 'fut:hf_CL', 'fx:fx_susdcnh', 'crypto:BTCUSDT', 'crypto:ETHUSDT', 'crypto:SOLUSDT'];
const klineCache = new Map();   // sym -> {ts, bars}

async function scanSet() {
  const set = new Set([...S.watchlist, ...SCAN_EXTRA]);
  const take = (g, n) => S.universe.filter(u => u.group === g).slice(0, n).forEach(u => set.add(u.sym));
  take('加密货币', 10); take('美股', 8); take('A股', 6); take('港股', 4);
  return [...set].slice(0, 48);
}

async function ensureKlines(sym, maxAge = 10 * 60 * 1000) {
  const c = klineCache.get(sym);
  if (c && Date.now() - c.ts < maxAge) return c.bars;
  try {
    const d = await getKline(sym, '1d', 90);
    const bars = d.bars || [];
    klineCache.set(sym, { ts: Date.now(), bars });
    return bars;
  } catch { return c?.bars || []; }
}

/* 单品种信号计算 — 全部基于日线, 科学化定义 (零波动/稳定币类品种自动跳过) */
function signalsOf(sym, bars) {
  const out = [];
  if (!bars || bars.length < 40) return out;
  const closes = bars.map(b => b.c), vols = bars.map(b => b.v || 0);
  const n = closes.length - 1, c = closes[n];
  // 波动率门限: 日收益标准差 < 0.15% 视为近似零波动 (稳定币/停牌), 不产生技术信号
  const rets = [];
  for (let i = Math.max(1, n - 60); i <= n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const sdAll = Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / (rets.length || 1));
  if (sdAll < 0.0015) return out;
  const rsi = RSI(closes, 14), sma5 = SMA(closes, 5), sma10 = SMA(closes, 10), sma20 = SMA(closes, 20);
  // --- 背离: 价格新高/新低 vs RSI 不确认 ---
  /* win = closes.slice(-25, -1): 全局索引 [n-24, n-1], 即 win[i] 对应 closes[n-24+i]。
   * 此前顶背离写成 n-5+hiIdx、底背离写成 n-24+loIdx —— 两处本该同一个映射却不一致,
   * 顶背离取到的根本不是那个前高(且常越界成 undefined), 于是顶背离信号几乎永不触发。 */
  const WIN_OFF = 24;
  const win = closes.slice(-25, -1);
  const hiIdx = win.indexOf(Math.max(...win)), loIdx = win.indexOf(Math.min(...win));
  if (c >= Math.max(...win) * 0.999 && hiIdx < win.length - 3) {
    const rsiNow = rsi[n], rsiPrev = rsi[n - WIN_OFF + hiIdx];
    if (isFinite(rsiNow) && isFinite(rsiPrev) && rsiNow < rsiPrev - 2)
      out.push({ type: '顶背离', dir: -1, score: 2.2, desc: `价创新高但 RSI 由 ${rsiPrev.toFixed(0)} 降至 ${rsiNow.toFixed(0)}, 上行动能衰减` });
  }
  if (c <= Math.min(...win) * 1.001 && loIdx < win.length - 3) {
    const rsiNow = rsi[n];
    const rsiAtPrevLow = rsi[n - WIN_OFF + loIdx];
    if (isFinite(rsiNow) && isFinite(rsiAtPrevLow) && rsiNow > rsiAtPrevLow + 2)
      out.push({ type: '底背离', dir: 1, score: 2.2, desc: `价创新低但 RSI 由 ${rsiAtPrevLow.toFixed(0)} 升至 ${rsiNow.toFixed(0)}, 下行动能衰竭` });
  }
  // --- 异常波动: 日收益 vs 自身 60 日分布 (|z| > 2.5) ---
  if (rets.length >= 30) {
    const m = rets.slice(0, -1).reduce((a, b) => a + b, 0) / (rets.length - 1);
    const sd = Math.sqrt(rets.slice(0, -1).reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 2)) || 1e-9;
    const z = (rets[rets.length - 1] - m) / sd;
    if (Math.abs(z) > 2.5)
      out.push({ type: '异常波动', dir: z > 0 ? 1 : -1, score: Math.min(3, 1.2 + Math.abs(z) / 4), desc: `日收益偏离自身分布 ${z.toFixed(1)}σ (${(rets[rets.length - 1] * 100).toFixed(2)}%)` });
  }
  // --- 放量突破 / 放量破位 ---
  const avgV = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 || 1;
  const hi20 = Math.max(...closes.slice(-21, -1)), lo20 = Math.min(...closes.slice(-21, -1));
  const vr = vols[n] / avgV;
  if (vr > 2.2 && c > hi20 * 0.998) out.push({ type: '放量突破', dir: 1, score: Math.min(3, 1.5 + vr / 5), desc: `突破 20 日高点, 量比 ${vr.toFixed(1)}×` });
  if (vr > 2.2 && c < lo20 * 1.002) out.push({ type: '放量破位', dir: -1, score: Math.min(3, 1.5 + vr / 5), desc: `跌破 20 日低点, 量比 ${vr.toFixed(1)}×` });
  // --- 均线排列 (趋势共振单品种维度) ---
  if ([sma5[n], sma10[n], sma20[n]].every(isFinite)) {
    if (c > sma5[n] && sma5[n] > sma10[n] && sma10[n] > sma20[n]) out.push({ type: '多头排列', dir: 1, score: 1.3, desc: 'MA5>MA10>MA20, 短中期趋势共振向上' });
    if (c < sma5[n] && sma5[n] < sma10[n] && sma10[n] < sma20[n]) out.push({ type: '空头排列', dir: -1, score: 1.3, desc: 'MA5<MA10<MA20, 趋势共振向下' });
  }
  // --- RSI 极值 ---
  if (isFinite(rsi[n])) {
    if (rsi[n] < 28) out.push({ type: '超卖', dir: 1, score: 1.1, desc: `RSI=${rsi[n].toFixed(0)}, 统计上处于超卖区` });
    if (rsi[n] > 72) out.push({ type: '超买', dir: -1, score: 1.1, desc: `RSI=${rsi[n].toFixed(0)}, 统计上处于超买区` });
  }
  return out;
}

registerCard({
  type: 'radar', title: '信号雷达', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const gauge = h('div', { class: 'card-tools', style: { minHeight: '26px' } });
    const tabs = h('div', { class: 'card-tools' });
    const body = h('div', { style: { flex: '1', overflowY: 'auto', minHeight: '0' } });
    bd.append(gauge, tabs, body);
    let tab = '机会', signals = [], rescanned = 0, scanning = false;

    function renderTabs() {
      tabs.innerHTML = '';
      ['机会', '风险', '共振', '信号流'].forEach(t =>
        tabs.append(h('button', { class: 'chip' + (tab === t ? ' on' : '') + (t === '机会' && countDir(1) ? ' up' : '') , onclick: () => { tab = t; renderTabs(); renderBody(); } },
          t + (t === '机会' && countDir(1) ? ` ${countDir(1)}` : t === '风险' && countDir(-1) ? ` ${countDir(-1)}` : ''))));
      tabs.append(h('span', { class: 'dim', style: { fontSize: '9px', marginLeft: 'auto' } }, scanning ? '扫描中…' : `${signals.length} 信号 · ${Math.round((Date.now() - rescanned) / 60000)}分前`));
    }
    const countDir = d => signals.filter(s => s.dir === d).length;

    /* --- 市场状态仪表: 跨资产风险偏好 + 广度 --- */
    function renderGauge() {
      gauge.innerHTML = '';
      const G = ['A股', '港股', '美股', '加密货币'].map(g => {
        const pool = S.universe.filter(u => u.group === g).map(u => S.quotes[u.sym]).filter(q => q && isFinite(q.pct));
        return { g, med: pool.length ? medianOf(pool.map(q => q.pct)) : null, upPct: pool.length ? pool.filter(q => q.pct > 0).length / pool.length : null };
      }).filter(x => x.med != null);
      const eq = G.filter(x => ['A股', '港股', '美股'].includes(x.g));
      const btc = S.quotes['crypto:BTCUSDT']?.pct, gold = S.quotes['fut:hf_GC']?.pct;
      const riskOn = G.filter(x => x.med > 0.8).length, riskOff = G.filter(x => x.med < -0.8).length;
      let regime = '中性', cls = 'flat', note = '';
      if (riskOn >= 2 && (btc == null || btc > 0)) { regime = 'Risk-ON 风险偏好上升'; cls = 'up'; note = '权益与加密同步走强'; }
      else if (riskOff >= 2 || (btc != null && btc < -3 && eq.some(x => x.med < -0.8))) { regime = 'Risk-OFF 避险模式'; cls = 'down'; note = '多资产普跌, 关注黄金/美元对冲'; }
      else if (riskOn >= 1 && riskOff >= 1) { regime = '分化 / 轮动'; note = '市场间背离, 结构性行情'; }
      gauge.append(h('span', { class: cls, style: { fontWeight: 'bold' } }, '◆ ' + regime), h('span', { class: 'dim', style: { fontSize: '10px' } }, note ? ' · ' + note : ''));
      G.forEach(x => gauge.append(h('span', { class: 'num ' + F.cls(x.med), style: { fontSize: '10px', marginLeft: '8px' } }, `${x.g} ${F.pct(x.med)}`)));
    }
    const medianOf = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };

    /* 扫描节流: 数据源不可用时 signals 恒为空, 而 renderBody 会因"暂无信号"再次触发 scan,
     * 形成不间断的自重扫 —— 既打满客户端, 也会把上游打到限流。无论成功失败都必须间隔。 */
    let lastScanTs = 0;
    const SCAN_MIN_GAP = 60 * 1000;      // 两次扫描的最小间隔
    const SCAN_CONC = 6;                 // 受控并发: 一次并发几十个 K线请求容易触发上游限流

    async function scan(force = false) {
      if (scanning) return;
      if (!force && Date.now() - lastScanTs < SCAN_MIN_GAP) return;
      scanning = true; renderTabs();
      try {
        const syms = await scanSet();
        const results = [];
        for (let i = 0; i < syms.length; i += SCAN_CONC) {
          const part = await Promise.all(syms.slice(i, i + SCAN_CONC).map(async sym => ({ sym, bars: await ensureKlines(sym) })));
          results.push(...part);
        }
        const next = [];
        for (const { sym, bars } of results)
          for (const s of signalsOf(sym, bars)) next.push({ sym, ...s, name: S.quotes[sym]?.name || symName(sym), t: Date.now() });
        signals = next;
        rescanned = Date.now();
      } finally {
        // 失败也要记时间, 否则失败会立即重扫
        lastScanTs = Date.now(); scanning = false;
        renderGauge(); renderTabs(); renderBody();
      }
    }

    /* --- 共振: 品类同向 + 跨市场 --- */
    function resonance() {
      const out = [];
      for (const g of ['A股', '港股', '美股', '加密货币', '期货', '外汇']) {
        const pool = S.universe.filter(u => u.group === g).map(u => S.quotes[u.sym]).filter(q => q && isFinite(q.pct) && !q.sym.startsWith('idx'));
        if (pool.length < 4) continue;
        const up = pool.filter(q => q.pct > 1).length, dn = pool.filter(q => q.pct < -1).length;
        if (up / pool.length >= 0.7) out.push({ g, dir: 1, ratio: up / pool.length, n: pool.length, med: medianOf(pool.map(q => q.pct)), strong: pool.sort((a, b) => b.pct - a.pct)[0] });
        else if (dn / pool.length >= 0.7) out.push({ g, dir: -1, ratio: dn / pool.length, n: pool.length, med: medianOf(pool.map(q => q.pct)), strong: pool.sort((a, b) => a.pct - b.pct)[0] });
      }
      return out;
    }

    function renderBody() {
      body.innerHTML = '';
      if (tab === '共振') {
        const rs = resonance();
        if (!rs.length) body.append(h('div', { class: 'hint' }, '当前无品类级共振 (阈值: 同一品类内 ≥70% 品种同向且 |pct|>1%)。无共振 = 存在轮动与对冲空间。'));
        for (const r of rs) {
          body.append(h('div', { class: 'agent-line', style: { cursor: 'pointer' }, onclick: () => r.strong && selectSymbol(r.strong.sym) },
            h('span', { class: r.dir > 0 ? 'up' : 'down' }, r.dir > 0 ? '▲ 同向上涨共振' : '▼ 同向下跌共振'),
            h('span', { class: 'ac' }, ` ${r.g} `),
            h('span', { class: 'aa' }, `${Math.round(r.ratio * 100)}% (${r.n}只) 中位 ${F.pct(r.med)} · 领头 ${r.strong?.name}`)));
        }
        const idx = ['idx:sh000001', 'idx:usIXIC', 'crypto:BTCUSDT', 'fut:hf_CHA50CFD'].map(s => ({ s, q: S.quotes[s] })).filter(x => x.q);
        const allUp = idx.every(x => x.q.pct > 0), allDn = idx.every(x => x.q.pct < 0);
        if (allUp || allDn) body.append(h('div', { class: 'agent-line' },
          h('span', { class: allUp ? 'up' : 'down' }, '◆ 跨市场共振: '),
          h('span', { class: 'aa' }, idx.map(x => `${x.q.name} ${F.pct(x.q.pct)}`).join(' · '))));
        return;
      }
      let list = signals;
      if (tab === '机会') list = signals.filter(s => s.dir > 0);
      if (tab === '风险') list = signals.filter(s => s.dir < 0);
      list = [...list].sort((a, b) => b.score - a.score);
      if (!list.length) {
        body.append(h('div', { class: 'hint' }, tab === '机会' ? '暂无机会信号 — 扫描继续运行' : tab === '风险' ? '暂无风险信号' : '暂无信号'));
        if (!signals.length && !scanning) scan();
        return;
      }
      for (const s of list.slice(0, 40)) {
        body.append(h('div', { class: 'agent-line', style: { cursor: 'pointer' }, onclick: () => selectSymbol(s.sym) },
          h('span', { class: s.dir > 0 ? 'up' : 'down', style: { display: 'inline-block', minWidth: '58px' } }, `${s.dir > 0 ? '▲' : '▼'} ${s.type}`),
          h('span', { class: 'ac' }, ` ${s.name} `),
          h('span', { class: 'aa' }, s.desc),
          h('span', { class: 'dim', style: { float: 'right' } }, '强度 ' + s.score.toFixed(1))));
      }
    }

    renderGauge(); renderTabs(); renderBody();
    scan(true);                          // 首次进入立即扫一次
    const scanTimer = setInterval(() => { renderGauge(); if (Date.now() - rescanned > 10 * 60 * 1000) scan(); }, 60000);
    const offSym = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(() => { renderGauge(); renderTabs(); if (tab === '共振') renderBody(); }, 2000); });
    card.api.destroy = () => { clearInterval(scanTimer); offSym(); };
    card.api.refresh = () => { klineCache.clear(); scan(true); };
  },
});
