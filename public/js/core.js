/* 核心: 全局状态 · 事件总线 · 指令总线(Agent开放) · 多窗口联动 · 持久化
 *
 * 与配置相关的纯逻辑(默认值/重置作用域/字段校验/快照栈/配置锁)全部在 config.js,
 * 本文件只负责把它们接到 DOM、事件总线与多窗口广播上 —— 这样纯逻辑可以被单测覆盖。
 */
import { sendAgent } from './api.js';
import {
  LS, clone, load, DEFAULTS, PERSIST_KEYS, defaults, RESET_SCOPES, scopeKeys, scopeLabel,
  LOCK_MODES, getLock, setLockRaw, isRemote, guardWrite, sanitizeState,
  snapshots, pushSnapshot, popSnapshot, takeSnapshot, clearSnapshots,
} from './config.js';

/* 纯逻辑层原样透出, 插件不必关心它定义在哪个文件 */
export { DEFAULTS, PERSIST_KEYS, defaults, RESET_SCOPES, scopeKeys, scopeLabel, LOCK_MODES, getLock, isRemote, guardWrite, snapshots, clearSnapshots };

/* ---------- localStorage 读写 ---------- */
const readAll = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
const writeAll = o => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch {} };

/* ---------- 事件总线 ---------- */
const handlers = new Map();
export const bus = {
  on(ev, fn) { (handlers.get(ev) || handlers.set(ev, new Set()).get(ev)).add(fn); return () => handlers.get(ev)?.delete(fn); },
  emit(ev, ...a) { handlers.get(ev)?.forEach(fn => { try { fn(...a); } catch (e) { console.error('[bus]', ev, e); } }); },
};

/* ---------- 全局状态 ---------- */
export const S = {
  quotes: {},            // sym -> quote
  universe: [],          // 品种目录
  selected: load('selected') || DEFAULTS.selected,
  watchlist: load('watchlist') || clone(DEFAULTS.watchlist),
  alerts: load('alerts') || [],
  layoutName: load('layoutName') || DEFAULTS.layoutName,
  customLayout: load('customLayout') || null,
  edit: false, tv: false, popout: null,
  theme: load('theme') || DEFAULTS.theme,
  upRed: load('upRed') !== false,
  tts: false,
  tickHist: {},          // sym -> [{t,p}] 客户端 tick 历史 (sparkline)
  market: load('market') || '',   // 全局市场过滤 (快捷键 1-7 / 命令面板)
  lockMode: getLock(),            // 配置锁 (off/soft/hard), 独立于 if-term-v1 存放
};

/* ---------- 配置快照: 每次设置变更前自动留档, 支持一键撤销 ---------- */
const SNAP_COOLDOWN = 2000;       // 自动快照节流, 避免高频切换品种刷爆栈
let lastSnapTs = 0;
let snapPaused = false;           // 批量写入期间暂停自动快照(改完只留一份)

export function currentState() {
  const o = {};
  for (const k of PERSIST_KEYS) o[k] = clone(S[k] === undefined ? DEFAULTS[k] : S[k]);
  return o;
}
/* state 可显式传入: 用于"变更前留档" (见 persist) */
export function snapshot(label = '手动快照', state = null) {
  const ok = pushSnapshot(state || currentState(), label);
  lastSnapTs = Date.now();
  if (ok) bus.emit('snapshots', snapshots());
  return ok;
}
function maybeSnapshot(label, state = null) {
  if (snapPaused) return;
  if (Date.now() - lastSnapTs < SNAP_COOLDOWN) return;
  snapshot(label, state);
}

/* ---------- 持久化 (带写保护 + 自动快照) ---------- */
export function persistRaw(k, v) { const a = readAll(); a[k] = v; writeAll(a); return true; }
export function persist(k, v) {
  if (PERSIST_KEYS.includes(k)) {
    const reason = guardWrite('local');
    if (reason) { bus.emit('write.blocked', { key: k, reason }); return false; }
  }
  const a = readAll();
  if (PERSIST_KEYS.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(v)) {
    /* 关键: 调用方几乎都是「先改内存 S[k], 再 persist」(见 applyTheme/applyUpRed/
     * 自选增删/预警增删), 此时 currentState() 已经是改后的值 —— 直接留档会让
     * 「撤销」回到改后状态, 等于空转。所以这里用本次写入前的落盘值把该字段还原,
     * 使快照 = 这次变更发生前一刻的完整状态。
     * (数组字段同理: S.alerts.push 改的是同一引用, 落盘旧值才是变更前的内容) */
    const prev = currentState();
    prev[k] = (a[k] === undefined) ? clone(DEFAULTS[k]) : clone(a[k]);
    maybeSnapshot('自动 · ' + k, prev);
  }
  a[k] = v; writeAll(a);
  return true;
}

