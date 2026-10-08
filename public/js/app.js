/* IF TERMINAL 入口: 启动 · 顶栏 · 命令面板 · TV轮播 · 快捷键 · 状态栏 · 移动端 · 弹窗模式 */
import {
  S, bus, dispatch, selectSymbol, ingestQuotes, applyTheme, applyUpRed, setTv, setEdit, setTts, setMarket,
  MARKET_BENCH, persist, toast, BC, OID,
  RESET_SCOPES, LOCK_MODES, resetDefaults, undoLast, snapshot, setLock, getLock,
} from './core.js';
import { connectSSE, getUniverse, getHealth } from './api.js';
import { initGrid, setLayout, popout, registry, createCard, LAYOUTS } from './grid.js';
import { h } from './ui.js';
import { F } from './fmt.js';
import './plugins/market.js';
import './plugins/viz.js';
import './plugins/chart.js';
import './plugins/tools.js';
import './plugins/radar.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const IS_POPOUT = params.has('pop');

/* ---------- 快捷键表 (boot 前声明, 避免 TDZ) ---------- */
const SHORTCUTS = [
  ['Ctrl K', '命令面板 (可搜「恢复默认」/「撤销」/「配置锁」)'],
  ['Ctrl Shift Z', '撤销上一次配置修改'],
  ['1-7', '市场过滤 (加密/A股/美股/港股/期货/外汇/指数)'],
  ['↑ ↓', '自选上下切换'], ['/', '聚焦搜索'],
  ['E', '编辑布局'], ['T', '大屏TV'], ['F', '全屏'], ['R', '刷新数据'],
  ['Esc', '退出当前模式'], ['?', '本帮助'],
];

/* ---------- 弹窗卡片模式 (多屏) ---------- */
if (IS_POPOUT) {
  document.body.classList.add('popout');
  const type = params.get('pop');
  if (params.get('theme') === 'light') applyTheme('light');
  boot().then(() => {
    const card = createCard(type);
    if (card) {
      $('grid').append(card.el);
      document.title = `IF · ${card.def.title}`;
    }
  }).catch(e => console.error('[IF] popout fail:', e));
} else {
  boot().catch(e => {
    console.error('[IF] boot fail:', e);
    document.getElementById('grid').innerHTML = `<div class="hint" style="padding:20px">启动异常: ${(e.stack || e.message || e).slice ? String(e.stack || e.message || e).slice(0, 400) : e}<br>请刷新重试</div>`;
  });
}

async function boot() {
  applyTheme(S.theme);
  applyUpRed(S.upRed);
  initGrid($('grid'));
  wireTopbar();
  wirePalette();
  wireKeys();
  wireHelp();
  wirePWA();

  try { const u = await getUniverse(); S.universe = u.catalog; } catch {}
  connectSSE({
    onState: ok => { $('conn').classList.toggle('off', !ok); if (ok) setTimeout(() => refreshStatus(), 400); },
    /* 如实标注当前实时通道: SSE 被中间层掐断时会降级为轮询 —— 必须让用户看得见,
     * 否则"数据还在动但通道其实变了"就成了没人知道的暗坑。 */
    onMode: m => {
      $('conn').classList.toggle('poll', m === 'poll');
      $('conn').title = m === 'poll' ? '实时通道: 轮询降级 (SSE 被代理/网关阻断)' : '实时通道: SSE 长连接';
    },
    onHello: d => { if (d.news?.length) bus.emit('news', d.news); },
    onQuotes: ingestQuotes,
    onNews: list => bus.emit('news', list),
    onAgent: e => dispatch(e.cmd, e.args, 'agent:' + (e.from || '?')),
  });

  // 布局 (弹窗模式只渲染单个卡片)
  if (!IS_POPOUT) {
    const want = params.get('layout');           // PWA 快捷方式 / 深链: ?layout=mobile
    const mobile = matchMedia('(max-width: 760px)').matches;
    if (want && LAYOUTS[want]) setLayout(want);
    else if (mobile) setLayout('mobile');
    else setLayout(S.layoutName === 'mobile' ? 'watch' : S.layoutName);
    // 断点穿越自适应: 小屏↔大屏自动切换, 桌面布局记忆保持
    const mq = matchMedia('(max-width: 760px)');
    const onBp = e => {
      if (e.matches) setLayout('mobile');
      else if (S.layoutName === 'mobile') setLayout('watch');
    };
    mq.addEventListener ? mq.addEventListener('change', onBp) : mq.addListener(onBp);
  }

  clockLoop();
  buildTape();
  statusLoop();
  bus.on('quotes', () => tapeRefreshThrottled());
  bus.on('market', g => { $('btn-market').textContent = '市场：' + (g || '全部'); });
  if (S.tv) tvRotate(true);
  if (params.get('tv') === '1' && !S.tv) setTv(true);   // 深链 / PWA 快捷方式: ?tv=1
}

