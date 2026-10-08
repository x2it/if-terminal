/* 工具类插件: 预警 · 量化工作台 · 选股器 · Agent控制台 · 7x24快讯 · 系统 */
import { F } from '../fmt.js';
import {
  S, bus, persist, dispatch, selectSymbol, symName, toast, download, CMD_HELP,
  DEFAULTS, PERSIST_KEYS, RESET_SCOPES, LOCK_MODES,
  resetDefaults, undoLast, restoreSnapshot, snapshots, snapshot, clearSnapshots,
  exportState, importState, getLock, setLock,
} from '../core.js';
import { h } from '../ui.js';
import { registerCard } from '../grid.js';
import { getNews, getHealth, sendAgent } from '../api.js';
import { backtest, STRATEGY_EXAMPLES } from '../quant.js';

/* ---------- 价格预警 ---------- */
registerCard({
  type: 'alerts', title: '价格预警', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const form = h('div', { class: 'card-tools' });
    const sel = h('select', { class: 'mini-input', style: { width: 'auto', maxWidth: '110px' } });
    const op = h('select', { class: 'mini-input', style: { width: 'auto' } },
      ...['>', '<', '>=', '<='].map(o => h('option', { value: o }, o)));
    const val = h('input', { class: 'mini-input', style: { width: '76px' }, placeholder: '价格' });
    const add = h('button', { class: 'btn primary' }, '添加');
    form.append(sel, op, val, add);
    const list = h('div', { style: { flex: '1', overflowY: 'auto' } });
    bd.append(form, list);

    function renderSel() {
      sel.innerHTML = '';
      [...new Set([...S.watchlist, S.selected])].forEach(s =>
        sel.append(h('option', { value: s }, symName(s))));
    }
    function render() {
      renderSel();
      list.innerHTML = '';
      if (!S.alerts.length) { list.append(h('div', { class: 'hint' }, '暂无预警。预警触发时会 toast + 语音 + 大屏横幅。')); }
      S.alerts.forEach((a, i) => {
        const Q = S.quotes[a.sym];
        list.append(h('div', { class: 'agent-line' },
          h('span', { class: 'af', style: { cursor: 'pointer' }, onclick: () => selectSymbol(a.sym) }, symName(a.sym)),
          h('span', { class: 'ac' }, ` ${a.op} ${a.value} `),
          h('span', { class: 'aa' }, Q ? `现 ${F.price(Q.price)}` : ''),
          a.lastFired ? h('span', { style: { color: 'var(--amber)' } }, ' ✓触发') : '',
          h('span', { class: 'cop', style: { float: 'right', cursor: 'pointer' }, onclick: () => { S.alerts.splice(i, 1); persist('alerts', S.alerts); render(); } }, '✕')));
      });
      card.setBadge(`${S.alerts.length} 条规则`);
    }
    add.addEventListener('click', () => {
      if (!isFinite(+val.value)) { toast('请输入有效价格'); return; }
      dispatch('alert.add', { sym: sel.value, op: op.value, value: +val.value });
      val.value = ''; render();
    });
    /* 每个订阅都必须解绑: 卡片被删除后回调仍在执行, 会持续 render 一张已经脱离文档的 DOM */
    const offA = bus.on('alerts.changed', render);
    const offQ = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(render, 1500); });
    card.api.destroy = () => { offA(); offQ(); };
    card.api.refresh = render;
    render();
  },
});

