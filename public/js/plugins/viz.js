/* 可视化插件: 市场热力图 (squarified treemap) · 市场联动相关性矩阵 */
import { F, heatColor } from '../fmt.js';
import { S, bus, selectSymbol } from '../core.js';
import { h } from '../ui.js';
import { registerCard } from '../grid.js';
import { getKline } from '../api.js';

/* ================= 热力图 ================= */
/* 递归 squarified treemap (Bruls et al.)。
 * 行的"最差纵横比"用标准公式逐项计算: 行厚 t=Σarea/side, 单块纵横比 max(t²/a, a/t²),
 * 贪心扩展行直到再加一项会变差。此前的 aspect() 把"权重/边长"当成长度用, 量纲不一致,
 * 选行近乎随机 —— 多头部分布下会把尾部挤成 4~9px 的发丝块(实测复现)。 */
function worstRow(areas, side) {
  const s = areas.reduce((a, b) => a + b, 0);
  if (!(s > 0) || !(side > 0)) return Infinity;
  const t = s / side;
  let worst = 0;
  for (const a of areas) worst = Math.max(worst, Math.max(t * t / a, a / (t * t)));
  return worst;
}
function layout(items, x, y, w, h2, out) {
  if (!items.length) return;
  if (items.length === 1) { out.push({ item: items[0], x, y, w, h: h2 }); return; }
  const total = items.reduce((a, b) => a + b.v, 0);
  const scale = (w * h2) / total;
  let rest = items, cx = x, cy = y, cw = w, ch = h2;
  while (rest.length) {
    const side = Math.min(cw, ch);
    let row = [rest[0]];
    let best = worstRow(row.map(it => it.v * scale), side);
    for (let i = 1; i < rest.length; i++) {
      const wr = worstRow(row.concat(rest[i]).map(it => it.v * scale), side);
      if (wr <= best) { row.push(rest[i]); best = wr; }
      else break;
    }
    const rowSumV = row.reduce((a, b) => a + b.v, 0);
    const th = (rowSumV * scale) / side;      // 行厚 (像素)
    if (!(th > 0) || !isFinite(th)) break;    // 全零权重兜底, 防死循环
    if (cw >= ch) {                           // 行放左侧 (竖条)
      let yy = cy;
      for (const it of row) {
        const ih = (it.v * scale) / th;
        out.push({ item: it, x: cx, y: yy, w: th, h: ih });
        yy += ih;
      }
      cx += th; cw -= th;
    } else {                                  // 行放顶部 (横条)
      let xx = cx;
      for (const it of row) {
        const iw = (it.v * scale) / th;
        out.push({ item: it, x: xx, y: cy, w: iw, h: th });
        xx += iw;
      }
      cy += th; ch -= th;
    }
    rest = rest.slice(row.length);
  }
}