/* ---------- 把一份完整状态应用到内存 + localStorage + 所有卡片 ---------- */
export function applyState(state, from = 'local') {
  snapPaused = true;
  try {
    for (const k of PERSIST_KEYS) {
      if (!(k in state)) continue;
      S[k] = clone(state[k]);
      persistRaw(k, S[k]);
    }
  } finally { snapPaused = false; }
  applyTheme(S.theme);
  applyUpRed(S.upRed);
  bus.emit('market', S.market);
  bus.emit('alerts.changed');
  bus.emit('watchlist.changed', S.watchlist);
  selectSymbol(S.selected, from);
  bus.emit('layout.set', S.layoutName);
  bus.emit('state.applied', state);
}

/* ---------- 恢复默认 / 撤销 / 回到指定快照 ---------- */
export function resetDefaults(scope = 'all', from = 'local', broadcast = true) {
  const reason = guardWrite(from);
  if (reason) { toast('🔒 ' + reason, 5000); return { ok: false, error: reason, blocked: true }; }
  snapshot(scope === 'all' ? '恢复出厂默认前' : `重置「${scopeLabel(scope)}」前`);
  const d = defaults();
  for (const k of scopeKeys(scope)) S[k] = clone(d[k]);
  applyState(currentState(), from);
  toast(`已恢复默认: <b>${scopeLabel(scope)}</b> · 旧配置已存入快照, 可一键撤销`, 5000);
  bus.emit('reset', scope);
  if (broadcast && BC) BC.postMessage({ t: 'reset', scope, oid: OID });
  return { ok: true, scope, keys: scopeKeys(scope) };
}
export function undoLast(from = 'local') {
  const reason = guardWrite(from);
  if (reason) { toast('🔒 ' + reason, 5000); return { ok: false, error: reason, blocked: true }; }
  const s = popSnapshot();
  if (!s) { toast('没有可撤销的历史快照'); return { ok: false, error: 'no snapshot' }; }
  applyState(s.state, from);
  bus.emit('snapshots', snapshots());
  toast(`已撤销: <b>${s.label}</b> (${new Date(s.t).toLocaleTimeString('zh-CN', { hour12: false })})`, 5000);
  return { ok: true, restored: { label: s.label, t: s.t } };
}
export function restoreSnapshot(i, from = 'local') {
  const s = takeSnapshot(i);
  if (!s) { toast('快照不存在'); return { ok: false, error: 'index out of range' }; }
  const reason = guardWrite(from);
  if (reason) { toast('🔒 ' + reason, 5000); return { ok: false, error: reason, blocked: true }; }
  snapshot('恢复快照前');
  applyState(s.state, from);
  toast(`已回到快照: <b>${s.label}</b> (${new Date(s.t).toLocaleString('zh-CN', { hour12: false })})`, 5000);
  return { ok: true, restored: { label: s.label, t: s.t } };
}

/* ---------- 配置导出 / 导入 ---------- */
export function exportState() {
  return {
    _app: 'if-terminal', _v: 1,
    exportedAt: new Date().toISOString(),
    state: currentState(),
    meta: { lockMode: getLock(), snapshotCount: snapshots().length, universeSize: S.universe.length },
  };
}
export function importState(obj, { merge = false } = {}) {
  // 先只挑出"源文件里真实提供且合法"的字段 —— 缺失的字段随后按模式补齐,
  // 这样 imported 反映的是真正被导入的内容, 而不是补全后的全集。
  const src = (obj?.state && typeof obj.state === 'object') ? obj.state : obj;
  const { clean, errors } = sanitizeState(src);
  const keys = Object.keys(clean);
  if (!keys.length) return { ok: false, error: errors[0] || '没有可导入的有效字段', errors };
  const reason = guardWrite('local');
  if (reason) { toast('🔒 ' + reason, 5000); return { ok: false, error: reason, blocked: true, errors }; }
  snapshot('导入配置前');
  applyState({ ...(merge ? currentState() : defaults()), ...clean }, 'local');
  toast(`已导入 <b>${keys.length}</b> 项配置${merge ? ' (合并)' : ''}${errors.length ? ` · 跳过 ${errors.length} 项` : ''}`, 6000);
  return { ok: true, imported: keys, errors };
}