/* ---------- 量化工作台 ---------- */
registerCard({
  type: 'quant', title: '量化工作台', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '6px 8px'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const row = h('div', { class: 'card-tools', style: { border: 'none', padding: '0 0 4px' } });
    const symSel = h('select', { class: 'mini-input', style: { width: 'auto', maxWidth: '120px' } });
    const perSel = h('select', { class: 'mini-input', style: { width: 'auto' } },
      ...['1d', '1h', '1w', '4h'].map(p => h('option', { value: p }, p)));
    const exSel = h('select', { class: 'mini-input', style: { width: 'auto' } },
      h('option', { value: '' }, '策略示例…'),
      ...Object.keys(STRATEGY_EXAMPLES).map(k => h('option', { value: k }, k)));
    const run = h('button', { class: 'btn primary' }, '▶ 回测');
    const exportBtn = h('button', { class: 'btn' }, '导出');
    row.append(symSel, perSel, exSel, run, exportBtn);
    const code = h('textarea', { class: 'q-code', spellcheck: 'false' });
    const stats = h('div', { class: 'q-stats' });
    const cvBox = h('div', { style: { flex: '1', minHeight: '60px', position: 'relative' } });
    const cv = h('canvas', { class: 'block' });
    cvBox.append(cv);
    bd.append(row, code, stats, cvBox);

    code.value = STRATEGY_EXAMPLES['双均线趋势'];
    exSel.addEventListener('change', () => { if (exSel.value) code.value = STRATEGY_EXAMPLES[exSel.value]; });
    function fillSyms() {
      symSel.innerHTML = '';
      [...new Set([...S.watchlist, S.selected, 'crypto:BTCUSDT', 'idx:sh000001', 'idx:usIXIC'])].forEach(s =>
        symSel.append(h('option', { value: s }, symName(s))));
      symSel.value = S.selected;
    }
    function drawEquity(eq) {
      const r = cvBox.getBoundingClientRect();
      if (r.width < 20) return;
      const dpr = devicePixelRatio || 1;
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, r.width, r.height);
      if (!eq.length) return;
      const vs = eq.map(e => e.v);
      const min = Math.min(...vs), max = Math.max(...vs), rng = (max - min) || 1;
      g.beginPath();
      eq.forEach((e, i) => {
        const x = i / (eq.length - 1) * (r.width - 8) + 4;
        const y = r.height - 4 - (e.v - min) / rng * (r.height - 12);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      const up = vs[vs.length - 1] >= vs[0];
      g.strokeStyle = up ? (S.upRed ? '#ff5757' : '#1fc98e') : (S.upRed ? '#1fc98e' : '#ff5757');
      g.lineWidth = 1.4; g.stroke();
      g.lineTo(r.width - 4, r.height); g.lineTo(4, r.height); g.closePath();
      g.fillStyle = (up ? (S.upRed ? '#ff5757' : '#1fc98e') : (S.upRed ? '#1fc98e' : '#ff5757')) + '18'; g.fill();
      g.fillStyle = '#5c7288'; g.font = '9px monospace'; g.textAlign = 'left';
      g.fillText('净值曲线 (含手续费 5bp)', 6, 12);
    }
    async function runBacktest() {
      const sym = symSel.value, period = perSel.value;
      card.setBadge('回测中…');
      try {
        const { getKline } = await import('../api.js');
        const data = await getKline(sym, period, 400);
        const res = backtest(data.bars, code.value);
        const st = res.stats;
        const cell = (k, v, cls = '') => h('div', { class: 'q-stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v num ' + cls }, v));
        stats.innerHTML = '';
        stats.append(
          cell('总收益', F.pct(st.ret), F.cls(st.ret)),
          cell('基准', F.pct(st.benchmark), F.cls(st.benchmark)),
          cell('夏普', st.sharpe.toFixed(2), st.sharpe > 1 ? 'up' : ''),
          cell('最大回撤', '-' + st.maxDD.toFixed(1) + '%', 'down'),
          cell('胜率', st.winRate.toFixed(0) + '%'),
          cell('交易', String(st.trades)),
          cell('盈亏比', st.profitFactor.toFixed(2)),
          cell('期末', F.big(st.final)));
        card.setBadge(`${symName(sym)} ${period} · ${data.bars.length}根K线 · ${st.trades}笔`);
        drawEquity(res.equity);
      } catch (e) {
        card.setBadge('回测失败: ' + e.message);
        toast('回测失败: ' + e.message);
      }
    }
    run.addEventListener('click', runBacktest);
    exportBtn.addEventListener('click', () => download(`strategy-${Date.now()}.js`, code.value));
    fillSyms();
    card.api.refresh = runBacktest;
  },
});

