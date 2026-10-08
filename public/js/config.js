/* 配置层: 出厂默认值 · 重置作用域 · 字段校验 · 快照栈 · 配置锁
 *
 * 单独成文件的原因:
 *   1. 默认值必须有唯一真相源 —— 散落在 core.js 里很容易被复制一份走样;
 *   2. 这一层不碰 DOM / 事件总线, 可以直接在 node 里跑单元测 (test/state.test.mjs);
 *   3. 导入外部 JSON 时的字段校验与"恢复默认"共用同一套规则, 不会出现两套标准。
 *
 * 仍依赖 localStorage (Web Storage), 不属于 DOM, 测试时用内存实现替换即可。
 */
const LS = 'if-term-v1';
const LS_SNAP = 'if-term-v1-snapshots';   // 配置快照栈 (环形, 最新的在末尾)
const LS_LOCK = 'if-term-v1-lock';        // 配置锁独立存放: "恢复默认"不能把锁本身也冲掉

export { LS, LS_SNAP, LS_LOCK };

/* ---------- 基础 ---------- */
export const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
const readAll = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
export const load = k => { const v = readAll()[k]; return v === undefined ? null : v; };
export const readRaw = readAll;

/* ---------- 出厂默认值: 唯一真相源 ---------- */
export const DEFAULTS = Object.freeze({
  selected: 'crypto:BTCUSDT',
  watchlist: ['crypto:BTCUSDT', 'crypto:ETHUSDT', 'idx:sh000001', 'idx:usIXIC', 'idx:usDJI', 'cn:sh600519', 'hk:00700', 'us:NVDA.OQ', 'us:AAPL.OQ', 'us:TSLA.OQ', 'fut:hf_GC', 'fut:hf_CHA50CFD', 'fx:fx_susdcny', 'fut:hf_CL'],
  alerts: [],
  layoutName: 'watch',
  customLayout: null,
  theme: 'dark',
  upRed: true,
  market: '',
});
export const PERSIST_KEYS = Object.keys(DEFAULTS);   // 持久化范围 == 恢复默认的覆盖范围
export const defaults = () => clone(DEFAULTS);

/* ---------- 重置作用域: 既能一键全恢复, 也能只回滚某一类 ---------- */
export const RESET_SCOPES = [
  { key: 'all',       label: '全部设置', keys: PERSIST_KEYS,                   desc: '自选 / 布局 / 预警 / 主题 / 配色 / 过滤 全部恢复出厂' },
  { key: 'watchlist', label: '自选列表', keys: ['watchlist', 'selected'],       desc: '恢复 14 个默认自选, 并回到 BTC' },
  { key: 'layout',    label: '布局',     keys: ['layoutName', 'customLayout'],  desc: '回到盯盘布局, 清除自定义排序与尺寸' },
  { key: 'alerts',    label: '预警',     keys: ['alerts'],                      desc: '清空全部价格预警' },
  { key: 'view',      label: '外观',     keys: ['theme', 'upRed'],              desc: '暗色主题 + 红涨绿跌' },
  { key: 'filter',    label: '市场过滤', keys: ['market', 'selected'],          desc: '清除全局市场过滤' },
];
export const scopeKeys = k => (RESET_SCOPES.find(s => s.key === k) || RESET_SCOPES[0]).keys;
export const scopeLabel = k => (RESET_SCOPES.find(s => s.key === k) || {}).label || k;

/* ---------- 配置锁 ----------
 * off   : 谁都能改 (默认)
 * soft  : 拒绝远程(Agent API / SSE 下发)写操作, 本地手动照常 —— 防"别人"乱动你的终端
 * hard  : 拒绝一切写操作(含本地), 必须先解锁 —— 防自己手滑
 */
export const LOCK_MODES = [
  { key: 'off',  label: '不锁定', desc: '本地与远程 Agent 指令都可修改设置' },
  { key: 'soft', label: '防远程', desc: '拒绝远程 Agent 指令的写操作, 本地手动操作不受影响' },
  { key: 'hard', label: '全锁定', desc: '拒绝一切写操作(含本地), 需先解锁才能修改' },
];
const VALID_LOCKS = LOCK_MODES.map(m => m.key);
export function getLock() {
  let v = null;
  try { v = localStorage.getItem(LS_LOCK); } catch {}
  return VALID_LOCKS.includes(v) ? v : 'off';
}
export function setLockRaw(mode) {
  const m = VALID_LOCKS.includes(mode) ? mode : 'off';
  try { localStorage.setItem(LS_LOCK, m); } catch {}
  return m;
}
/* 真正的"远程"= 经服务端 Agent API / SSE 下发。
 * 同源 BroadcastChannel 只在本机多窗口之间传播, 视为本地。 */