registerCard({
  type: 'heatmap', title: '市场热力图', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const tools = h('div', { class: 'card-tools' });
    const cvBox = h('div', { style: { flex: '1', position: 'relative', minHeight: '0' } });
    const cv = h('canvas', { class: 'block' });
    cvBox.append(cv);
    bd.append(tools, cvBox);
    const tip = document.getElementById('tip');
    let group = S.market || '全部', sizeBy = 'equal';
    if (!group) group = '全部';
    const GROUPS = ['全部', '加密货币', 'A股', '港股', '美股', '指数', '期货', '外汇'];

    function renderTools() {
      tools.innerHTML = '';
      GROUPS.forEach(g => tools.append(h('button', { class: 'chip' + (group === g ? ' on' : ''), onclick: () => { group = g; renderTools(); draw(); } }, g)));
      tools.append(h('span', { style: { width: '8px' } }));
      [['amt', '按成交额'], ['equal', '均等']].forEach(([k, label]) =>
        tools.append(h('button', { class: 'chip' + (sizeBy === k ? ' on' : ''), onclick: () => { sizeBy = k; renderTools(); draw(); } }, label)));
    }

    function data() {
      const uni = S.universe.filter(u => group === '全部' ? true : u.group === group);
      const byGroup = new Map();
      for (const u of uni) {
        const Q = S.quotes[u.sym];
        if (!Q || !Q.pct && Q.pct !== 0) continue;
        if (!byGroup.has(u.group)) byGroup.set(u.group, []);
        /* 面积权重只认"活"的真实数据 —— 当日成交额。
         * 此前用的是 CATALOG 里硬编码的市值: 那是写死的静态数字, 过几个月就失真,
         * 与"数据必须真实"的底线直接冲突。成交额由上游实时推送, 组内口径一致;
         * 组内本来就要归一化, 跨市场的单位差异不会影响面积。休市/无成交时退化为均等。 */
        const v = sizeBy === 'amt' ? (Q.amt > 0 ? Q.amt : 1) : 1;
        byGroup.get(u.group).push({ v, sym: u.sym, name: Q.name || u.name, pct: Q.pct, price: Q.price, amt: Q.amt });
      }
      const out = [];
      for (const [g, items] of byGroup) {
        items.sort((a, b) => b.v - a.v);
        /* 上限 24: 一张短卡片里塞 60 只只会切出发丝块 —— 按成交额取头部,
         * 组内方块才切得出可读尺寸; 更全的明细交给点击品种后的图表/涨跌榜。 */
        const top = items.slice(0, 24);
        // amt 权重 10 倍钳制: 头部成交额可达尾部的千倍, 按原值画树图会把尾部压成
        // 发丝块、进而触发整组聚合。10 倍实测最差方块仍有 ~13px (25 倍时只剩 9px),
        // 头部依旧明显更大, 面积语义不丢。
        if (sizeBy === 'amt' && top.length) {
          const mx = top[0].v || 1;
          for (const x of top) x.v = Math.max(x.v, mx / 10);
        }
        // 组内归一化权重 → 组面积只取决于成员数量: 消除跨市场市值单位差异
        const sum = top.reduce((a, b) => a + b.v, 0) || 1;
        const norm = top.map(x => ({ ...x, v: x.v / sum }));
        // 组面积 ∝ 成员数 (线性, 而非 sqrt): 这样每个品种分到的画布面积近似相等。
        // 此前用 sqrt(n) 会放大小组、压扁大组 —— A股/港股 60 只的组每块只有
        // 加密组的 ~1/4 面积, 窄到低于文字阈值, 整组变成"只有彩条没有内容"。
        out.push({ group: g, items: norm, total: top.length });
      }
      out.sort((a, b) => b.total - a.total);
      return out;
    }

    let rects = [];
    let aggRects = [];        // 聚合块 (组内最差方块过小, 整组合并为单块)
    let hoverKey = null;      // 命中的 sym 或 'agg:'+组名, 用于 hover 描边/重绘
    /* 圆角矩形: 旧版直角 fillRect 满屏硬边色块, 是"土味行情机"观感的主要来源之一。
     * roundRect 是较新的 API, 老内核回退直角 —— 降级后只是变丑一档, 功能无损。 */
    function rr(g, x, y, w, h, r) {
      if (w <= 0 || h <= 0) return;
      if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); }
      else g.fillRect(x, y, w, h);
    }
    function draw() {
      const r = cvBox.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return;
      const dpr = devicePixelRatio || 1;
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, r.width, r.height);
      /* 组头/文字颜色从 CSS 变量取, 跟随主题 —— 硬编码深色在浅色主题下会变成一块块黑斑 */
      const css = getComputedStyle(document.body);
      const cHd = css.getPropertyValue('--panel2').trim() || '#0e1622';
      const cTxt = css.getPropertyValue('--dim').trim() || '#667b92';
      const groups = data();
      const HDR = 14, GAP = 3;
      rects = []; aggRects = [];
      const big = groups.map(x => ({ v: x.total, g: x }));
      const placed = [];
      layout(big, 0, 0, r.width, r.height, placed);
      for (const p of placed) {
        const grp = p.item.g;
        // 组头。fillStyle 必须在 rr() 之前设置 —— 顺序颠倒时 rr 会用上一个子块的
        // 涨跌色作画, 组头变成一条红/绿彩条 (实测截图确认过)。
        g.fillStyle = cHd;
        rr(g, p.x, p.y, p.w, HDR, 3);
        g.fillStyle = cTxt; g.font = '9px monospace'; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(grp.group, p.x + 6, p.y + HDR / 2 + 1);
        const ix = p.x + GAP / 2, iy = p.y + HDR, iw = p.w - GAP, ih = p.h - HDR - GAP / 2;
        // 区域过小(被 treemap 压到不足一个文字行) → 只留组头, 不画内容, 杜绝"发丝彩条"
        if (iw < 36 || ih < 18) continue;
        const avg = grp.items.reduce((a, b) => a + b.pct, 0) / grp.items.length;
        /* 组内布局双模式:
         *   均等 → 网格铺排: 每块等大, 行高按 30px 目标取整, 天然可读;
         *   按成交额 → squarify 树图: 面积∝成交额。
         * 两种模式任一块切不出来(过小)时整组聚合为单块 —— 低成员组(期货/外汇/指数)
         * 此前会被 squarify 切成一根根 1px 彩条, 正是"只显示彩条没有内容"的来源。 */
        const inner = [];
        let tooSmall = false;
        if (sizeBy === 'amt') {
          layout(grp.items, ix, iy, iw, ih, inner);
          tooSmall = inner.length ? Math.min(...inner.map(q => Math.min(q.w, q.h))) < 12 : true;
        } else {
          const rows = Math.max(1, Math.min(grp.items.length, Math.round(ih / 30)));
          const cols = Math.ceil(grp.items.length / rows);
          const cw = iw / cols, ch = ih / rows;
          tooSmall = cw < 18 || ch < 16;
          if (!tooSmall) grp.items.forEach((it, i) =>
            inner.push({ item: it, x: ix + (i % cols) * cw, y: iy + Math.floor(i / cols) * ch, w: cw, h: ch }));
        }
        if (tooSmall) {
          const isHov = ('agg:' + grp.group) === hoverKey;
          g.fillStyle = heatColor(avg, S.upRed);
          rr(g, ix, iy, iw, ih, 3);
          if (isHov) {
            g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.5;
            g.beginPath();
            if (g.roundRect) g.roundRect(ix + 1, iy + 1, iw - 2, ih - 2, 3);
            else g.rect(ix, iy, iw, ih);
            g.stroke();
          }
          if (iw > 46 && ih > 22) {
            g.fillStyle = 'rgba(0,0,0,.74)'; g.textAlign = 'center'; textBaselineSafe(g, 'middle');
            g.font = `bold ${Math.min(12, Math.max(9, ih / 4))}px monospace`;
            g.fillText(grp.group, ix + iw / 2, iy + ih / 2 - 6, iw - 6);
            g.font = `bold ${Math.min(13, Math.max(10, ih / 3))}px monospace`;
            g.fillText(F.pct(avg), ix + iw / 2, iy + ih / 2 + 7, iw - 6);
          }
          const sorted = [...grp.items].sort((a, b) => b.pct - a.pct);
          aggRects.push({ x: ix, y: iy, w: iw, h: ih, group: grp.group, avg, count: grp.items.length, top: sorted[0], bot: sorted[sorted.length - 1] });
          continue;
        }
        for (const q of inner) {
          const it = q.item;
          rects.push({ ...q, it });
          const isHov = it.sym === hoverKey;
          g.fillStyle = heatColor(it.pct, S.upRed);
          rr(g, q.x + GAP / 2, q.y + GAP / 2, Math.max(0, q.w - GAP), Math.max(0, q.h - GAP), 3);
          if (isHov) {          // hover 描边: 让"我正看着哪块"有明确反馈
            g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.5;
            g.beginPath();
            if (g.roundRect) g.roundRect(q.x + GAP / 2 + .5, q.y + GAP / 2 + .5, Math.max(0, q.w - GAP) - 1, Math.max(0, q.h - GAP) - 1, 3);
            else g.rect(q.x + GAP / 2, q.y + GAP / 2, Math.max(0, q.w - GAP), Math.max(0, q.h - GAP));
            g.stroke();
          }
          if (q.w > 34 && q.h > 22) {
            g.fillStyle = 'rgba(0,0,0,.74)';
            g.font = `bold ${Math.min(11, Math.max(8, q.w / 8))}px monospace`;
            g.textAlign = 'center'; textBaselineSafe(g, 'middle');
            // maxWidth 防溢出: 长名 (如"美元兑日元即期汇率") 曾画出块外, 压到相邻块上
            g.fillText(it.name.slice(0, 10), q.x + q.w / 2, q.y + q.h / 2 - 4, q.w - 6);
            if (q.h > 30) {
              g.font = `bold ${Math.min(12, Math.max(9, q.h / 4))}px monospace`;
              g.fillText(F.pct(it.pct), q.x + q.w / 2, q.y + q.h / 2 + 8, q.w - 6);
            }
          } else if (q.w > 18 && q.h > 11) {
            // 与聚合阈值(minH<12)衔接: 凡是切出来的方块高度必 >11, 至少要能放下一个涨跌幅,
            // 否则又会退回"只有彩条没有内容"
            g.fillStyle = 'rgba(0,0,0,.74)'; g.font = '8px monospace'; g.textAlign = 'center'; textBaselineSafe(g, 'middle');
            g.fillText(`${it.pct > 0 ? '+' : ''}${it.pct.toFixed(1)}`, q.x + q.w / 2, q.y + q.h / 2, q.w - 4);
          }
        }
      }
    }
    /* 旧版在浅色主题下 hover 文字基线会偏, 这里统一把 baseline 复位, 避免文字上下跳动 */
    function textBaselineSafe(g, v) { try { g.textBaseline = v; } catch {} }

    const hitTest = (x, y) => rects.find(q => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h)
      || aggRects.find(a => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
    cv.addEventListener('mousemove', e => {
      const hit = hitTest(e.offsetX, e.offsetY);
      if (hit) {
        const key = hit.it ? hit.it.sym : ('agg:' + hit.group);
        if (hoverKey !== key) { hoverKey = key; draw(); }   // 换块才重绘, 避免高频 mousemove 卡顿
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 10) + 'px';
        if (hit.it) {
          /* 展示真实量纲: 成交额(上游实时推送) 与 组内面积占比。
           * 此前显示的是归一化后的 v(0~1 的小数), 却套用"万/亿"格式并标注为"权重" ——
           * 一个既不对应市值、也不对应任何真实口径的内部计算值, 等于把中间量冒充成业务指标。 */
          const share = (hit.it.v * 100).toFixed(1) + '%';
          const amtTxt = hit.it.amt > 0 ? `成交额 ${F.big(hit.it.amt)}` : '成交额 暂无';
          tip.innerHTML = `<b>${hit.it.name}</b> <span class="dim">${hit.it.sym}</span><br>价格 ${F.price(hit.it.price)} · <span class="${F.cls(hit.it.pct)}">${F.pct(hit.it.pct)}</span><br>${amtTxt} · 占板块 ${share}`;
        } else {
          // 聚合块: 组级汇总 + 领头/垫底品种, 点击跳转领头
          tip.innerHTML = `<b>${hit.group}</b> <span class="dim">聚合 ${hit.count} 只</span><br>均涨跌幅 <span class="${F.cls(hit.avg)}">${F.pct(hit.avg)}</span><br>领涨 ${hit.top?.name || '—'} · 领跌 ${hit.bot?.name || '—'}`;
        }
        cv.style.cursor = 'pointer';
      } else {
        tip.style.display = 'none'; cv.style.cursor = 'default';
        if (hoverKey) { hoverKey = null; draw(); }
      }
    });
    cv.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      if (hoverKey) { hoverKey = null; draw(); }   // 离开画布时撤掉 hover 描边
    });
    cv.addEventListener('click', e => {
      const hit = hitTest(e.offsetX, e.offsetY);
      if (!hit) return;
      selectSymbol(hit.it ? hit.it.sym : hit.top?.sym);
    });

    renderTools();
    draw();
    // 卡片尺寸变化 → 重绘 (否则画布位图滞留旧尺寸: 发虚且点击坐标错位)
    const ro = new ResizeObserver(() => { cancelAnimationFrame(card._raf); card._raf = requestAnimationFrame(draw); });
    ro.observe(cvBox);
    const offQ = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(draw, 900); });
    const offTheme = bus.on('theme', () => draw());
    const offUp = bus.on('upred', () => draw());
    const offM = bus.on('market', g => { group = g || '全部'; renderTools(); draw(); });
    card.api.destroy = () => { ro.disconnect(); offQ(); offTheme(); offUp(); offM(); tip.style.display = 'none'; };
    card.api.refresh = draw;
  },
});