/* ---------- 全市场筛选 ----------
 * 叫"筛选"就得真能筛: 此前只有排序, 与"涨跌榜"完全重复, 属于名不副实。
 * 三条诚实约束 (决定这个卡片能不能算专业):
 *   1) 活跃度门槛用"品类内分位"而非绝对金额 —— A股成交额是元、美股是美元、加密是 USDT,
 *      写死"1亿"在别的品类上就是伪精确。分位在各自品类内算, 跨币种不可比的问题自然消失。
 *   2) 振幅依赖 high/low/open; 期货、外汇与部分指数上游不提供, 缺字段的品种直接不参与
 *      该条件 (并在 badge 里说明有几只被排除), 不猜测、不补零。
 *   3) 成交额缺失的品类整组不参与活跃度条件, 而不是被当成"成交额=0"沉底。 */
registerCard({
  type: 'screener', title: '全市场筛选', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const tools = h('div', { class: 'card-tools' });
    const fbar = h('div', { class: 'card-tools' });
    const body = h('div', { style: { flex: '1', overflowY: 'auto' } });
    bd.append(tools, fbar, body);
    let group = S.market || '', sort = 'pct';
    let fDir = 0, fChg = 0, fAmp = 0, fAmt = 0;   // 0 = 不限

    function renderTools() {
      tools.innerHTML = '';
      ['', 'A股', '港股', '美股', '加密货币', '指数', '期货', '外汇'].forEach(g =>
        tools.append(h('button', { class: 'chip' + (group === g ? ' on' : ''), onclick: () => { group = g; renderTools(); render(); } }, g || '全部')));
      tools.append(h('span', { style: { width: '8px' } }));
      [['pct', '按涨跌'], ['amt', '按成交'], ['sym', '按代码']].forEach(([k, l]) =>
        tools.append(h('button', { class: 'chip' + (sort === k ? ' on' : ''), onclick: () => { sort = k; renderTools(); render(); } }, l)));
    }
    function renderFbar() {
      fbar.innerHTML = '';
      const G = (label, cur, opts, set) => {
        fbar.append(h('span', { class: 'dim', style: { fontSize: '9px', marginLeft: '6px' } }, label));
        opts.forEach(([v, t]) => fbar.append(h('button', { class: 'chip' + (cur === v ? ' on' : ''), onclick: () => { set(v); renderFbar(); render(); } }, t)));
      };
      G('方向', fDir, [[0, '不限'], [1, '上涨'], [-1, '下跌']], v => fDir = v);
      G('幅度', fChg, [[0, '不限'], [3, '≥3%'], [5, '≥5%']], v => fChg = v);
      G('振幅', fAmp, [[0, '不限'], [3, '≥3%'], [5, '≥5%']], v => fAmp = v);
      G('活跃度', fAmt, [[0, '不限'], [30, '前30%'], [10, '前10%']], v => fAmt = v);
    }
    const ampOf = q => (q.high > 0 && q.low > 0 && q.open > 0) ? (q.high - q.low) / q.open * 100 : null;

    function render() {
      body.innerHTML = '';
      const all = S.universe.filter(u => group ? u.group === group : true)
        .map(u => S.quotes[u.sym]).filter(Boolean);
      const total = all.length;
      let pool = all, skipped = 0;
      if (fDir) pool = pool.filter(q => fDir > 0 ? q.pct > 0 : q.pct < 0);
      if (fChg) pool = pool.filter(q => Math.abs(q.pct || 0) >= fChg);
      if (fAmp) {
        const before = pool.length;
        pool = pool.filter(q => { const a = ampOf(q); return a != null && a >= fAmp; });
        skipped = before - pool.length;      // 缺振幅字段的不算"不满足", 只是无法判断
      }
      if (fAmt) {
        const byG = new Map();
        for (const q of pool) {
          const u = S.universe.find(x => x.sym === q.sym);
          const g = u?.group || '_';
          if (!byG.has(g)) byG.set(g, []);
          byG.get(g).push(q);
        }
        const keep = new Set();
        for (const arr of byG.values()) {
          const amts = arr.map(q => q.amt || 0).filter(x => x > 0).sort((a, b) => b - a);
          if (!amts.length) continue;        // 该品类上游不给成交额 → 整组不参与此条件
          const thr = amts[Math.min(amts.length - 1, Math.floor(amts.length * fAmt / 100))];
          for (const q of arr) if ((q.amt || 0) >= thr) keep.add(q);
        }
        pool = pool.filter(q => keep.has(q));
      }
      if (sort === 'pct') pool.sort((a, b) => (b.pct || -1e9) - (a.pct || -1e9));
      if (sort === 'amt') pool.sort((a, b) => (b.amt || 0) - (a.amt || 0));
      if (sort === 'sym') pool.sort((a, b) => a.sym.localeCompare(b.sym));

      const filtered = fDir || fChg || fAmp || fAmt;
      card.setBadge(filtered
        ? `命中 ${pool.length}/${total}${skipped ? ` · ${skipped} 只缺振幅` : ''}`
        : `${total} 只`);

      if (!pool.length) {
        body.append(h('div', { class: 'hint' }, '当前条件下没有品种命中, 放宽筛选试试。'));
        return;
      }
      const t = h('table', { class: 'tbl' });
      t.append(h('tr', {}, h('th', {}, '品种'), h('th', {}, '最新'), h('th', {}, '涨跌%'), h('th', {}, '振幅'), h('th', {}, '成交额')));
      pool.slice(0, 60).forEach(x => {
        const a = ampOf(x);
        t.append(h('tr', { class: 'symrow' + (x.sym === S.selected ? ' sel' : ''), onclick: () => selectSymbol(x.sym) },
          h('td', {}, x.name || x.sym, h('span', { class: 'dim', style: { fontSize: '9px', marginLeft: '4px' } }, x.sym.split(':')[0])),
          h('td', { class: 'num' }, F.price(x.price)),
          h('td', { class: 'num ' + F.cls(x.pct) }, F.pct(x.pct)),
          h('td', { class: 'num dim' }, a == null ? '--' : a.toFixed(2) + '%'),
          h('td', { class: 'num dim' }, x.amt ? F.big(x.amt) : '--')));
      });
      body.append(t);
    }
    renderTools(); renderFbar(); render();
    const offQ = bus.on('quotes', () => { clearTimeout(card._t); card._t = setTimeout(render, 1500); });
    const offM = bus.on('market', g => { group = g; renderTools(); render(); });
    card.api.destroy = () => { offQ(); offM(); };
    card.api.refresh = render;
  },
});