/* ---------- 配置锁 (带 UI 通知与多窗口同步) ---------- */
export function setLock(mode, broadcast = true) {
  const m = setLockRaw(mode);
  S.lockMode = m;
  bus.emit('lock', m);
  if (broadcast && BC) BC.postMessage({ t: 'lock', mode: m, oid: OID });
  return m;
}

/* ---------- 全局市场切换: 所有卡片跟随 + 选中该市场基准品种 ---------- */
export const MARKET_BENCH = {
  '加密货币': 'crypto:BTCUSDT', 'A股': 'idx:sh000001', '美股': 'us:SPY',
  '港股': 'hk:02800', '期货': 'fut:hf_GC', '外汇': 'fx:fx_susdcnh', '指数': 'idx:sh000001',
};
export function setMarket(g, from = 'local') {
  const reason = guardWrite(from);
  if (reason) { toast('🔒 ' + reason, 4000); return false; }
  S.market = S.market === g ? '' : g;
  persist('market', S.market);
  bus.emit('market', S.market);
  if (S.market && MARKET_BENCH[S.market]) selectSymbol(MARKET_BENCH[S.market], from);
  return true;
}

/* ---------- 多窗口联动 (BroadcastChannel) ---------- */
export const OID = Math.random().toString(36).slice(2, 7);
export const BC = 'BroadcastChannel' in window ? new BroadcastChannel('if-terminal') : null;
if (BC) BC.onmessage = e => {
  const m = e.data; if (m.oid === OID) return;
  // 同源同机的多窗口联动视为"本地"操作, 不受 soft 锁拦截
  if (m.t === 'sym') { S.selected = m.sym; bus.emit('symbol', m.sym, 'bc'); }
  else if (m.t === 'xhair') bus.emit('xhair', m.data, 'bc');
  else if (m.t === 'theme') { applyTheme(m.theme); bus.emit('theme', m.theme); }
  else if (m.t === 'announce') bus.emit('announce', m.text);
  // broadcast=false: 收到方不再回播, 否则两个窗口会互相触发形成回环
  else if (m.t === 'reset') resetDefaults(m.scope || 'all', 'local', false);
  else if (m.t === 'lock') { S.lockMode = m.mode; bus.emit('lock', m.mode); }
};

/* ---------- 主题 / 配色 ---------- */
export function applyTheme(name, from = 'local') {
  if (name !== S.theme) {
    const reason = guardWrite(from);
    if (reason) { toast('🔒 ' + reason, 4000); return; }
  }
  S.theme = name; document.body.classList.toggle('theme-light', name === 'light');
  persist('theme', name);
  // PWA: 同步浏览器/系统栏底色 (与 --bg 一致)
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', name === 'light' ? '#eef1f5' : '#06090f');
  bus.emit('theme', name);
}
export function applyUpRed(on, from = 'local') {
  if (on !== S.upRed) {
    const reason = guardWrite(from);
    if (reason) { toast('🔒 ' + reason, 4000); return; }
  }
  S.upRed = on; persist('upRed', on);
  document.body.classList.toggle('up-green', !on);
  bus.emit('upred', on);
}

/* ---------- 品种联动核心: 全局选中 ---------- */
export function selectSymbol(sym, origin = 'local') {
  if (!sym) return;
  if (sym !== S.selected) {
    const reason = guardWrite(origin);
    if (reason) { toast('🔒 ' + reason, 4000); return; }
  }
  S.selected = sym;
  persist('selected', sym);
  bus.emit('symbol', sym, origin);
  if (BC && origin !== 'bc') BC.postMessage({ t: 'sym', sym, oid: OID });
}

