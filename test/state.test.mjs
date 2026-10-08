/**
 * 配置层单测 —— 默认值 / 快照栈 / 撤销 / 恢复默认 / 导入校验 / 配置锁
 *   node --test test/state.test.mjs
 *
 * config.js 是纯逻辑层(只依赖 localStorage, 不碰 DOM), 用内存实现替换后即可在 node 里直接测;
 * core.js 与之对接的部分(恢复默认会同时改内存与存储、锁会拦写) 用最小 DOM 替身一并覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---------- 最小 Web Storage / DOM 替身 (必须在 import 被测模块之前装好) ---------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const mkEl = () => {
  const el = {
    children: [], style: {}, className: '', innerHTML: '', textContent: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    appendChild(c) { el.children.push(c); return c; },
    append(...c) { el.children.push(...c); },
    remove() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
  return el;
};
globalThis.document = {
  body: mkEl(),
  getElementById: () => mkEl(),
  createElement: () => mkEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, documentElement: mkEl(),
};
globalThis.window = {};   // 不含 BroadcastChannel → core.js 的 BC 为 null, 跳过跨窗口广播

const C = await import('../public/js/config.js');
const Core = await import('../public/js/core.js');
const { S, resetDefaults, undoLast, importState, exportState, setLock, getLock, snapshots, snapshot, persist, currentState } = Core;

/* 每个用例前把配置恢复到出厂状态, 避免用例之间互相污染 */
function fresh() {
  store.clear();
  setLock('off');
  Object.assign(S, C.defaults());
  S.quotes = {}; S.tickHist = {};
}

/* ---------------- 1. 出厂默认值 ---------------- */
test('1. 出厂默认值结构完整且自洽', () => {
  assert.deepEqual(Object.keys(C.DEFAULTS).sort(),
    ['alerts', 'customLayout', 'layoutName', 'market', 'selected', 'theme', 'upRed', 'watchlist']);
  assert.equal(C.PERSIST_KEYS.length, 8);
  assert.equal(C.DEFAULTS.watchlist.length, 14, '默认自选应为 14 只');
  assert.equal(C.DEFAULTS.theme, 'dark');
  assert.equal(C.DEFAULTS.upRed, true, '中式配色默认红涨');
  assert.equal(C.DEFAULTS.layoutName, 'watch');
  // 默认自选必须都是合法的 "前缀:代码" 形式, 否则选股器/报价会取不到
  for (const s of C.DEFAULTS.watchlist) assert.match(s, /^[a-z]+:.+/, `默认自选格式非法: ${s}`);
  // 默认值不可被就地改写 (防止某处顺手改一下就把"默认"改没了)
  const d = C.defaults();
  d.watchlist.push('crypto:XXXUSDT');
  assert.equal(C.DEFAULTS.watchlist.length, 14, 'defaults() 必须返回深拷贝');
});

test('2. 重置作用域覆盖全部持久化字段, 且互不越界', () => {
  assert.deepEqual(C.scopeKeys('all').slice().sort(), C.PERSIST_KEYS.slice().sort());
  assert.deepEqual(C.scopeKeys('watchlist'), ['watchlist', 'selected']);
  assert.deepEqual(C.scopeKeys('layout'), ['layoutName', 'customLayout']);
  assert.deepEqual(C.scopeKeys('alerts'), ['alerts']);
  for (const s of C.RESET_SCOPES) {
    for (const k of s.keys) assert.ok(C.PERSIST_KEYS.includes(k), `作用域 ${s.key} 含非法字段 ${k}`);
  }
});

/* ---------------- 2. 配置锁 ---------------- */
test('3. 配置锁: 默认不锁, soft 只拦远程, hard 全拦', () => {
  fresh();
  assert.equal(getLock(), 'off');
  assert.equal(C.guardWrite('local'), null);
  assert.equal(C.guardWrite('agent:someone'), null);

  setLock('soft');
  assert.equal(getLock(), 'soft');
  assert.equal(C.guardWrite('local'), null, 'soft 不应拦本地手动操作');
  assert.equal(C.guardWrite('bc'), null, '同源多窗口视为本地');
  assert.match(C.guardWrite('agent:someone'), /防远程/, 'soft 必须拦远程 Agent');
  assert.match(C.guardWrite('sse'), /防远程/);

  setLock('hard');
  assert.match(C.guardWrite('local'), /全锁定/);
  assert.match(C.guardWrite('agent:someone'), /全锁定/);
});

test('4. 配置锁: 非法值回落 off, 且不被"恢复默认"冲掉', () => {
  fresh();
  C.setLockRaw('nonsense');
  assert.equal(getLock(), 'off', '未知锁值必须回落 off, 否则会误锁死');
  setLock('hard');
  resetDefaults('all');
  assert.equal(getLock(), 'hard', '恢复默认不应解除配置锁 (锁独立存放)');
  fresh();
});