/* ---------- Agent 控制台 ---------- */
registerCard({
  type: 'agent', title: 'AGENT 控制台', badge: '',
  init(card) {
    const bd = card.bd; bd.style.padding = '0'; bd.style.display = 'flex'; bd.style.flexDirection = 'column';
    const quick = h('div', { class: 'card-tools' });
    const log = h('div', { style: { flex: '1', overflowY: 'auto', minHeight: '0' } });
    const inputRow = h('div', { class: 'card-tools', style: { borderTop: '1px solid var(--line)' } });
    const inp = h('input', { class: 'mini-input', placeholder: '输入指令 如 select {sym:"crypto:ETHUSDT"} 或 help, 回车执行' });
    const send = h('button', { class: 'btn primary' }, '执行');
    inputRow.append(inp, send);
    bd.append(quick, log, inputRow);

    [['大屏', 'tv'], ['盯盘', 'watch'], ['热力图', 'heatmap'], ['BTC', 'btc'], ['播报测试', 'ann'], ['指令帮助', 'help']].forEach(([label, k]) =>
      quick.append(h('button', { class: 'chip', onclick: () => doQuick(k) }, label)));
    function doQuick(k) {
      if (k === 'tv') sendAgent('tv', { on: true }, 'console');
      if (k === 'watch') sendAgent('layout', { name: 'watch' }, 'console');
      if (k === 'heatmap') sendAgent('open', { type: 'heatmap' }, 'console');
      if (k === 'btc') sendAgent('select', { sym: 'crypto:BTCUSDT' }, 'console');
      if (k === 'ann') sendAgent('announce', { text: 'Agent 指令总线在线 ✓' }, 'console');
      if (k === 'help') sendAgent('help', {}, 'console');
    }
    function exec() {
      const raw = inp.value.trim(); if (!raw) return;
      // 支持 JSON 形式 {cmd, args} 或 "cmd json-args"
      try {
        let cmd, args = {};
        if (raw.startsWith('{')) { const o = JSON.parse(raw); cmd = o.cmd; args = o.args || {}; }
        else {
          const sp = raw.indexOf(' ');
          cmd = sp < 0 ? raw : raw.slice(0, sp);
          if (sp > 0) { const rest = raw.slice(sp + 1); args = rest.startsWith('{') ? JSON.parse(rest) : { text: rest }; }
        }
        sendAgent(cmd, args, 'console-input');
        inp.value = '';
      } catch (e) { toast('指令解析失败: ' + e.message); }
    }
    send.addEventListener('click', exec);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') exec(); });

    const lines = [];
    function renderLog() {
      log.innerHTML = '';
      for (const e of lines.slice(-80).reverse()) {
        log.append(h('div', { class: 'agent-line' },
          h('span', { class: 'dim' }, new Date(e.ts).toTimeString().slice(0, 8) + ' '),
          h('span', { class: 'af' }, `[${e.from}] `),
          h('span', { class: 'ac' }, e.cmd + ' '),
          h('span', { class: 'aa' }, JSON.stringify(e.args).slice(0, 90))));
      }
      if (!lines.length) log.append(h('div', { class: 'hint' },
        '外部 Agent 指令入口: ', h('br'),
        // 用当前站点 origin, 避免部署到非 8787/非 localhost 时给出错误的示例地址
        h('code', {}, `curl -X POST ${location.origin}/api/agent -d '{"cmd":"select","args":{"sym":"crypto:BTCUSDT"}}'`), h('br'),
        '全部指令见 GET /api/agent · 任意卡片均可被 Agent 驱动'));
    }
    const offA = bus.on('agent.exec', e => { lines.push({ ...e, ts: Date.now() }); renderLog(); });
    // SSE 层会 dispatch → bus; 这里直接订阅原始事件即可
    card.api.destroy = () => offA();
    renderLog();
  },
});