export const isRemote = from => typeof from === 'string' && /^(agent|sse|remote|http)/.test(from);
/* 写保护判定: 返回 null 表示放行, 否则返回拒绝原因 */
export function guardWrite(from = 'local') {
  const m = getLock();
  if (m === 'hard') return '配置已全锁定 (hard), 请先解锁';
  if (m === 'soft' && isRemote(from)) return `已开启「防远程」锁定, 来自 ${from} 的写操作被拒绝`;
  return null;
}

/* ---------- 字段校验: 导入外部 JSON 与恢复默认共用同一套规则 ---------- */
// 需与 grid.js 的 LAYOUTS 保持同步 (config 不能反向依赖 grid, 否则循环引用)
export const LAYOUT_NAMES = ['watch', 'research', 'tv1', 'tv2', 'mobile', 'custom'];
export const ALERT_OPS = ['>', '<', '>=', '<='];
export function validateField(k, v) {
  switch (k) {
    case 'selected':
      return typeof v === 'string' && v.includes(':') ? true : '必须是 "前缀:代码" 字符串';
    case 'watchlist':
      if (!Array.isArray(v)) return '必须是数组';
      if (v.length > 500) return '最多 500 个品种';
      if (!v.every(x => typeof x === 'string' && x.includes(':'))) return '每个元素必须是 "前缀:代码" 字符串';
      return true;
    case 'alerts':
      if (!Array.isArray(v)) return '必须是数组';
      if (v.length > 200) return '最多 200 条';
      if (!v.every(a => a && typeof a === 'object' && typeof a.sym === 'string'
        && ALERT_OPS.includes(a.op) && Number.isFinite(+a.value))) return `每条需含 sym / op(${ALERT_OPS.join(' ')}) / value(数字)`;
      return true;
    case 'layoutName':
      return typeof v === 'string' && LAYOUT_NAMES.includes(v) ? true : `只能是 ${LAYOUT_NAMES.join('/')}`;
    case 'customLayout':
      if (v == null) return true;
      if (!Array.isArray(v)) return '必须是数组或 null';
      if (v.length > 60) return '最多 60 个卡片';
      if (!v.every(c => Array.isArray(c) && typeof c[0] === 'string')) return '每个元素必须是 [type, 列数, 行数]';
      return true;
    case 'theme':
      return ['dark', 'light'].includes(v) ? true : '只能是 dark/light';
    case 'upRed':
      return typeof v === 'boolean' ? true : '必须是 true/false';
    case 'market':
      return typeof v === 'string' ? true : '必须是字符串';
    default:
      return true;
  }
}
/* 清洗一份外部状态: 只保留已知且合法的字段, 非法字段列出原因但不污染状态 */
export function sanitizeState(raw, { base = null } = {}) {
  if (!raw || typeof raw !== 'object') return { clean: {}, errors: ['不是合法的配置对象'] };
  const clean = {}, errors = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!PERSIST_KEYS.includes(k)) { errors.push(`忽略未知字段: ${k}`); continue; }
    const chk = validateField(k, v);
    if (chk !== true) { errors.push(`${k}: ${chk}`); continue; }
    clean[k] = clone(v);
  }
  // base 不为空时, 未提供的字段用 base 补齐 (合并导入)
  if (base) for (const k of PERSIST_KEYS) if (!(k in clean) && k in base) clean[k] = clone(base[k]);
  return { clean, errors };
}

/* ---------- 快照栈 ---------- */
export const SNAP_MAX = 12;
const readSnaps = () => { try { const a = JSON.parse(localStorage.getItem(LS_SNAP)); return Array.isArray(a) ? a : []; } catch { return []; } };
const writeSnaps = a => { try { localStorage.setItem(LS_SNAP, JSON.stringify(a.slice(-SNAP_MAX))); } catch {} };

export const snapshots = () => readSnaps();
/* 压栈: 状态与栈顶完全相同则不重复记录, 返回是否真的存了一份 */
export function pushSnapshot(state, label = '手动快照') {
  const a = readSnaps();
  if (a.length && JSON.stringify(a[a.length - 1].state) === JSON.stringify(state)) return false;
  a.push({ t: Date.now(), label, state: clone(state) });
  writeSnaps(a);
  return true;
}
/* 弹栈: 撤销用, 返回被弹出的快照 (空栈返回 null) */
export function popSnapshot() {
  const a = readSnaps();
  const s = a.pop();
  writeSnaps(a);
  return s || null;
}
export function takeSnapshot(i) { const a = readSnaps(); return a[i] || null; }
export function clearSnapshots() { try { localStorage.removeItem(LS_SNAP); } catch {} }
