/* 盯盘类插件: 自选列表 · 全球指数 · 涨跌榜 · 全球市场时钟 */
import { F } from '../fmt.js';
import { S, bus, selectSymbol, persist, setMarket, guardWrite, toast } from '../core.js';
import { h, spark } from '../ui.js';
import { registerCard } from '../grid.js';

const q = sym => S.quotes[sym];
const hist = sym => (S.tickHist[sym] || []).map(x => x.p);

/* ---------- 自选列表 ---------- */
registerCard({
  type: 'watchlist', title: '自选', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const search = h('input', { class: 'mini-input', placeholder: '搜索添加品种 (名称/代码, 如 茅台 BTC AAPL)…' });
    const tbl = h('div', { style: { flex: '1', overflowY: 'auto' } });
    bd.append(search, tbl);
    let results = null;
    search.addEventListener('input', () => {
      const kw = search.value.trim().toLowerCase();
      results = !kw ? null : S.universe.filter(u =>
        u.name.toLowerCase().includes(kw) || u.sym.toLowerCase().includes(kw) || u.code.toLowerCase().includes(kw)).slice(0, 8);
      render();
    });
    /* 加自选: 受配置锁保护 (hard 模式下拒绝) */
    function addSym(sym) {
      const reason = guardWrite('local');
      if (reason) { toast('🔒 ' + reason, 4000); return false; }
      if (!S.watchlist.includes(sym)) {
        S.watchlist.push(sym);
        persist('watchlist', S.watchlist);
        bus.emit('watchlist.changed', S.watchlist);
      }
      return true;
    }
    /* 删自选: 同样受锁保护 */
    function delSym(sym) {
      const reason = guardWrite('local');
      if (reason) { toast('🔒 ' + reason, 4000); return false; }
      S.watchlist = S.watchlist.filter(x => x !== sym);
      persist('watchlist', S.watchlist);
      bus.emit('watchlist.changed', S.watchlist);
      return true;
    }
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter' && results?.length) {
        const u = results[0];
        addSym(u.sym);
        search.value = ''; results = null; selectSymbol(u.sym); render();
      }
    });
    const rowMap = new Map();   // sym -> { tr, nm, px, pc, cv }: 实时只更新单元格, 不重建整表
    const sparkCol = pct => pct >= 0 ? (S.upRed ? '#ff5757' : '#1fc98e') : (S.upRed ? '#1fc98e' : '#ff5757');
    function makeRow(sym) {
      const Q = q(sym);
      // 名称用独立 span 承载: 构建时若行情未到, 名称会定格成原始代码 (如 BTCUSDT),
      // 之后行情到达必须能就地补上中文名 —— 否则整列长期显示代码而非名称。
      const nm = h('span', {}, Q?.name || sym.split(':')[1]);
      const tr = h('tr', { class: 'symrow' + (sym === S.selected ? ' sel' : ''), onclick: () => selectSymbol(sym) },
        h('td', {}, nm, h('span', { class: 'dim', style: { fontSize: '9px', marginLeft: '4px' } }, sym.split(':')[0])),
        h('td', { class: 'num' }, F.price(Q?.price)),
        h('td', { class: 'num ' + F.cls(Q?.pct) }, F.pct(Q?.pct)),
        (() => { const cv = h('canvas', { class: 'wl-spark' }); requestAnimationFrame(() => spark(cv, hist(sym), sparkCol(Q?.pct))); return cv; })());
      tr.addEventListener('contextmenu', e => { e.preventDefault(); if (delSym(sym)) render(); });
      rowMap.set(sym, { tr, nm, px: tr.children[1], pc: tr.children[2], cv: tr.querySelector('canvas') });
      return tr;
    }
    function render() {
      tbl.innerHTML = ''; rowMap.clear();
      if (results) {
        tbl.append(h('div', { class: 'hint' }, '回车添加第一个结果:'));
        for (const u of results) {
          tbl.append(h('div', { class: 'agent-line', style: { cursor: 'pointer' }, onclick: () => {
            addSym(u.sym);
            search.value = ''; results = null; selectSymbol(u.sym); render();
          } }, h('span', { class: 'af' }, u.group), ' ', u.name, h('span', { class: 'aa' }, ' ' + u.sym)));
        }
        return;
      }
      const t = h('table', { class: 'tbl' });
      t.append(h('tr', {}, h('th', {}, '品种'), h('th', {}, '最新'), h('th', {}, '涨跌'), h('th', {}, '走势')));
      for (const sym of S.watchlist) t.append(makeRow(sym));
      tbl.append(t);
      card.setBadge(`${S.watchlist.length} 只 · 右键删除`);
    }
    /* 实时只更新数值 + 重绘 sparkline, 不重建 DOM: 否则每批报价都把整张表 innerHTML 清空重建,
     * 行内 sparkline 跟着反复销毁生成 → 视觉闪烁, 正是用户说的"自动动来动去"的噪音源之一。 */
    function updateCell(sym) {
      const r = rowMap.get(sym); if (!r) return;
      const Q = q(sym); if (!Q) return;
      // 名称只在"此前是代码兜底、现在有了真名"时补写, 避免每帧重写 DOM
      if (Q.name && r.nm.textContent !== Q.name) r.nm.textContent = Q.name;
      r.px.textContent = F.price(Q.price);
      r.pc.textContent = F.pct(Q.pct); r.pc.className = 'num ' + F.cls(Q.pct);
      spark(r.cv, hist(sym), sparkCol(Q.pct));
    }
    const offSym = bus.on('symbol', s => { for (const [sym, r] of rowMap) r.tr.classList.toggle('sel', sym === s); });
    const offQ = bus.on('quotes', list => {
      const hit = list.filter(x => S.watchlist.includes(x.sym));
      if (!hit.length) return;
      clearTimeout(card._t); card._t = setTimeout(() => { for (const x of hit) updateCell(x.sym); }, 700);
    });
    const offUp = bus.on('upred', () => render());
    const offW = bus.on('watchlist.changed', () => render());   // 恢复默认/撤销/导入后同步刷新
    card.api.destroy = () => { offSym(); offQ(); offUp(); offW(); };
    card.api.refresh = render;
    render();
  },
});

