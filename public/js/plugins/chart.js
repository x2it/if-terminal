/* 图表插件: K线/分时 (周期切换 · 指标切换 · 全局联动) */
import { S, bus, selectSymbol, symName } from '../core.js';
import { h } from '../ui.js';
import { registerCard } from '../grid.js';
import { getKline } from '../api.js';
import { CandleChart } from '../chart.js';
import { F } from '../fmt.js';
import { bucketStart, BAR_NOMINAL_MS } from '../period.js';

const PERIODS = [
  ['min', '分时'], ['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['1h', '时'], ['4h', '4时'],
  ['1d', '日'], ['1w', '周'], ['1M', '月'], ['1q', '季'], ['1Y', '年'],
];
/* 各品类真正拿得到哪些周期 —— 必须与服务端分派严格一致, 否则就是给用户一个注定报错或
 * 和别的周期重合的按钮(假功能)。
 *   · 加密货币: 分时(min, 币安1m折线) + 真分钟K线(1m/5m/15m/30m/1h/4h, 币安 OHLC)
 *   · 腾讯系股票/指数: 只有 分时(min) + 日/周/月/季/年。分钟级 K 线柱免费源没有, 不显示。
 *   · 期货/外汇: 只有 日/周/月/季/年 (新浪外盘仅日线, 长周期由服务端聚合)。 */
const CRYPTO_ONLY = new Set(['1m', '5m', '15m', '30m', '1h', '4h']);
const TX_PERIODS = new Set(['min', '1d', '1w', '1M', '1q', '1Y']);
const FUT_FX_PERIODS = new Set(['1d', '1w', '1M', '1q', '1Y']);

const PERIOD_LABEL = Object.fromEntries(PERIODS);   // 1Y → 年, 1M → 月 ...
function supports(sym, p) {
  if (sym.startsWith('crypto:')) return p === 'min' || CRYPTO_ONLY.has(p);
  if (sym.startsWith('fut:') || sym.startsWith('fx:')) return FUT_FX_PERIODS.has(p);
  return TX_PERIODS.has(p);
}
/* 日及以上的 bar 与"当日最高/最低"同口径, 才允许用报价里的 high/low 去顶 / 探。
 * 加密货币的 high/low 是 24 小时滚动窗口, 和任何一根 K 线都不同口径 —— 照搬就会造出比真实更高的影线。 */
const DAY_PLUS = new Set(['1d', '1w', '1M', '1q', '1Y']);
const RELOAD_MIN_GAP = 10000;   // 静默重载节流: 服务端才是对真相负责的那一方, 但别把它打爆

registerCard({
  type: 'kline', title: '行情图表', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const tools = h('div', { class: 'card-tools' });
    const cvBox = h('div', { style: { flex: '1', position: 'relative', minHeight: '0', cursor: 'crosshair' } });
    const cv = h('canvas', { class: 'block' });
    cvBox.append(cv);
    bd.append(tools, cvBox);

    const chart = new CandleChart(cv);
    let sym = S.selected, period = '1d';
    let seq = 0;
    let lastPrice = null;          // 已贴到图上的最后一个价格, 用于短路无变化的推送
    let lastReload = 0;
    let align = 'bj';              // 当前数据集的日历口径, 由服务端在 /api/kline 里给出
    const live = h('span', { class: 'num', style: { fontSize: '10px', marginLeft: '8px' } });

    function renderTools() {
      tools.innerHTML = '';
      tools.append(h('span', { style: { color: 'var(--amber)', fontWeight: 'bold', marginRight: '6px' } }, symName(sym)));
      tools.append(h('span', { class: 'dim', style: { fontSize: '9px', marginRight: '8px' } }, sym));
      for (const [p, label] of PERIODS) {
        if (!supports(sym, p)) continue;
        tools.append(h('button', { class: 'chip' + (period === p ? ' on' : ''), onclick: () => { period = p; load(); } }, label));
      }
      const subSel = h('select', { class: 'mini-input', style: { marginLeft: 'auto', width: 'auto', fontSize: '10px' } },
        h('option', { value: 'macd' }, 'MACD'), h('option', { value: 'rsi' }, 'RSI'), h('option', { value: 'none' }, '无副图'));
      subSel.value = chart.sub;
      subSel.addEventListener('change', () => { chart.sub = subSel.value; chart.draw(); });
      tools.append(subSel, live);
      const Q = S.quotes[sym];
      if (Q?.price != null) paintLive(Q);
    }

    function paintLive(q) {
      live.className = 'num ' + F.cls(q.pct);
      const txt = `${F.price(q.price)} ${F.pct(q.pct)}`;
      if (live.textContent === txt) return;
      live.textContent = txt;
      // 每次价格真的变了就闪一下 —— 否则"图表是否在动"只能靠用户对着像素猜
      live.style.transition = 'none'; live.style.opacity = '0.3';
      requestAnimationFrame(() => { live.style.transition = 'opacity .5s ease-out'; live.style.opacity = '1'; });
    }

    const LIM = () => (sym.startsWith('crypto:') ? 500 : 320);

    async function load() {
      renderTools();
      card.setBadge('加载中…');
      const mySeq = ++seq;
      try {
        const data = await getKline(sym, period, LIM());
        if (mySeq !== seq) return;
        lastPrice = null;
        chart.period = period;
        align = data.align === 'utc' ? 'utc' : 'bj';
        chart.setData(sym, data);
        card.setBadge(badgeText(data));
      } catch (e) {
        if (mySeq === seq) card.setBadge('加载失败: ' + e.message);
      }
    }

    /* 数据年龄必须写在脸上: 上游限流时会退回到缓存, 那是真实历史但不是最新一帧。
     * 不给用户看年龄, 就等于让他拿着旧数据当实时数据做判断。 */
    function badgeText(data) {
      const kind = data.kind === 'line' ? '分时' : (PERIOD_LABEL[period] || period);
      let s = `${data.bars.length} 根 · ${kind}`;
      if (data.stale) s += ` · ${F.ago(data.ageMs)}`;
      return s;
    }

    /* 跨周期边界时向服务端取一次真相, 但要保住用户正在看的区间:
     * 直接调 setData 会 resetView, 把人家拖了半天的视野一脚踹回最新一根。 */
    async function reloadQuiet() {
      const now = Date.now();
      if (now - lastReload < RELOAD_MIN_GAP) return;
      lastReload = now;
      const prev = chart.bars, span = chart.view.to - chart.view.from;
      const stick = chart.view.to >= prev.length;             // 原本吸附在最右侧 → 重载后继续吸附
      const anchorT = prev[Math.min(prev.length - 1, chart.view.to - 1)]?.t;
      const mySeq = ++seq;
      try {
        const data = await getKline(sym, period, LIM());
        if (mySeq !== seq) return;
        lastPrice = null;
        chart.period = period;
        align = data.align === 'utc' ? 'utc' : 'bj';
        chart.setData(sym, data);
        if (!stick && anchorT != null) {                      // 用户在看历史: 把同一根 anchor 的位置还原回去
          const i = data.bars.findIndex(b => b.t === anchorT);
          if (i >= 0) {
            const to = Math.min(data.bars.length, i + 1);
            chart.view = { from: Math.max(0, to - span), to };
          }
        }
        chart.draw();
        card.setBadge(badgeText(data));
      } catch { /* 静默重载失败不应打扰用户 —— 手上的数据还有效, 下个周期边界会重试 */ }
    }

    /* 报价里的 high/low 只有在"和当前这根 bar 是同一时间区间"时才可用:
     *   · bar 必须是日及以上 —— 1 分钟 bar 配当日最高, 影线会被拉到荒谬的长度;
     *   · 品种不能是加密货币 —— 币安的 highPrice/lowPrice 是过去 24 小时滚动窗口,
     *     和任何一根 K 线都不同口径(日线是 UTC 日), 照搬会画出一根根本没有过的高点。 */
    function isHighLowUsable(unit, q) {
      return DAY_PLUS.has(unit) && !sym.startsWith('crypto:') && q.high > 0 && q.low > 0;
    }

    /* ---------- 实时贴价: 让最后一根 bar 跟着 SSE 推送的现价走。
     * 这是"图表活着"与"图表只是张截图"的分界线, 也是本卡唯一允许改动 bar 的地方。
     * 四条硬规矩:
     *   1) 只改最后一根的 c / h / l。v 一律不动 —— 报价里的 vol 是当日累计值,
     *      与单根 bar 的量不是同一个口径, 覆盖上去就是编数据。
     *   2) h / l 单向扩张(max / min): 这是 K 线本身的定义, 上涨过的
     *      最高点不会因为回落而消失, 不是插值伪造。
     *   3) 跨周期边界时"开一根新的", 而不是把旧 bar 无限拉长; 同时排一次静默重载,
     *      让服务端来盖棺定论(本地只负责这几秒的画面连续性)。
     *   4) 不动用户的视图。只有当用户本来就吸附在最右侧时才跟着右移。
     * ------------------------------------------------------------------ */
    function applyLive(q) {
      const price = q.price;
      if (!(price > 0)) return;
      if (price === lastPrice) return;        // 收盘后 / 无成交: 上游没动, 本地一次重绘都不做
      lastPrice = price;
      paintLive(q);
      const bars = chart.bars;
      if (!bars.length) return;
      const unit = chart.kind === 'line' ? '1m' : period;    // 分时 line 的每个点就是 1 分钟
      const last = bars[bars.length - 1];
      /* 比的是"桶", 不是 t 本身 —— 服务端给的最后一根 t 往往就不是桶起点:
       * 腾讯周K 取本周首个交易日(节假日时会是周五), 币安日K 取 UTC 零点。要求严格相等会在这些
       * 完全正常的品种上误判成"跨了一根"。 */
      const cur = bucketStart(Date.now(), unit, align);
      const curLast = bucketStart(last.t, unit, align);
      if (cur == null || curLast == null) return;
      const step = BAR_NOMINAL_MS[unit];

      if (cur === curLast) {                  // 同一根: 就地更新
        const hi0 = isHighLowUsable(unit, q) ? q.high : null, lo0 = isHighLowUsable(unit, q) ? q.low : null;
        last.c = price;
        last.h = Math.max(last.h, price, hi0 ?? price);
        last.l = Math.min(last.l, price, lo0 ?? price);
      } else if (cur > curLast) {             // 跨了一根: 该不该有这一根, 本地说了不算
        if (step && cur - curLast > step * 1.5) { reloadQuiet(); return; }   // 缺口不止一根(休眠醒来等) → 本地无权补
        /* 加密货币 7×24 不停盘, 分时又一定跟着交易时间走 —— 这两种情况下新一根必然存在, 本地可以先画出来
         * 保证画面不断档。其余品种都会休市: 非交易日里价格偶尔跳一下, 本地就把本来不该存在的一天
         * 画成一根真 K 线 —— 那种东西宁可由服务端判生杀, 也不在本地编。 */
        const seamless = sym.startsWith('crypto:') || chart.kind === 'line';
        if (!seamless) { reloadQuiet(); return; }
        const o = last.c;
        bars.push({ t: cur, o, c: price, h: Math.max(o, price), l: Math.min(o, price), v: 0 });
        if (chart.view.to >= bars.length - 1) {   // 只有吸附在右边缘时才跟着走进新的这一根
          chart.view.from = Math.max(0, chart.view.from + 1);
          chart.view.to = bars.length;
        }
        if (bars.length > 1500) {                 // 长周期跑太久时截尾, 避免内存无上限增长
          const cut = bars.length - 1500;
          bars.splice(0, cut);
          chart.view.from = Math.max(0, chart.view.from - cut);
          chart.view.to = Math.max(chart.view.from + 1, chart.view.to - cut);
        }
        reloadQuiet();
      } else {                                // 服务端那根比本地算的还新: 以服务端为准, 别用 tick 污染它
        reloadQuiet();
        return;
      }
      chart.calc();
      chart.draw();
    }

    const offSym = bus.on('symbol', s => { if (s !== sym) { sym = s; if (!supports(s, period)) period = '1d'; load(); } });
    const offX = bus.on('xhair', (data, src) => {
      if (data.sym && data.sym !== sym) return;
      if (data.clear) { chart.cross = null; chart.draw(); }
      else if (!chart.cross) { const c = chart.crossFromT(data.t); if (c) { chart.cross = c; chart.draw(c); } }
    });
    const offTheme = bus.on('theme', () => chart.draw());
    const offUp = bus.on('upred', () => { chart.calc(); chart.draw(); });
    /* SSE 每几秒推一次全市场报价; 用 rAF 合流, 避免同一帧内多次重算 */
    let pendingQ = null, raf = 0, liveDead = false;
    const offQ = bus.on('quotes', list => {
      if (!list || chart.drag) return;          // 正在拖拽时不动画面, 免得手感打架
      const q = list.find(x => x.sym === sym);
      if (!q) return;
      pendingQ = q;
      if (raf || liveDead) return;
      raf = requestAnimationFrame(() => {
        raf = 0; const qq = pendingQ; pendingQ = null;
        /* 实时路径必须自带兜底: 它在 rAF 回调里, 抛出的异常只会在控制台留一行,
         * 页面照常显示"数据在动"(价格文字会更新)而图形其实已经卡死 —— 极难自查。
         * 出错就停止本卡片的实时贴价并报一次, 宁可让图表退化成静态, 也不静默地半死不活。 */
        try { applyLive(qq); } catch (e) {
          liveDead = true;
          console.error('[IF] 图表实时贴价异常, 已停止该卡片的实时更新:', e);
          const bEl = card.el.querySelector('.card-badge');
          card.setBadge((bEl?.textContent ? bEl.textContent + ' · ' : '') + '实时中断');
        }
      });
    });
    card.api.destroy = () => {
      chart.destroy(); offSym(); offX(); offTheme(); offUp(); offQ();
      if (raf) cancelAnimationFrame(raf);
    };
    card.api.refresh = load;
    load();
  },
});
