/* K线图引擎: 蜡烛 + 成交量 + MACD/RSI 副图 · 滚轮缩放 · 拖拽平移 · 十字光标全局联动 */
import { F } from './fmt.js';
import { S, bus, BC, OID, selectSymbol } from './core.js';
import { SMA, EMA, MACD, RSI } from './quant.js';

const UP_RED = () => S.upRed;

export class CandleChart {
  constructor(canvas, { onSelect } = {}) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.bars = [];
    this.kind = 'candle';
    this.view = { from: 0, to: 0 };          // 可见 bar 索引
    this.cross = null;                        // {i, x, y}
    this.sub = 'macd';                        // macd | rsi | vol-only
    this.mas = { ma5: true, ma10: true, ma20: true, ma60: false };
    this.onSelect = onSelect;
    this.sym = null;
    this.hoverTip = null;
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('mousedown', e => this.onDown(e));
    canvas.addEventListener('mousemove', e => this.onMove(e));
    canvas.addEventListener('mouseup', () => this.drag = null);
    canvas.addEventListener('mouseleave', () => { this.cross = null; this.drag = null; this.draw(); bus.emit('xhair', { sym: this.sym, clear: true }); });
    canvas.addEventListener('dblclick', () => this.resetView());
    // 触控: 单指平移+十字光标, 双指捏合缩放
    let pinch = null;
    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 1) {
        this.drag = { x: e.touches[0].clientX - canvas.getBoundingClientRect().left, from: this.view.from };
      } else if (e.touches.length === 2) {
        const [a, b] = e.touches;
        pinch = { d: Math.abs(a.clientX - b.clientX), span: this.view.to - this.view.from, mid: (a.clientX + b.clientX) / 2 };
        this.drag = null;
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.touches.length === 1 && this.drag) {
        this.onMove({ offsetX: e.touches[0].clientX - r.left, offsetY: e.touches[0].clientY - r.top, preventDefault() {} });
      } else if (e.touches.length === 2 && pinch) {
        const [a, b] = e.touches;
        const d = Math.abs(a.clientX - b.clientX);
        const k = Math.max(0.2, Math.min(5, pinch.d / (d || 1)));
        const n = this.bars.length;
        const ns = Math.round(Math.min(n, Math.max(15, pinch.span * k)));
        const midX = pinch.mid - r.left;
        const midI = Math.floor((midX - this.AXW) / this.barW) + this.view.from;
        let from = Math.round(midI - (midI - this.view.from) * (ns / (pinch.span || 1)));
        from = Math.max(0, Math.min(n - ns, from));
        this.view = { from, to: from + ns };
        this.draw();
      }
    }, { passive: false });
    canvas.addEventListener('touchend', e => {
      if (e.touches.length === 0) { this.drag = null; pinch = null; }
      else if (e.touches.length === 1) pinch = null;
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    this.resize();
  }
  destroy() { this.ro.disconnect(); }

  setData(sym, data) {
    this.sym = sym;
    this.bars = data.bars || [];
    this.kind = data.kind || 'candle';
    // 分时折线按"现价是否高于首根开盘"染色: 此前的 lastCloseUp 从未被赋值,
    // 分支恒走蓝色兜底 —— 分时图永远一种蓝, 看不出涨跌。这里在加载时算一次。
    this.lastCloseUp = this.bars.length ? this.bars[this.bars.length - 1].c >= this.bars[0].o : true;
    this.calc();
    this.resetView();
  }
  resetView() {
    const n = this.bars.length;
    const show = Math.min(n, this.kind === 'line' ? n : 140);
    this.view = { from: Math.max(0, n - show), to: n };
    this.draw();
  }
  resize() {
    // canvas 尚未挂载到 DOM 时 (卡片刚创建/已移除) 没有父元素, 直接跳过, 不要抛错
    const r = this.cv.parentElement?.getBoundingClientRect();
    if (!r) return;
    const dpr = devicePixelRatio || 1;
    if (r.width < 10 || r.height < 10) return;
    this.cv.width = r.width * dpr; this.cv.height = r.height * dpr;
    this.W = r.width; this.H = r.height;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  calc() {
    const c = this.bars.map(b => b.c);
    this.ind = {
      ma5: SMA(c, 5), ma10: SMA(c, 10), ma20: SMA(c, 20), ma60: SMA(c, 60),
      macd: MACD(c), rsi: RSI(c, 14),
    };
  }

  onWheel(e) {
    e.preventDefault();
    const n = this.bars.length; if (!n) return;
    const span = this.view.to - this.view.from;
    const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    let ns = Math.round(Math.min(n, Math.max(15, span * k)));
    const mid = this.cross?.i ?? (this.view.from + this.view.to) / 2;
    let from = Math.round(mid - (mid - this.view.from) * (ns / span));
    from = Math.max(0, Math.min(n - ns, from));
    this.view = { from, to: from + ns };
    this.draw();
  }
  onDown(e) { this.drag = { x: e.offsetX, from: this.view.from }; }
  onMove(e) {
    if (this.drag) {
      const bw = this.barW;
      const shift = Math.round((this.drag.x - e.offsetX) / bw);
      const n = this.bars.length, span = this.view.to - this.view.from;
      let from = Math.max(0, Math.min(n - span, this.drag.from + shift));
      this.view = { from, to: from + span };
    }
    const i = this.barAt(e.offsetX);
    this.cross = i >= 0 ? { i, x: e.offsetX, y: e.offsetY } : null;
    if (this.cross) {
      const b = this.bars[i];
      bus.emit('xhair', { sym: this.sym, t: b?.t, p: b?.c, from: 'chart' });
      if (BC) BC.postMessage({ t: 'xhair', data: { sym: this.sym, t: b?.t, p: b?.c }, oid: OID });
    }
    this.draw();
  }
  barAt(x) {
    const n = this.view.to - this.view.from;
    const i = Math.floor((x - this.AXW) / this.barW) + this.view.from;
    return (i >= this.view.from && i < this.view.to + 1 && x > this.AXW) ? Math.min(i, this.bars.length - 1) : -1;
  }

  draw(extCross) {
    const g = this.g; if (!this.W) return;
    const { W, H, bars } = this;
    const upC = UP_RED() ? '#ff5757' : '#1fc98e';
    const dnC = UP_RED() ? '#1fc98e' : '#ff5757';
    const fg = getComputedStyle(document.body).getPropertyValue('--fg') || '#d8e3f0';
    const dim = getComputedStyle(document.body).getPropertyValue('--dim') || '#5c7288';
    const line = getComputedStyle(document.body).getPropertyValue('--line') || '#1a2739';
    g.clearRect(0, 0, W, H);
    if (!bars.length) { g.fillStyle = dim; g.font = '11px monospace'; g.fillText('加载行情中…', 12, 22); return; }

    this.AXW = 56;
    const PAD_T = 8, SUB_H = this.sub === 'none' ? 0 : Math.round((H - 24) * 0.22);
    const MAIN_H = H - 24 - SUB_H - PAD_T;
    const L = 4, R = W - this.AXW;
    const vw = this.view.to - this.view.from;
    this.barW = Math.max(1.5, (R - L) / vw);
    const vis = bars.slice(this.view.from, this.view.to);
    let hi = -Infinity, lo = Infinity, vmax = 0;
    for (const b of vis) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); vmax = Math.max(vmax, b.v || 0); }
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    hi += pad; lo -= pad;
    const rng = hi - lo || 1;
    const X = i => L + (i - this.view.from) * this.barW + this.barW / 2;
    const Y = v => PAD_T + (hi - v) / rng * MAIN_H;
    this.XY = { X, Y, hi, lo, vmax };

    // 网格 + 右轴价格
    g.font = '9px ' + 'monospace'; g.textBaseline = 'middle';
    for (let k = 0; k <= 5; k++) {
      const v = lo + rng * k / 5, y = Y(v);
      g.strokeStyle = line; g.globalAlpha = .5; g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = dim; g.textAlign = 'left'; g.fillText(this.fmtP(v), R + 5, y);
    }
    // 时间轴
    const tickN = Math.min(8, vw);
    g.textAlign = 'center';
    for (let k = 0; k <= tickN; k++) {
      const i = this.view.from + Math.floor(vw * k / tickN);
      const b = bars[i]; if (!b) continue;
      g.fillStyle = dim; g.fillText(this.fmtT(b.t), Math.min(W - 26, Math.max(20, X(i))), H - 10);
    }

    // 成交量 (主图底部 12%)
    const VH = MAIN_H * 0.14;
    vis.forEach((b, k) => {
      const i = this.view.from + k;
      const hgt = vmax ? (b.v || 0) / vmax * VH : 0;
      g.fillStyle = b.c >= b.o ? upC : dnC; g.globalAlpha = .35;
      g.fillRect(X(i) - this.barW / 2, PAD_T + MAIN_H - hgt, Math.max(1, this.barW - 1), hgt);
      g.globalAlpha = 1;
    });

    // 蜡烛 / 线
    if (this.kind === 'line') {
      g.beginPath();
      vis.forEach((b, k) => { const i = this.view.from + k; k ? g.lineTo(X(i), Y(b.c)) : g.moveTo(X(i), Y(b.c)); });
      g.strokeStyle = this.lastCloseUp ? upC : '#4d9fff'; g.lineWidth = 1.4; g.stroke();
      g.lineTo(X(this.view.to - 1), PAD_T + MAIN_H); g.lineTo(X(this.view.from), PAD_T + MAIN_H); g.closePath();
      g.fillStyle = (this.lastCloseUp ? upC : '#4d9fff') + '14'; g.fill();
    } else {
      const bw = Math.max(1, this.barW * 0.72);
      vis.forEach((b, k) => {
        const i = this.view.from + k;
        const up = b.c >= b.o;
        g.strokeStyle = up ? upC : dnC; g.fillStyle = up ? upC : dnC;
        g.beginPath(); g.moveTo(X(i), Y(b.h)); g.lineTo(X(i), Y(b.l)); g.lineWidth = 1; g.stroke();
        const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c));
        g.fillRect(X(i) - bw / 2, y1, bw, Math.max(1, y2 - y1));
      });
      // MA
      const maDefs = [['ma5', '#f6c344', 5], ['ma10', '#5ab0ff', 10], ['ma20', '#c883ec', 20], ['ma60', '#7fe3a0', 60]];
      for (const [key, col] of maDefs) {
        if (!this.mas[key]) continue;
        const arr = this.ind[key];
        g.beginPath(); g.strokeStyle = col; g.lineWidth = 1;
        let started = false;
        vis.forEach((b, k) => {
          const v = arr[this.view.from + k]; if (v == null) return;
          const x = X(this.view.from + k), y = Y(v);
          started ? g.lineTo(x, y) : (g.moveTo(x, y), started = true);
        });
        g.stroke();
      }
    }

    // 副图 MACD / RSI
    if (SUB_H) {
      const sy = PAD_T + MAIN_H + 14;
      g.strokeStyle = line; g.strokeRect(L, sy, R - L, SUB_H - 4);
      if (this.sub === 'macd') {
        const { dif, dea, hist } = this.ind.macd;
        const all = [...dif.slice(this.view.from, this.view.to), ...dea.slice(this.view.from, this.view.to), ...hist.slice(this.view.from, this.view.to)].filter(v => v != null);
        const mx = Math.max(1e-9, ...all.map(Math.abs));
        const YS = v => sy + (SUB_H - 4) / 2 - v / mx * ((SUB_H - 4) / 2 - 3);
        g.strokeStyle = line; g.beginPath(); g.moveTo(L, YS(0)); g.lineTo(R, YS(0)); g.stroke();
        vis.forEach((b, k) => {
          const i = this.view.from + k, v = hist[i]; if (v == null) return;
          g.fillStyle = v >= 0 ? upC : dnC; g.globalAlpha = .6;
          const y0 = YS(0), y1 = YS(v);
          g.fillRect(X(i) - this.barW / 2, Math.min(y0, y1), Math.max(1, this.barW - 1), Math.abs(y1 - y0) || 1);
          g.globalAlpha = 1;
        });
        this.plotLine(g, dif, X, YS, '#f6c344', this.view);
        this.plotLine(g, dea, X, YS, '#5ab0ff', this.view);
        g.fillStyle = dim; g.textAlign = 'left'; g.fillText('MACD(12,26,9)', L + 4, sy + 8);
      } else {
        const rsi = this.ind.rsi;
        const YS = v => sy + (SUB_H - 4) - v / 100 * (SUB_H - 8);
        g.strokeStyle = line; g.globalAlpha = .6;
        [30, 70].forEach(v => { g.beginPath(); g.moveTo(L, YS(v)); g.lineTo(R, YS(v)); g.stroke(); }); g.globalAlpha = 1;
        this.plotLine(g, rsi, X, YS, '#c883ec', this.view);
        g.fillStyle = dim; g.textAlign = 'left'; g.fillText('RSI(14)', L + 4, sy + 8);
      }
    }

    // 十字光标 + 信息条
    const cr = extCross && extCross.t != null ? this.crossFromT(extCross.t) : this.cross;
    if (cr && cr.i >= 0) {
      const b = bars[cr.i];
      g.strokeStyle = dim; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X(cr.i), PAD_T); g.lineTo(X(cr.i), H - 20); g.stroke();
      if (cr.y) { g.beginPath(); g.moveTo(L, cr.y); g.lineTo(R, cr.y); g.stroke(); }
      g.setLineDash([]);
      const price = cr.y ? (hi - (cr.y - PAD_T) / MAIN_H * rng) : b?.c;
      if (price != null && this.kind !== 'line') {
        g.fillStyle = '#253246'; g.fillRect(R + 1, (cr.y || Y(b.c)) - 7, this.AXW - 2, 14);
        g.fillStyle = fg; g.textAlign = 'left'; g.fillText(this.fmtP(price), R + 5, (cr.y || Y(b.c)));
      }
      if (b) {
        const chg = b.c - b.o;
        const txt = `${this.fmtT(b.t)}  O ${this.fmtP(b.o)}  H ${this.fmtP(b.h)}  L ${this.fmtP(b.l)}  C ${this.fmtP(b.c)}  ${chg >= 0 ? '+' : ''}${(chg / b.o * 100).toFixed(2)}%  V ${F.big(b.v)}`;
        g.font = '10px monospace';
        const tw = g.measureText(txt).width + 12;
        g.fillStyle = 'rgba(10,16,26,.92)'; g.fillRect(L + 2, PAD_T + 2, tw, 16);
        g.strokeStyle = line; g.strokeRect(L + 2, PAD_T + 2, tw, 16);
        g.fillStyle = chg >= 0 ? upC : dnC; g.fillText(txt, L + 8, PAD_T + 10);
      }
    }
    /* 最新价标记 —— 日线尺度上一次 tick 的位移常常不到一个像素,
     * 没有它, 用户根本分不清"数据没来"和"数据在动但肉眼看不出来"。
     * 右轴那个带底色的标签, 是价格是否在跳的唯一肉眼证据。 */
    const li = bars.length - 1;
    if (li >= this.view.from && li < this.view.to) {
      const lb = bars[li], mx = X(li), my = Y(lb.c);
      const up = lb.c >= lb.o;
      g.globalAlpha = .3; g.strokeStyle = up ? upC : dnC; g.lineWidth = 1; g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(L, my); g.lineTo(R, my); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = up ? upC : dnC;
      g.beginPath(); g.arc(mx, my, 2.6, 0, Math.PI * 2); g.fill();
      g.fillStyle = up ? upC : dnC; g.fillRect(R + 1, my - 7, this.AXW - 2, 14);
      g.fillStyle = '#08101c'; g.textAlign = 'left'; g.fillText(this.fmtP(lb.c), R + 5, my);
    }
    // 图例
    g.font = '9px monospace'; g.textAlign = 'left';
    let lx = L + 4, ly = PAD_T + 22;
    for (const [key, col] of [['ma5', '#f6c344'], ['ma10', '#5ab0ff'], ['ma20', '#c883ec'], ['ma60', '#7fe3a0']]) {
      if (!this.mas[key]) continue;
      const v = this.ind[key][this.cross?.i ?? this.view.to - 1];
      g.fillStyle = col; g.fillText(`${key.toUpperCase()} ${v ? this.fmtP(v) : '--'}`, lx, ly);
      lx += 86;
    }
  }
  plotLine(g, arr, X, YS, col) {
    g.beginPath(); g.strokeStyle = col; g.lineWidth = 1;
    let st = false;
    for (let i = this.view.from; i < this.view.to; i++) {
      const v = arr[i]; if (v == null) continue;
      st ? g.lineTo(X(i), YS(v)) : (g.moveTo(X(i), YS(v)), st = true);
    }
    g.stroke();
  }
  crossFromT(t) {
    if (t == null) return null;
    let best = -1;
    for (let i = this.view.from; i < this.view.to; i++) {
      if (Math.abs(this.bars[i].t - t) < (best < 0 ? Infinity : Math.abs(this.bars[best].t - t))) best = i;
    }
    return best >= 0 ? { i: best } : null;
  }
  fmtP(v) {
    if (v == null || !isFinite(v)) return '--';
    return Math.abs(v) >= 10000 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(5);
  }
  fmtT(t) {
    /* 时间戳一律按"北京时间日历"解读: 服务端聚合就是按 UTC+8 分桶的, 这里若用本地时区,
     * 非东八区用户会把 2020-01-01 看成 2019-12-31, 年线标签直接错一年。 */
    const d = new Date(t + 8 * 3600 * 1000);
    const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
    if (this.period === '1Y') return String(Y);                                  // 年线: 2020
    if (this.period === '1q' || this.period === '1M') return `${String(Y).slice(2)}/${M}`;  // 20/1
    if (this.period === '1d' || this.period === '1w') return `${M}/${D}`;        // 3/15
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
}