/* ---------- 顶栏 ---------- */
function wireTopbar() {
  $('btn-market').addEventListener('click', () => {
    const order = ['', ...Object.keys(MARKET_BENCH)];
    const next = order[(order.indexOf(S.market) + 1) % order.length];
    if (next) setMarket(next); else { S.market = ''; persist('market', ''); bus.emit('market', ''); $('btn-market').textContent = '市场：全部'; }
  });
  $('btn-market').textContent = '市场：' + (S.market || '全部');
  $('btn-layout').addEventListener('click', () => {
    const order = ['watch', 'research', 'tv1', 'tv2', 'mobile'];
    const next = order[(order.indexOf(S.layoutName) + 1) % order.length];
    dispatch('layout', { name: next });
  });
  bus.on('layout.set.done', name => {
    const zh = { watch: '盯盘', research: '研究', tv1: '大屏A', tv2: '大屏B', mobile: '移动' };
    $('btn-layout').textContent = '布局：' + (zh[name] || name);
  });
  $('btn-edit').addEventListener('click', () => dispatch('edit', {}));
  bus.on('edit', on => $('btn-edit').classList.toggle('on', on));
  $('btn-tv').addEventListener('click', () => dispatch('tv', {}));
  bus.on('tv', on => { $('btn-tv').classList.toggle('on', on); tvRotate(on); });
  $('btn-tts').addEventListener('click', () => dispatch('tts', {}));
  bus.on('tts', on => { const b = $('btn-tts'); b.classList.toggle('on', on); b.textContent = on ? '语音·开' : '语音'; });
  $('btn-theme').addEventListener('click', () => { applyTheme(S.theme === 'dark' ? 'light' : 'dark'); });
  $('btn-upred').addEventListener('click', () => applyUpRed(!S.upRed));
  bus.on('upred', on => $('btn-upred').textContent = on ? '红涨' : '绿涨');
  $('btn-help').addEventListener('click', () => $('help-overlay').classList.toggle('show'));

  /* 配置锁按钮: 循环 off → soft(防远程) → hard(全锁定) → off */
  const lb = $('btn-lock');
  if (lb) {
    const LOCK_ICON = { off: '未锁', soft: '防远程', hard: '已锁定' };
    const paintLock = m => {
      lb.textContent = LOCK_ICON[m] || LOCK_ICON.off;
      lb.classList.toggle('locked', m !== 'off');
      lb.title = '配置锁 · ' + ((LOCK_MODES.find(x => x.key === m) || {}).desc || '');
    };
    lb.addEventListener('click', () => {
      const order = ['off', 'soft', 'hard'];
      setLock(order[(order.indexOf(getLock()) + 1) % order.length]);
    });
    bus.on('lock', paintLock);
    paintLock(getLock());
  }
}

function clockLoop() {
  const el = $('clock');
  const tick = () => {
    const d = new Date();
    el.textContent = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })
      + ' ' + d.toLocaleTimeString('zh-CN', { hour12: false });
  };
  tick(); setInterval(tick, 1000);
}