/* ---------- 7x24 快讯 ---------- */
registerCard({
  type: 'news', title: '7×24 快讯', badge: '新浪财经', pad: false,
  init(card) {
    const bd = card.bd;
    const list = h('div');
    bd.append(list);
    let items = [];
    function render() {
      list.innerHTML = '';
      for (const n of items.slice(0, 40)) {
        list.append(h('div', { class: 'news-item' },
          h('span', { class: 'nt' }, (n.time || '').slice(11, 16)),
          h('span', { class: 'nx' }, n.text)));
      }
      if (!items.length) list.append(h('div', { class: 'hint' }, '加载中…'));
      card.setBadge(`${items.length} 条`);
    }
    const offN = bus.on('news', n => { items = n; render(); });
    const pull = () => getNews().then(n => { items = n; render(); }).catch(() => {
      if (!items.length) { list.innerHTML = ''; list.append(h('div', { class: 'hint' }, '快讯源暂不可用, 稍后自动重试')); }
    });
    pull();
    const timer = setInterval(pull, 40000);
    card.api.destroy = () => { clearInterval(timer); offN(); };
    card.api.refresh = render;
    render();
  },
});

/* ---------- 二次确认按钮: 第一次点"待确认", 4 秒内再点一次才真正执行 ----------
 * 恢复默认/清空这类破坏性操作必须挡一道, 避免手滑。用原生 confirm() 在 PWA 独立窗口里体验很差。 */
function confirmBtn(label, onConfirm, title = '', ms = 4000) {
  let armed = false, timer = null;
  const b = h('button', { class: 'btn mini', title: title || label }, label);
  const disarm = () => { armed = false; b.classList.remove('danger'); b.textContent = label; };
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true; b.classList.add('danger'); b.textContent = '再点一次确认';
      clearTimeout(timer);
      timer = setTimeout(disarm, ms);
      return;
    }
    clearTimeout(timer); disarm(); onConfirm();
  });
  return b;
}
const timeStr = t => new Date(t).toLocaleString('zh-CN', { hour12: false }).slice(5);