test('5. hard 锁下 persist 被拒且不落盘', () => {
  fresh();
  setLock('hard');
  const before = localStorage.getItem('if-term-v1');
  assert.equal(persist('theme', 'light'), false, 'hard 锁下 persist 必须返回 false');
  assert.equal(localStorage.getItem('if-term-v1'), before, '不得写入存储');
  fresh();
});

test('6. hard 锁下 dispatch 写指令被拒, 播报与解锁仍然可用', () => {
  fresh();
  setLock('hard');
  const sel = Core.dispatch('select', { sym: 'crypto:ETHUSDT' }, 'agent:someone');
  assert.equal(sel.ok, false);
  assert.equal(sel.blocked, true);
  assert.equal(S.selected, 'crypto:BTCUSDT', '选中品种不应被改动');

  const rst = Core.dispatch('reset', { scope: 'all' }, 'agent:someone');
  assert.equal(rst.ok, false, '远程不能恢复默认(会清掉别人的自选)');

  // 播报不改动任何持久化状态, 上锁后必须仍然可用
  assert.equal(Core.dispatch('announce', { text: '测试播报' }, 'agent:someone').ok, true);
  assert.equal(Core.dispatch('unlock', {}, 'local').ok, true);
  assert.equal(getLock(), 'off', 'unlock 必须始终可用, 否则会把自己锁死');
  fresh();
});

/* ---------------- 3. 恢复默认 / 撤销 ---------------- */
test('7. 恢复默认: 内存与 localStorage 同时回到出厂值', () => {
  fresh();
  S.watchlist = ['crypto:SOLUSDT'];
  S.alerts = [{ sym: 'crypto:BTCUSDT', op: '>', value: 1 }];
  S.theme = 'light'; S.upRed = false; S.layoutName = 'research';
  persist('watchlist', S.watchlist); persist('theme', S.theme);

  const r = resetDefaults('all');
  assert.equal(r.ok, true);
  assert.deepEqual(S.watchlist, C.DEFAULTS.watchlist, '内存应恢复默认自选');
  assert.equal(S.theme, 'dark');
  assert.equal(S.upRed, true);
  assert.equal(S.layoutName, 'watch');
  assert.equal(S.alerts.length, 0);
  const saved = JSON.parse(localStorage.getItem('if-term-v1'));
  assert.deepEqual(saved.watchlist, C.DEFAULTS.watchlist, '存储也应恢复默认');
  assert.equal(saved.theme, 'dark');
  fresh();
});

test('8. 恢复默认前自动留档, undoLast 能原样撤回', () => {
  fresh();
  S.watchlist = ['crypto:SOLUSDT', 'crypto:BNBUSDT'];
  persist('watchlist', S.watchlist);
  snapshot('改动前');                       // 模拟自动快照
  const mine = S.watchlist.slice();

  resetDefaults('all');
  assert.notDeepEqual(S.watchlist, mine, '恢复默认后自选应已变');

  const u = undoLast();
  assert.equal(u.ok, true);
  assert.deepEqual(S.watchlist, mine, '撤销后必须拿回自己的自选');
  fresh();
});

test('9. 只恢复单个作用域, 不动其他设置', () => {
  fresh();
  S.watchlist = ['crypto:SOLUSDT'];
  S.theme = 'light';
  persist('watchlist', S.watchlist); persist('theme', S.theme);

  resetDefaults('layout');                  // 只重置布局
  assert.equal(S.theme, 'light', '外观不应被动');
  assert.deepEqual(S.watchlist, ['crypto:SOLUSDT'], '自选不应被动');

  resetDefaults('alerts');
  assert.equal(S.alerts.length, 0);
  fresh();
});

test('10. 空栈时撤销返回失败而不是崩溃', () => {
  fresh();
  const r = undoLast();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no snapshot');
  fresh();
});

/* ---------------- 4. 快照栈 ---------------- */
test('11. 快照栈: 去重 + 上限 12 份 + 弹栈顺序', () => {
  fresh();
  const st = { ...C.defaults(), market: 'A股' };
  assert.equal(C.pushSnapshot(st, '第一份'), true);
  assert.equal(C.pushSnapshot({ ...st }, '重复状态'), false, '状态相同不应重复记录');
  assert.equal(snapshots().length, 1);

  for (let i = 0; i < 30; i++) C.pushSnapshot({ ...C.defaults(), market: 'M' + i }, '批量 ' + i);
  assert.equal(snapshots().length, C.SNAP_MAX, `快照上限应为 ${C.SNAP_MAX}`);
  assert.equal(snapshots()[snapshots().length - 1].label, '批量 29', '应保留最新的');

  const last = C.popSnapshot();
  assert.equal(last.label, '批量 29', '弹栈应取最新的一份');
  assert.equal(snapshots().length, C.SNAP_MAX - 1);
  fresh();
});