/* ---------- 状态栏: 数据源健康 + 品种数 + 更新时间 ---------- */
let lastQuoteTs = 0;
let refreshStatus = () => {};   // 由 statusLoop 接管, 供 SSE 建连后立即刷新状态栏
bus.on('quotes', list => { if (list.length) lastQuoteTs = Date.now(); });
function statusLoop() {
  const stL = $('st-left'), stM = $('st-mid');
  const render = h2 => {
    const src = (name, key) => `<span class="src"><span class="dot${h2.sources?.[key]?.ok ? '' : ' bad'}"></span>${name}${h2.sources?.[key]?.ms != null && h2.sources[key].ok ? ' ' + h2.sources[key].ms + 'ms' : ''}</span>`;
    stL.innerHTML = src('腾讯', 'tencent') + src('新浪', 'sina') + src('币安', 'crypto') + src('快讯', 'news');
    /* 相对时间比绝对时刻更能回答"这是不是实时的": 上游一卡住, 秒数就会自己变大;
     * 只写 14:03:11, 用户无从判断那是一秒前还是十分钟前。 */
    const age = lastQuoteTs ? F.ago(Date.now() - lastQuoteTs) : '';
    stM.textContent = `品种 ${Object.keys(S.quotes).length} · 行情 ${lastQuoteTs ? new Date(lastQuoteTs).toTimeString().slice(0, 8) : '--'}${age ? ` (${age}前)` : ''} · SSE ${h2.clients} 端`;
  };
  // 健康数据每 15s 轮询一次, 但"品种/更新"要跟着行情即时变, 否则首屏会挂 15s 的 0
  let health = null, lastPaint = 0;
  const load = () => getHealth().then(h => { health = h; render(h); }).catch(() => {});
  refreshStatus = load;
  load();
  setInterval(load, 15000);
  bus.on('quotes', () => {
    const now = Date.now();
    if (health && now - lastPaint > 1000) { lastPaint = now; render(health); }
  });
}

/* ---------- 跑马灯 ---------- */
const TAPE_SYMS = ['idx:sh000001', 'idx:sz399006', 'idx:usDJI', 'idx:usIXIC', 'idx:int_hangseng', 'idx:int_nikkei', 'idx:int_ftse', 'fut:hf_CHA50CFD', 'fut:hf_GC', 'fut:hf_CL', 'crypto:BTCUSDT', 'crypto:ETHUSDT', 'fx:fx_susdcnh', 'cn:sh600519', 'hk:00700', 'us:NVDA.OQ', 'us:AAPL.OQ', 'us:TSLA.OQ'];
function buildTape() {
  const tr = $('tape-track');
  tr.innerHTML = '';
  for (const round of [0, 1]) for (const sym of TAPE_SYMS) {
    const el = h('span', { class: 'tape-item', 'data-sym': sym }, h('span', { class: 'tn' }, sym), '--');
    el.addEventListener('click', () => selectSymbol(sym));
    tr.append(el);
  }
}
let tapeT;
const tapeRefreshThrottled = () => { clearTimeout(tapeT); tapeT = setTimeout(refreshTape, 900); };
function refreshTape() {
  document.querySelectorAll('.tape-item').forEach(el => {
    const Q = S.quotes[el.dataset.sym]; if (!Q) return;
    el.innerHTML = `<span class="tn">${Q.name || el.dataset.sym}</span><span class="num">${Q.price ?? '--'}</span> <span class="num ${Q.pct >= 0 ? 'up' : 'down'}">${Q.pct >= 0 ? '+' : ''}${(Q.pct ?? 0).toFixed(2)}%</span>`;
  });
}

/* ---------- TV 大屏轮播 ---------- */
let tvTimer;
function tvRotate(on) {
  clearInterval(tvTimer);
  $('tv-hint').textContent = on ? 'IF TERMINAL · TV MODE · ESC 退出 · 每20秒轮播' : '';
  if (!on) return;
  let page = S.layoutName.startsWith('tv') ? S.layoutName : 'tv1';
  tvTimer = setInterval(() => {
    page = page === 'tv1' ? 'tv2' : 'tv1';
    dispatch('layout', { name: page });
  }, 20000);
  if (!S.layoutName.startsWith('tv')) dispatch('layout', { name: 'tv1' });
}