/* ---------- 全球指数带 ---------- */
registerCard({
  type: 'indices', title: '全球市场', badge: '', pad: false,
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.overflow = 'hidden';
    const wrap = h('div', { style: { display: 'flex', height: '100%', overflowX: 'auto', overflowY: 'hidden' } });
    bd.append(wrap);
    const MAJOR = ['idx:sh000001', 'idx:sz399006', 'idx:usDJI', 'idx:usIXIC', 'idx:usINX', 'idx:int_hangseng', 'idx:int_nikkei', 'idx:int_ftse', 'fut:hf_CHA50CFD', 'crypto:BTCUSDT', 'fut:hf_GC', 'fx:fx_susdcny'];
    /* 构建一次, 实时只更新数值与颜色 —— 不再每 800ms 整段 innerHTML 重建。
     * 重建会让正在 hover 的磁贴失去高亮, 且每次都触发浏览器重排, 是种没必要的"画面在动"。 */
    const map = new Map();
    for (const sym of MAJOR) {
      const iv = h('span', { class: 'iv num' }, '--');
      const ic = h('span', { class: 'ic num' }, '--');
      const name = h('span', { class: 'in' }, sym.split(':')[1]);
      wrap.append(h('div', { class: 'idx-tile', onclick: () => selectSymbol(sym) }, name, iv, ic));
      map.set(sym, { iv, ic, name });
    }
    function update() {
      for (const sym of MAJOR) {
        const Q = q(sym), r = map.get(sym); if (!Q) continue;
        r.name.textContent = Q.name || sym.split(':')[1];
        r.iv.textContent = F.price(Q.price); r.iv.className = 'iv num ' + F.cls(Q.pct);
        r.ic.textContent = F.pct(Q.pct); r.ic.className = 'ic num ' + F.cls(Q.pct);
      }
    }
    update();
    const offQ = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(update, 800); });
    card.api.destroy = () => offQ();
    card.api.refresh = update;
  },
});