/* ================= 市场联动相关性矩阵 ================= */
registerCard({
  type: 'corr', title: '市场联动', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const tools = h('div', { class: 'card-tools' });
    const cvBox = h('div', { style: { flex: '1', position: 'relative', minHeight: '0' } });
    const cv = h('canvas', { class: 'block' });
    cvBox.append(cv);
    bd.append(tools, cvBox);

    const PRESETS = {
      // 全球宏观: 指数用 ETF 代理 (SPY≈标普500, 盈富基金≈恒指) — 保证全资产类别都有日K数据
      '全球宏观': ['crypto:BTCUSDT', 'us:SPY', 'hk:02800', 'idx:sh000001', 'fut:hf_GC', 'fut:hf_CL', 'fut:hf_CHA50CFD', 'fx:fx_susdcnh'],
      'A股板块': ['idx:sh000001', 'idx:sz399006', 'idx:sh000300', 'cn:sh600519', 'cn:sh601318', 'cn:sz300750', 'cn:sh601899', 'fut:hf_CHA50CFD'],
      '美股科技': ['us:NVDA.OQ', 'us:AAPL.OQ', 'us:MSFT.OQ', 'us:GOOGL.OQ', 'us:AMD.OQ', 'us:TSLA.OQ', 'us:SPY'],
      '加密主流': ['crypto:BTCUSDT', 'crypto:ETHUSDT', 'crypto:SOLUSDT', 'crypto:BNBUSDT', 'crypto:XRPUSDT', 'us:SPY'],
    };
    let preset = '全球宏观';
    let cache = {};   // sym -> closes
    let loading = false;

    function renderTools() {
      tools.innerHTML = '';
      Object.keys(PRESETS).forEach(k => tools.append(h('button', { class: 'chip' + (preset === k ? ' on' : ''), onclick: () => { preset = k; load(); } }, k)));
      tools.append(h('span', { class: 'dim', style: { fontSize: '9px', marginLeft: 'auto' } }, loading ? '计算中…' : '日收益 60日 Pearson'));
    }

    async function load() {
      renderTools();
      loading = true; renderTools();
      const syms = PRESETS[preset];
      const jobs = syms.map(async sym => {
        if (cache[sym]?.length) return;
        try {
          const d = await getKline(sym, '1d', 90);
          cache[sym] = d.bars.map(b => b.c);
        } catch { cache[sym] = []; }
      });
      await Promise.all(jobs);
      loading = false; renderTools();
      draw();
    }

    function corr(a, b) {
      const n = Math.min(a.length, b.length);
      if (n < 20) return null;
      const ra = [], rb = [];
      for (let i = n - 61; i < n; i++) {
        if (i < 1) continue;
        ra.push(a[i] / a[i - 1] - 1); rb.push(b[i] / b[i - 1] - 1);
      }
      const m = ra.length; if (m < 20) return null;
      const ma = ra.reduce((x, y) => x + y, 0) / m, mb = rb.reduce((x, y) => x + y, 0) / m;
      let num = 0, da = 0, dbv = 0;
      for (let i = 0; i < m; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; dbv += (rb[i] - mb) ** 2; }
      const d = Math.sqrt(da * dbv);
      return d ? num / d : null;
    }

    const nameOf = s => (S.quotes[s]?.name || s.split(':')[1]).slice(0, 8);

    function draw() {
      const syms = PRESETS[preset].filter(s => cache[s]?.length > 20);
      const r = cvBox.getBoundingClientRect();
      if (r.width < 30 || r.height < 30) return;
      const dpr = devicePixelRatio || 1;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, r.width, r.height);
      /* 画布内文字/空格颜色跟随主题 (硬编码深色在浅色主题下不可读) */
      const cssC = getComputedStyle(document.body);
      const cEmpty = cssC.getPropertyValue('--line').trim() || '#1a2739';
      const cLbl = cssC.getPropertyValue('--flat').trim() || '#8fa3b8';
      const cDim2 = cssC.getPropertyValue('--dim').trim() || '#5c7288';

      const n = syms.length;
      g.textBaseline = 'middle';
      if (!n) {
        g.fillStyle = cDim2; g.font = '10px monospace'; g.textAlign = 'center';
        g.fillText(loading ? '计算中…' : '暂无数据', r.width / 2, r.height / 2);
        cv.onclick = null;
        return;
      }

      // 三段式垂直布局: [顶部旋转表头带 HDR] [矩阵] [底部图例带 LEG]
      const pad = 6, GAPX = 2;
      g.font = '9px monospace';
      const maxRowW = Math.max(...syms.map(s => g.measureText(nameOf(s)).width));
      const LBL = Math.min(84, Math.max(48, Math.ceil(maxRowW) + 10));   // 行标签列宽(动态)
      const availW = r.width - LBL - pad * 2;
      if (availW < n * 6) {
        g.fillStyle = cDim2; g.font = '10px monospace'; g.textAlign = 'center';
        g.fillText('卡片过小, 请放大', r.width / 2, r.height / 2);
        return;
      }
      // 45° 旋转标签的投影高度 ≈ 文本宽度/√2, 按列宽估算并夹在 [16,40]
      const HDR = Math.max(16, Math.min(40, Math.round((availW / n) * 0.8)));
      const LEG = 13;
      const availH = r.height - HDR - LEG - pad * 2;
      const cell = Math.min(availW / n, availH / n);
      if (!isFinite(cell) || cell < 6) {
        g.fillStyle = cDim2; g.font = '10px monospace'; g.textAlign = 'center';
        g.fillText('卡片过小, 请放大', r.width / 2, r.height / 2);
        return;
      }
      const x0 = LBL + Math.max(0, (availW - cell * n) / 2);
      const y0 = pad + HDR + Math.max(0, (availH - cell * n) / 2);

      const M = [];
      for (let i = 0; i < n; i++) {
        M.push([]);
        for (let j = 0; j < n; j++) M[i].push(i === j ? 1 : corr(cache[syms[i]], cache[syms[j]]));
      }
      // 1) 数值矩阵
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const v = M[i][j];
        const x = x0 + j * cell, y = y0 + i * cell;
        if (v == null) { g.fillStyle = cEmpty; g.fillRect(x + 1, y + 1, cell - GAPX, cell - GAPX); continue; }
        // 正相关暖色 (联动), 负相关冷色 (对冲)
        const t = Math.abs(v);
        g.fillStyle = v >= 0
          ? `rgba(255,${Math.round(176 - t * 90)},${Math.round(46 - t * 140)},${0.25 + t * 0.75})`
          : `rgba(46,${Math.round(140 + t * 60)},255,${0.25 + t * 0.75})`;
        g.fillRect(x + 1, y + 1, cell - GAPX, cell - GAPX);
        if (cell >= 22) {
          g.fillStyle = t > 0.55 ? 'rgba(0,0,0,.75)' : '#8fa3b8';
          g.font = `bold ${Math.min(11, Math.max(8, cell / 3.2))}px monospace`;
          g.fillText(v.toFixed(2), x + cell / 2, y + cell / 2);
        }
      }
      // 2) 行标签 (右对齐到矩阵左缘)
      g.font = '9px monospace'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = cLbl;
      for (let i = 0; i < n; i++) g.fillText(nameOf(syms[i]), x0 - 6, y0 + i * cell + cell / 2);
      // 3) 列表头: 45° 旋转, 收在预留表头带内; 最后绘制以免被单元格覆盖
      g.font = '9px monospace'; g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.fillStyle = cLbl;
      for (let j = 0; j < n; j++) {
        g.save();
        g.translate(x0 + j * cell + cell / 2, y0 - 5);
        g.rotate(Math.PI / 4);          // 文字向左上延伸, 不侵入矩阵
        g.fillText(nameOf(syms[j]).slice(0, 6), 0, 0);
        g.restore();
      }
      // 4) 图例 (固定在底部预留带, 不遮数据)
      g.font = '9px monospace'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = cDim2;
      g.fillText('■ 暖=同向联动  ■ 冷=反向对冲', LBL, Math.min(r.height - 7, y0 + cell * n + 9));
      // 点击 → 切换品种
      cv.onclick = e => {
        const j = Math.floor((e.offsetX - x0) / cell), i = Math.floor((e.offsetY - y0) / cell);
        if (i >= 0 && i < n && j >= 0 && j < n) selectSymbol(syms[i]);
      };
    }
    card.api.refresh = draw;
    load();
    // 卡片尺寸变化 → 重绘 (否则画布位图滞留旧尺寸: 发虚且点击坐标错位)
    const ro = new ResizeObserver(() => { cancelAnimationFrame(card._raf); card._raf = requestAnimationFrame(draw); });
    ro.observe(cvBox);
    const offTheme = bus.on('theme', () => draw());
    const offSel = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(draw, 3000); });
    card.api.destroy = () => { ro.disconnect(); offTheme(); offSel(); };
  },
});