/* ---------- 命令面板 Ctrl+K ---------- */
function palCommands() {
  const cmds = [];
  const zh = { watch: '盯盘布局', research: '研究布局', tv1: '大屏页A', tv2: '大屏页B', mobile: '移动布局' };
  for (const [k, v] of Object.entries(zh)) cmds.push({ k: '布局', t: v, d: k, run: () => dispatch('layout', { name: k }) });
  for (const g of Object.keys(MARKET_BENCH)) cmds.push({ k: '市场', t: '市场过滤: ' + g, d: '快捷键 ' + (Object.keys(MARKET_BENCH).indexOf(g) + 1), run: () => setMarket(g) });
  cmds.push({ k: '市场', t: '市场过滤: 全部', d: '清除', run: () => { S.market = ''; persist('market', ''); bus.emit('market', ''); } });
  cmds.push(
    { k: '模式', t: '大屏TV模式', d: 'T', run: () => dispatch('tv', { on: !S.tv }) },
    { k: '模式', t: '编辑布局', d: 'E', run: () => dispatch('edit', { on: !S.edit }) },
    { k: '模式', t: '语音播报', d: 'TTS', run: () => dispatch('tts', { on: !S.tts }) },
    { k: '模式', t: '切换主题', d: '昼/夜', run: () => dispatch('theme', { name: S.theme === 'dark' ? 'light' : 'dark' }) },
    { k: '模式', t: '红涨绿跌切换', d: '配色约定', run: () => applyUpRed(!S.upRed) },
    { k: '模式', t: '全屏', d: 'F', run: () => dispatch('fullscreen', { on: true }) },
    { k: '模式', t: '刷新数据', d: 'R', run: () => hardRefresh() },
    { k: '帮助', t: '快捷键说明', d: '?', run: () => $('help-overlay').classList.add('show') },
    { k: 'Agent', t: 'Agent 指令帮助', d: '开放API', run: () => dispatch('help', {}) },
  );
  // 恢复默认 / 撤销 / 配置锁: 改错了随时能回来
  cmds.push(
    { k: '恢复', t: '恢复出厂默认 · 全部设置', d: 'reset all', run: () => resetDefaults('all') },
    ...RESET_SCOPES.filter(s => s.key !== 'all').map(s =>
      ({ k: '恢复', t: `恢复默认 · ${s.label}`, d: 'reset ' + s.key, run: () => resetDefaults(s.key) })),
    { k: '恢复', t: '撤销上一次修改', d: 'Ctrl+Shift+Z', run: () => undoLast() },
    { k: '恢复', t: '存一份配置快照', d: 'snapshot', run: () => snapshot('手动快照') },
    { k: '恢复', t: '打开配置面板 · 系统卡片', d: 'system', run: () => dispatch('open', { type: 'system' }) },
  );
  for (const m of LOCK_MODES) cmds.push({ k: '配置锁', t: `配置锁 · ${m.label}`, d: m.key, run: () => setLock(m.key) });
  for (const type of registry.keys()) cmds.push({ k: '卡片', t: '打开卡片: ' + type, d: 'open', run: () => dispatch('open', { type }) });
  for (const u of S.universe.slice(0, 400))
    cmds.push({ k: u.group, t: `${u.name}`, d: u.sym, run: () => selectSymbol(u.sym) });
  return cmds;
}
function hardRefresh() {
  getUniverse().then(u => { S.universe = u.catalog; toast('品种目录已刷新 (' + u.catalog.length + ')'); }).catch(() => toast('刷新失败'));
}
let palIdx = 0;
function wirePalette() {
  const box = $('palette'), input = $('palette-input'), list = $('palette-list');
  let filtered = [];
  const renderList = () => {
    list.innerHTML = '';
    filtered.slice(0, 50).forEach((c, i) => {
      const el = h('div', { class: 'pal-item' + (i === palIdx ? ' act' : ''), onclick: () => { c.run(); close(); } },
        h('span', { class: 'k' }, c.k), h('span', { class: 't' }, c.t), h('span', { class: 'd' }, c.d));
      list.append(el);
    });
  };
  const open = () => { box.classList.add('show'); input.value = ''; palIdx = 0; filtered = palCommands(); renderList(); input.focus(); };
  const close = () => box.classList.remove('show');
  input.addEventListener('input', () => {
    const kw = input.value.toLowerCase();
    filtered = palCommands().filter(c => !kw || c.t.toLowerCase().includes(kw) || c.d.toLowerCase().includes(kw) || c.k.includes(kw));
    palIdx = 0; renderList();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { palIdx = Math.min(filtered.length - 1, palIdx + 1); renderList(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { palIdx = Math.max(0, palIdx - 1); renderList(); e.preventDefault(); }
    if (e.key === 'Enter' && filtered[palIdx]) { filtered[palIdx].run(); close(); }
    if (e.key === 'Escape') close();
  });
  box.addEventListener('click', e => { if (e.target === box) close(); });
  window._openPalette = open;
}

/* ---------- 快捷键帮助层 ---------- */
function wireHelp() {
  const grid = $('help-grid');
  for (const [k, d] of SHORTCUTS) grid.append(h('div', { class: 'help-item' }, h('kbd', {}, k), d));
  $('help-overlay').addEventListener('click', e => { if (e.target.id === 'help-overlay') e.target.classList.remove('show'); });
}

/* ---------- PWA: Service Worker 注册 + 安装入口 ---------- */
let deferredInstall = null;
function wirePWA() {
  const btn = $('btn-install');
  // 已是独立窗口(装过)就不再显示安装按钮; iOS 无 beforeinstallprompt, 走"添加到主屏幕"
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (btn && !standalone) {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstall = e;
      btn.style.display = '';
    });
    btn.addEventListener('click', async () => {
      if (!deferredInstall) { toast('请用浏览器菜单 → “安装 IF TERMINAL”, 或点地址栏右侧的安装图标'); return; }
      const ev = deferredInstall; deferredInstall = null; btn.style.display = 'none';
      ev.prompt();
      const { outcome } = await ev.userChoice;
      toast(outcome === 'accepted' ? 'IF TERMINAL 已安装' : '已取消安装');
    });
  }
  window.addEventListener('appinstalled', () => { if (btn) btn.style.display = 'none'; toast('IF TERMINAL 已安装到本机'); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch(e => console.warn('[IF] Service Worker 注册失败:', e.message));
  }
}

/* ---------- 全局快捷键 ---------- */
function wireKeys() {
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); window._openPalette?.(); return; }
    // Ctrl+Shift+Z: 撤销上一次配置修改 (恢复默认/改自选/改布局 都能回退)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Escape') document.activeElement?.blur();
      return;
    }
    const k = e.key;
    // 1-7 市场过滤
    if (/^[1-7]$/.test(k)) {
      const g = Object.keys(MARKET_BENCH)[+k - 1];
      if (g) setMarket(g);
      return;
    }
    // ↑/↓ 自选导航
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const wl = S.watchlist;
      if (!wl.length) return;
      let i = wl.indexOf(S.selected);
      i = k === 'ArrowDown' ? (i + 1) % wl.length : (i - 1 + wl.length) % wl.length;
      selectSymbol(wl[i]);
      return;
    }
    if (k === '/') { e.preventDefault(); window._openPalette?.(); return; }
    if (k === '?') { $('help-overlay').classList.toggle('show'); return; }
    const low = k.toLowerCase();
    if (low === 'e') dispatch('edit', {});
    if (low === 't') dispatch('tv', {});
    if (low === 'f') dispatch('fullscreen', { on: true });
    if (low === 'r') hardRefresh();
    if (k === 'Escape') {
      if ($('palette').classList.contains('show')) $('palette').classList.remove('show');
      else if ($('help-overlay').classList.contains('show')) $('help-overlay').classList.remove('show');
      else if (S.edit) dispatch('edit', { on: false });
      else if (S.tv) dispatch('tv', { on: false });
    }
  });
}