test('12. 快照保存的是深拷贝, 之后改状态不会篡改历史', () => {
  fresh();
  const wl = ['crypto:SOLUSDT'];
  S.watchlist = wl;
  snapshot('留档');
  wl.push('crypto:XXXUSDT');                // 改原数组
  S.watchlist.push('crypto:YYYUSDT');
  const snap = snapshots().at(-1);
  assert.deepEqual(snap.state.watchlist, ['crypto:SOLUSDT'], '快照必须是当时的独立副本');
  fresh();
});

/* ---------------- 5. 导入导出 ---------------- */
test('13. 字段校验: 非法值全部被拒, 合法值放行', () => {
  assert.notEqual(C.validateField('theme', 'blue'), true);
  assert.notEqual(C.validateField('upRed', 'yes'), true);
  assert.notEqual(C.validateField('watchlist', 'BTC'), true);
  assert.notEqual(C.validateField('watchlist', ['BTC']), true, '缺前缀的品种必须被拒');
  assert.notEqual(C.validateField('selected', 'BTC'), true);
  assert.notEqual(C.validateField('layoutName', 'nope'), true);
  assert.notEqual(C.validateField('alerts', [{ sym: 'x', op: '!=', value: 1 }]), true);
  assert.notEqual(C.validateField('alerts', [{ sym: 'x', op: '>', value: 'abc' }]), true);
  assert.equal(C.validateField('theme', 'light'), true);
  assert.equal(C.validateField('upRed', false), true);
  assert.equal(C.validateField('watchlist', ['crypto:BTCUSDT']), true);
  assert.equal(C.validateField('customLayout', null), true);
  assert.equal(C.validateField('alerts', [{ sym: 'crypto:BTCUSDT', op: '>', value: 100 }]), true);
});

test('14. 导入: 非法字段跳过且不污染状态, 合法字段生效', () => {
  fresh();
  const r = importState({
    state: {
      theme: 'cyan',                        // 非法
      watchlist: ['crypto:SOLUSDT'],        // 合法
      bogusField: 123,                      // 未知
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.imported, ['watchlist'], '只有合法字段被导入');
  assert.ok(r.errors.some(e => e.includes('theme')), 'theme 的错误必须被列出');
  assert.ok(r.errors.some(e => e.includes('bogusField')));
  assert.deepEqual(S.watchlist, ['crypto:SOLUSDT']);
  assert.equal(S.theme, 'dark', '非法 theme 不得写入');
  fresh();
});

test('15. 导入: 合并模式只覆盖提供的字段', () => {
  fresh();
  S.theme = 'light';
  persist('theme', 'light');
  importState({ state: { watchlist: ['crypto:SOLUSDT'] } }, { merge: true });
  assert.deepEqual(S.watchlist, ['crypto:SOLUSDT'], '提供的字段应生效');
  assert.equal(S.theme, 'light', '未提供字段应保持现状');

  importState({ state: { watchlist: ['crypto:ETHUSDT'] } });   // 非合并
  assert.equal(S.theme, 'dark', '非合并导入时缺失字段回到默认');
  fresh();
});

test('16. 导出配置可原样导回 (往返一致)', () => {
  fresh();
  S.watchlist = ['crypto:SOLUSDT', 'crypto:ETHUSDT'];
  S.alerts = [{ sym: 'crypto:BTCUSDT', op: '>', value: 99000, t: Date.now() }];
  S.market = '加密货币';
  const dump = JSON.parse(JSON.stringify(exportState()));
  assert.equal(dump._app, 'if-terminal');
  assert.equal(dump.state.watchlist.length, 2);

  resetDefaults('all');
  assert.equal(S.watchlist.length, 14, '先恢复默认');
  const back = importState(dump);
  assert.equal(back.ok, true);
  assert.deepEqual(S.watchlist, ['crypto:SOLUSDT', 'crypto:ETHUSDT'], '导回后应完全一致');
  assert.equal(S.market, '加密货币');
  assert.equal(S.alerts.length, 1);
  fresh();
});

test('17. 导入垃圾数据不崩溃', () => {
  fresh();
  for (const bad of [null, undefined, 42, 'str', [], { state: null }]) {
    const r = importState(bad);
    assert.equal(r.ok, false, `导入 ${JSON.stringify(bad)} 应被拒`);
  }
  assert.deepEqual(S.watchlist, C.DEFAULTS.watchlist, '状态应保持不变');
});

/* ---------------- 6. 一致性 ---------------- */
test('18. currentState 与持久化内容一致', () => {
  fresh();
  S.watchlist = ['crypto:SOLUSDT'];
  persist('watchlist', S.watchlist);
  const st = currentState();
  const saved = JSON.parse(localStorage.getItem('if-term-v1'));
  for (const k of C.PERSIST_KEYS) {
    if (k in saved) assert.deepEqual(st[k], saved[k], `字段 ${k} 内存与存储不一致`);
  }
  fresh();
});