/* ---------- toast / TTS / announce ---------- */
export function toast(html, ms = 5000) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast'; el.innerHTML = html;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
export function speak(text) {
  if (!S.tts || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; u.rate = 1.05;
  speechSynthesis.speak(u);
}
let annTimer;
export function announce(text, say = true) {
  const el = document.getElementById('announce');
  document.getElementById('announce-text').textContent = text;
  el.classList.add('show');
  clearTimeout(annTimer);
  annTimer = setTimeout(() => el.classList.remove('show'), 4200);
  if (say) speak(text);
  if (BC) BC.postMessage({ t: 'announce', text, oid: OID });
  bus.emit('announce', text);
}

/* ---------- Agent 指令总线: UI 内部 / SSE / HTTP 全部汇聚于此 ---------- */
export const CMD_HELP = [
  ['select', '{sym}', '全局联动切换品种'],
  ['open', '{type}', '打开卡片 (kline/heatmap/watchlist/indices/movers/corr/worldclock/alerts/quant/screener/news/agent/system)'],
  ['close', '{id}', '关闭卡片'],
  ['layout', '{name}', '布局: watch/research/tv1/tv2'],
  ['tv', '{on}', '大屏TV模式'],
  ['edit', '{on}', '布局编辑模式'],
  ['announce', '{text}', '大屏横幅播报'],
  ['say', '{text}', '语音播报'],
  ['tts', '{on}', '语音播报开关'],
  ['theme', '{dark|light}', '切换昼/夜'],
  ['upred', '{on}', '红涨绿跌开关'],
  ['alert.add', '{sym,op,value}', '添加价格预警'],
  ['fullscreen', '{on}', '浏览器全屏'],
  ['reset', '{scope}', '恢复默认: all / watchlist / layout / alerts / view / filter'],
  ['undo', '', '撤销上一次修改 (配置快照栈)'],
  ['snapshot', '{label}', '手动存一份配置快照'],
  ['lock', '{mode}', '配置锁: off(不锁) / soft(防远程) / hard(全锁定)'],
  ['unlock', '', '解除配置锁 (始终可用, 上锁后也能解锁)'],
  ['help', '', '显示指令说明'],
];

/* 写类指令: hard 锁全拦, soft 锁只拦远程来源。
 * 播报 / 语音 / 帮助 / 解锁 不在集合内 —— 它们不改动任何持久化状态, 上锁后依然可用。 */
const WRITE_CMDS = new Set(['select', 'open', 'close', 'layout', 'tv', 'edit', 'tts', 'theme',
  'upred', 'alert.add', 'fullscreen', 'reset', 'undo', 'snapshot']);

export function dispatch(cmd, args = {}, from = 'local') {
  const A = args;
  if (WRITE_CMDS.has(cmd)) {
    const reason = guardWrite(from);
    if (reason) {
      toast(`🔒 ${reason}<br><span class="dim">指令 <code>${cmd}</code> 已丢弃</span>`, 5000);
      bus.emit('write.blocked', { cmd, from, reason });
      return { ok: false, error: reason, blocked: true };
    }
  }
  switch (cmd) {
    case 'select': selectSymbol(A.sym, 'agent'); break;
    case 'open': bus.emit('layout.open', A.type, A.span); break;
    case 'close': bus.emit('layout.close', A.id); break;
    case 'layout': bus.emit('layout.set', A.name); break;
    case 'tv': setTv(A.on !== false); break;
    case 'edit': setEdit(A.on !== false); break;
    case 'announce': announce(A.text || String(args), true); break;
    case 'say': speak(A.text || String(args)); break;
    case 'tts': setTts(A.on !== false); break;
    // 参数宽容: name / v / mode 都认, 未指定时按文档字面量 'light' 判 light, 其余回落 dark
    case 'theme': {
      const t = String(A.name ?? A.v ?? A.mode ?? A.value ?? '').toLowerCase();
      applyTheme(t === 'light' || t === '亮' ? 'light' : 'dark', from);
      break;
    }
    case 'upred': applyUpRed(A.on !== false, from); break;
    case 'alert.add':
      if (A.sym && A.op && isFinite(A.value)) {
        S.alerts.push({ sym: A.sym, op: A.op, value: +A.value, note: A.note || '', t: Date.now() });
        persist('alerts', S.alerts); bus.emit('alerts.changed');
        toast(`已添加预警 <b>${A.sym}</b> ${A.op} ${A.value}`);
      }
      break;
    case 'fullscreen':
      if (A.on !== false) document.documentElement.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.().catch(() => {});
      break;
    case 'reset': {
      const r = resetDefaults(A.scope || 'all', from);
      if (!r.ok) return { ok: false, error: r.error, blocked: true };
      break;
    }
    case 'undo': {
      const r = undoLast(from);
      if (!r.ok) return { ok: false, error: r.error };
      break;
    }
    case 'snapshot': snapshot(A.label || 'Agent 快照'); toast('已保存配置快照'); break;
    case 'lock': {
      const m = A.mode || 'soft';
      setLock(m);
      toast(`配置锁: <b>${(LOCK_MODES.find(x => x.key === m) || {}).label || m}</b>`, 5000);
      break;
    }
    case 'unlock': setLock('off'); toast('配置锁已解除'); break;
    case 'help':
      toast('<b>Agent 指令</b><br>' + CMD_HELP.map(c => `${c[0]} ${c[1]} — ${c[2]}`).join('<br>'), 12000);
      break;
    default: toast(`未知指令: ${cmd}`); return { ok: false };
  }
  bus.emit('agent.exec', { cmd, args, from });
  return { ok: true };
}

export function setEdit(on) { S.edit = on !== undefined ? on : !S.edit; document.body.classList.toggle('edit', S.edit); bus.emit('edit', S.edit); }
export function setTts(on) {
  S.tts = on !== undefined ? on : !S.tts;
  if (S.tts) speak('语音播报已开启');
  bus.emit('tts', S.tts);
}
export function setTv(on) {
  S.tv = on !== undefined ? on : !S.tv;
  document.body.classList.toggle('tv', S.tv);
  if (!S.tv) { bus.emit('layout.set', 'watch'); bus.emit('tv', false); }
  else bus.emit('tv', true);
  setTimeout(() => bus.emit('layout.changed'), 60);
}
export function sendRemote(cmd, args) { // 通过服务端总线广播 (含所有弹窗/多屏)
  // 服务端拒绝(只读模式 / 门禁)时不再本地兜底执行 —— 否则写保护形同虚设
  return sendAgent(cmd, args, 'web-ui').catch(e => {
    const msg = String(e?.message || e);
    toast(`指令 <b>${cmd}</b> 被服务端拒绝: ${msg}`, 6000);
    return { ok: false, error: msg };
  });
}

/* ---------- 行情接入: 更新状态 + tick 历史 ---------- */
/* 价格跳动闪烁: 数字变化瞬间给元素亮一下背景 (涨/跌方向见 main.css 的 fx-up/fx-dn)。
 * 先移除再加 class + 强制 reflow, 让连续两次跳动也能重新触发动画,
 * 否则 animation 处于进行中时同名 class 不会重放 —— 闪一下就永远不闪了。
 * 旧值由调用方携带: flashPrice(el, oldPrice, newPrice), 价格没变不闪。 */
export function flashPrice(el, oldV, newV) {
  if (!el || oldV == null || newV == null || newV === oldV) return;
  const cls = newV > oldV ? 'fx-up' : 'fx-dn';
  el.classList.remove('fx-up', 'fx-dn');
  void el.offsetWidth;
  el.classList.add(cls);
}

export function ingestQuotes(list) {
  const now = Date.now();
  for (const q of list) {
    S.quotes[q.sym] = q;
    const h = S.tickHist[q.sym] || (S.tickHist[q.sym] = []);
    const last = h[h.length - 1];
    if (!last || now - last.t > 20000) h.push({ t: now, p: q.price });
    if (h.length > 180) h.shift();
  }
  bus.emit('quotes', list);
  checkAlerts();
}

/* ---------- 预警引擎 ---------- */
let lastAlert = {};
export function checkAlerts() {
  for (const a of S.alerts) {
    const q = S.quotes[a.sym]; if (!q || q.price == null) continue;
    const hit =
      a.op === '>' ? q.price > a.value :
      a.op === '<' ? q.price < a.value :
      a.op === '>=' ? q.price >= a.value :
      a.op === '<=' ? q.price <= a.value : false;
    if (hit) {
      const key = a.sym + a.op + a.value;
      /* 节流必须用毫秒时间戳: 此前拿 now5() (5 秒为一个计数单位) 去和毫秒 60000 比较,
       * 实际节流成了 60000 个 5 秒 ≈ 83 小时 —— 同一条预警触发后三天内不会再提醒。 */
      const now = Date.now();
      if (now - (lastAlert[key] || 0) < 60000) continue;
      lastAlert[key] = now;
      const msg = `预警触发 <b>${q.name || a.sym}</b> ${a.op} ${a.value} (现价 ${q.price})`;
      toast(msg, 9000);
      // 播报文案要匹配运算符: 原本只有 '>' 说"突破", '>=' 会被念成"跌破"
      const up = a.op === '>' || a.op === '>=';
      speak(`${q.name || a.sym} ${up ? '突破' : '跌破'} ${a.value}`);
      announce(`${q.name || a.sym} ${up ? '↑突破' : '↓跌破'} ${a.value}`, false);
      a.lastFired = Date.now(); persist('alerts', S.alerts);
      bus.emit('alert.fired', a);
    }
  }
}

/* ---------- 工具 ---------- */
export const symName = sym => {
  const q = S.quotes[sym]; if (q?.name) return q.name;
  const u = S.universe.find(x => x.sym === sym); return u ? u.name : sym;
};
export function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