/* ---------- 系统 / 数据源健康 / 配置与恢复 ---------- */
registerCard({
  type: 'system', title: '系统', badge: '',
  init(card) {
    const bd = card.bd;
    const healthBox = h('div');
    const cfg = h('div', { class: 'cfg' });
    bd.append(healthBox, cfg);

    /* ---- 数据源健康 (每 15s 轮询, 独立刷新, 不打断配置面板) ---- */
    function renderHealth() {
      getHealth().then(h2 => {
        healthBox.innerHTML = '';
        const grid = h('div', { class: 'stat-grid' });
        const srcCell = (name, s) => h('div', { class: 'stat-cell' },
          h('div', { class: 'k' }, '数据源 · ' + name),
          h('div', { class: 'v ' + (s?.ok ? 'up' : 'down') }, s ? (s.ok ? `正常 ${s.ms}ms` : '故障 ' + (s.err || '')) : '未连接'));
        grid.append(srcCell('腾讯', h2.sources.tencent), srcCell('新浪', h2.sources.sina), srcCell('币安', h2.sources.crypto));
        grid.append(
          h('div', { class: 'stat-cell' }, h('div', { class: 'k' }, '品种总数'), h('div', { class: 'v num' }, String(h2.quotes))),
          h('div', { class: 'stat-cell' }, h('div', { class: 'k' }, 'SSE 客户端'), h('div', { class: 'v num' }, String(h2.clients))),
          h('div', { class: 'stat-cell' }, h('div', { class: 'k' }, '服务运行'), h('div', { class: 'v num' }, Math.floor(h2.uptime / 60) + ' 分钟')));
        healthBox.append(grid);
        if (h2.readOnly) healthBox.append(h('div', { class: 'cfg-note' }, '⚠ 服务端处于只读模式 (IF_READ_ONLY=1), 远程 Agent 写指令已被拒'));
      }).catch(() => {});
    }

    /* ---- 配置与恢复面板 ---- */
    function renderCfg() {
      cfg.innerHTML = '';
      const lock = getLock();
      const snaps = snapshots();

      /* 与出厂默认不同的项: 一眼看出自己改过什么 */
      const diffs = PERSIST_KEYS.filter(k => JSON.stringify(S[k]) !== JSON.stringify(DEFAULTS[k]));
      cfg.append(h('div', { class: 'cfg-hd' }, '◈ 当前配置'));
      cfg.append(h('div', { class: 'cfg-note' },
        '自选 ', h('code', {}, String(S.watchlist.length)), ' 只 · 预警 ', h('code', {}, String(S.alerts.length)),
        ' 条 · 布局 ', h('code', {}, S.layoutName), ' · 主题 ', h('code', {}, S.theme), h('br'),
        diffs.length
          ? h('span', {}, '与出厂默认不同: ', ...diffs.flatMap((k, i) => [i ? ' ' : '', h('code', {}, k)]))
          : '当前与出厂默认完全一致'));

      /* 配置锁 */
      cfg.append(h('div', { class: 'cfg-hd' }, '🔒 配置锁 · 防止被他人或自己改乱'));
      const lockRow = h('div', { class: 'cfg-row' });
      LOCK_MODES.forEach(m => lockRow.append(h('button', {
        class: 'chip' + (lock === m.key ? ' on' : ''), title: m.desc,
        onclick: () => { setLock(m.key); toast(`配置锁: <b>${m.label}</b> — ${m.desc}`, 5000); },
      }, m.label)));
      cfg.append(lockRow);
      cfg.append(h('div', { class: 'cfg-note' }, (LOCK_MODES.find(m => m.key === lock) || {}).desc,
        ' · 锁状态独立存放, 「恢复默认」不会顺手把锁解掉'));

      /* 恢复默认 */
      cfg.append(h('div', { class: 'cfg-hd' }, '↺ 一键恢复默认'));
      const resetRow = h('div', { class: 'cfg-row' });
      RESET_SCOPES.forEach(s => resetRow.append(confirmBtn(s.label, () => resetDefaults(s.key), s.desc)));
      cfg.append(resetRow);

      /* 撤销 / 快照 */
      cfg.append(h('div', { class: 'cfg-hd' }, '⟲ 撤销与快照'));
      const undoRow = h('div', { class: 'cfg-row' });
      undoRow.append(h('button', { class: 'btn mini', title: '回到上一次修改前的完整状态', onclick: () => undoLast() }, '↩ 撤销上一次修改'));
      undoRow.append(h('button', { class: 'btn mini', onclick: () => snapshot('手动快照') }, '存一份快照'));
      if (snaps.length) undoRow.append(confirmBtn('清空快照', () => clearSnapshots(), '删除全部本地快照'));
      cfg.append(undoRow);
      cfg.append(h('div', { class: 'cfg-note' },
        '设置变更前自动留档 (节流 2s, 最多保留 12 份)。快捷键 ', h('code', {}, 'Ctrl+Shift+Z'), ' 撤销 · ',
        h('code', {}, 'Ctrl+K'), ' 搜「恢复默认」'));
      if (snaps.length) {
        const box = h('div', { class: 'cfg-snaps' });
        [...snaps].reverse().forEach((s, ri) => {
          const i = snaps.length - 1 - ri;
          box.append(h('div', { class: 'cfg-snap', title: '点击回到该状态', onclick: () => restoreSnapshot(i) },
            h('span', { class: 'st' }, timeStr(s.t)),
            h('span', { class: 'sl' }, s.label),
            h('span', { class: 'sg' }, '恢复 ▸')));
        });
        cfg.append(box);
      } else {
        cfg.append(h('div', { class: 'cfg-empty' }, '暂无快照 — 改动任意设置后会自动留档'));
      }

      /* 备份 / 迁移 */
      cfg.append(h('div', { class: 'cfg-hd' }, '⇅ 备份与迁移'));
      const ioRow = h('div', { class: 'cfg-row' });
      const merge = h('input', { type: 'checkbox', style: { width: 'auto' }, title: '勾选=只覆盖文件里有的字段, 其余保持现状' });
      ioRow.append(
        h('button', { class: 'btn mini', onclick: doExport }, '导出 JSON'),
        h('button', { class: 'btn mini', onclick: () => file.click() }, '导入 JSON'),
        h('label', { class: 'cfg-note', style: { margin: '0', cursor: 'pointer' } }, merge, ' 合并导入'));
      cfg.append(ioRow);
      cfg.append(h('div', { class: 'cfg-note' },
        '导入会逐字段校验 (类型/取值范围), 非法字段跳过并列出, 不会污染状态; 导入前同样自动存一份快照。'));

      cfg.append(h('div', { class: 'hint' },
        '快捷键 ', h('code', {}, '?'), ' 查看全部 · 开放接口 ', h('code', {}, '/api/agent'), ' 可被外部 Agent 驱动'));

      mergeBox = cfg.querySelector('input[type=checkbox]');   // 供导入时读取
    }

    /* 隐藏的文件选择框: 导入 JSON */
    const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    let mergeBox = null;
    file.addEventListener('change', async () => {
      const f = file.files?.[0]; if (!f) return;
      try {
        const r = importState(JSON.parse(await f.text()), { merge: !!mergeBox?.checked });
        if (!r.ok) toast('导入失败: ' + r.error, 7000);
        else if (r.errors?.length) toast(`导入完成 (${r.imported.length} 项), 跳过:<br>${r.errors.join('<br>')}`, 7000);
      } catch (e) { toast('导入失败: 不是合法 JSON — ' + e.message, 7000); }
      file.value = '';
    });
    function doExport() {
      const o = exportState();
      download(`if-terminal-config-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(o, null, 2));
      toast(`已导出配置 · 自选 ${o.state.watchlist.length} 只 · 预警 ${o.state.alerts.length} 条`);
    }
    bd.append(file);

    renderHealth(); renderCfg();
    const t1 = setInterval(renderHealth, 15000);
    const offSnap = bus.on('snapshots', () => renderCfg());
    const offLock = bus.on('lock', () => renderCfg());
    const offReset = bus.on('reset', () => renderCfg());
    const offApplied = bus.on('state.applied', () => renderCfg());
    const offBlocked = bus.on('write.blocked', () => renderCfg());
    card.api.destroy = () => { clearInterval(t1); offSnap(); offLock(); offReset(); offApplied(); offBlocked(); };
    card.api.refresh = () => { renderHealth(); renderCfg(); };
  },
});