/* ---------- 涨跌榜 ---------- */
registerCard({
  type: 'movers', title: '涨跌榜', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    let mode = 'up', group = S.market || '';
    const tools = h('div', { class: 'card-tools' });
    const body = h('div', { style: { flex: '1', overflowY: 'auto' } });
    bd.append(tools, body);
    const groups = ['', 'A股', '港股', '美股', '加密货币', '期货', '外汇'];
    function renderTools() {
      tools.innerHTML = '';
      [['up', '涨幅'], ['down', '跌幅'], ['amt', '活跃']].forEach(([k, label]) =>
        tools.append(h('button', { class: 'chip' + (mode === k ? ' on' : ''), onclick: () => { mode = k; sortPool(); renderTools(); render(); } }, label)));
      tools.append(h('span', { style: { width: '8px' } }));
      groups.forEach(gk => tools.append(h('button', { class: 'chip' + (group === gk ? ' on' : ''), onclick: () => { group = gk; sortPool(); renderTools(); render(); } }, gk || '全市场')));
    }
    /* 排序与数值更新解耦: 实时推送只更新单元格数值(行不动), 重排只在用户切 tab / 切市场时
     * 发生一次。否则每秒按实时涨跌幅重排会让整张表行不停上下跳 —— 那种"自动动来动去"不是
     * 实时, 是 bug。想刷新最新排名就再点一次对应 tab。 */
    let order = [];
    function sortPool() {
      let pool = Object.values(S.quotes).filter(x => x.price > 0);
      if (group) pool = pool.filter(x => { const u = S.universe.find(z => z.sym === x.sym); return u?.group === group; });
      else pool = pool.filter(x => !x.sym.startsWith('idx:') && !x.sym.startsWith('fx:'));
      if (mode === 'amt') pool.sort((a, b) => (b.amt || 0) - (a.amt || 0));
      else pool.sort((a, b) => mode === 'up' ? (b.pct || -1e9) - (a.pct || -1e9) : (a.pct || 1e9) - (b.pct || -1e9));
      order = pool.slice(0, 14).map(x => x.sym);
    }
    function render() {
      body.innerHTML = '';
      const t = h('table', { class: 'tbl' });
      t.append(h('tr', {}, h('th', {}, '# 品种'), h('th', {}, '最新'), h('th', {}, '涨跌%'), h('th', {}, '成交额')));
      for (const sym of order) {
        const x = S.quotes[sym]; if (!x) continue;
        const u = S.universe.find(z => z.sym === x.sym);
        t.append(h('tr', { class: 'symrow' + (sym === S.selected ? ' sel' : ''), 'data-sym': sym, onclick: () => selectSymbol(sym) },
          h('td', {}, x.name || u?.name || x.sym),
          h('td', { class: 'num px' }, F.price(x.price)),
          h('td', { class: 'num pc ' + F.cls(x.pct) }, F.pct(x.pct)),
          h('td', { class: 'num dim amt' }, x.amt ? F.big(x.amt) : '—')));
      }
      body.append(t);
      card.setBadge(`${order.length} 只 · ${group || '全市场'}`);
    }
    /* 实时只改数值, 不重建 DOM、不重排行 —— 画面安静, 数字照常跳动 */
    function update() {
      for (const tr of body.querySelectorAll('tr[data-sym]')) {
        const x = S.quotes[tr.dataset.sym]; if (!x) continue;
        tr.querySelector('.px').textContent = F.price(x.price);
        const pc = tr.querySelector('.pc'); pc.textContent = F.pct(x.pct); pc.className = 'num pc ' + F.cls(x.pct);
        tr.querySelector('.amt').textContent = x.amt ? F.big(x.amt) : '—';
      }
    }
    sortPool(); renderTools(); render();
    const offQ = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(() => {
      // 初始化早于首笔行情到达时 order 为空, 此时必须先排序填充, 否则表格永久空白
      if (!order.length && Object.values(S.quotes).some(x => x.price > 0)) { sortPool(); render(); }
      else update();
    }, 1000); });
    const offM = bus.on('market', g => { group = g; sortPool(); renderTools(); render(); });
    card.api.destroy = () => { offQ(); offM(); };
    card.api.refresh = () => { sortPool(); render(); };
  },
});

/* ---------- 全球市场时钟 ---------- */
const SESSIONS = [
  ['中国 A股', 'Asia/Shanghai', 9.5, 15, 'cn:sh000001'],
  ['香港 港股', 'Asia/Hong_Kong', 9.5, 16, 'idx:int_hangseng'],
  ['美国 美股', 'America/New_York', 9.5, 16, 'idx:usDJI'],
  ['伦敦 伦股', 'Europe/London', 8, 16.5, 'idx:int_ftse'],
  ['东京 日股', 'Asia/Tokyo', 9, 15, 'idx:int_nikkei'],
  ['法兰克福 德股', 'Europe/Berlin', 9, 17.5, null],
  ['加密货币 7×24', 'UTC', 0, 24, 'crypto:BTCUSDT'],
];
registerCard({
  type: 'worldclock', title: '全球时钟', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0';
    const box = h('div');
    bd.append(box);
    function fmtZone(tz) {
      return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
    }
    function zoneHour(tz) {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date());
      const get = t => p.find(x => x.type === t)?.value;
      const hr = (+get('hour')) + (+get('minute')) / 60;
      return { hr, wk: get('weekday') };
    }
    function render() {
      box.innerHTML = '';
      for (const [name, tz, open, close, link] of SESSIONS) {
        const { hr, wk } = zoneHour(tz);
        const weekend = wk === 'Sat' || wk === 'Sun';
        const is24 = open === 0 && close === 24;
        const openNow = is24 ? true : (!weekend && hr >= open && hr < close);
        const row = h('div', { class: 'clock-row' },
          h('span', { class: 'cz' }, name),
          h('span', { class: 'ct num' }, fmtZone(tz)),
          h('span', { class: 'cs ' + (openNow ? 'open' : 'closed') }, openNow ? '● 交易中' : '○ 休市'),
          (() => {
            let msg;
            if (is24) msg = '全天候';
            else if (openNow) { const left = Math.floor((close - hr) * 60); msg = `距收盘 ${Math.floor(left / 60)}时${left % 60}分`; }
            else { let until = open - hr; if (until < 0) until += 24; msg = `距开盘 ${Math.floor(until)}时${Math.round((until % 1) * 60)}分`; }
            return h('span', { class: 'dim', style: { fontSize: '10px' } }, msg);
          })());
        if (link) { row.style.cursor = 'pointer'; row.addEventListener('click', () => selectSymbol(link)); }
        box.append(row);
      }
    }
    render();
    const timer = setInterval(render, 1000);
    card.api.destroy = () => clearInterval(timer);
    card.api.refresh = render;
  },
});
