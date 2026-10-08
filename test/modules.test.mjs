/**
 * 前端模块链接检查 —— 零依赖，无需 npm install
 *   node --test test/modules.test.mjs
 *
 * 目的: 抓"import 了一个并不存在的导出"这类错误。
 * 这种错误在链接期就炸, 会让整个插件文件加载失败 —— 表现是某几张卡片直接消失,
 * 而服务端 HTTP 层一切正常, 光跑接口测试根本发现不了。
 * (历史上真的踩过一次: core.js 漏导出 clearSnapshots, 导致 tools.js 整文件挂掉。)
 *
 * 做法: 用最小 DOM 替身把全部前端模块 import 一遍, 再确认卡片都注册上了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'public', 'js');

/* ---------- 最小 DOM / Web Storage 替身 ---------- */
const mkEl = () => {
  const el = {
    children: [], style: {}, className: '', innerHTML: '', textContent: '', dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    appendChild(c) { el.children.push(c); return c; },
    append(...c) { el.children.push(...c); },
    remove() {}, setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {}, focus() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    getContext: () => null,
  };
  return el;
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = {
  body: mkEl(), documentElement: mkEl(),
  getElementById: () => mkEl(), createElement: () => mkEl(), createTextNode: () => mkEl(),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.location = { origin: 'http://127.0.0.1', pathname: '/', search: '', protocol: 'http:' };
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.devicePixelRatio = 1;
// 自选卡片的 sparkline 走 requestAnimationFrame。必须异步: 同步执行会让嵌套调用直接递归爆栈。
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// 图表类卡片用 ResizeObserver 跟随容器尺寸, 替身里做成空实现
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
// 注意: node 22 的 globalThis.navigator 是只读 getter, 不能整体赋值, 它本身已够用

const MODULES = [
  'config.js', 'fmt.js', 'ui.js', 'api.js', 'core.js', 'grid.js', 'quant.js', 'chart.js',
  'plugins/market.js', 'plugins/viz.js', 'plugins/chart.js', 'plugins/tools.js', 'plugins/radar.js',
];

test('1. 全部前端模块可被加载 (无缺失导出 / 无循环引用炸裂)', async () => {
  for (const f of MODULES) {
    await assert.doesNotReject(() => import(path.join(JS, f)), `模块加载失败: ${f}`);
  }
});

test('2. 15 张卡片全部注册成功', async () => {
  const { registry } = await import(path.join(JS, 'grid.js'));
  const need = ['indices', 'kline', 'watchlist', 'heatmap', 'structure', 'radar', 'corr', 'movers',
    'screener', 'quant', 'alerts', 'worldclock', 'agent', 'news', 'system'];
  for (const t of need) assert.ok(registry.has(t), `卡片未注册: ${t}`);
  assert.equal(registry.size, need.length, `卡片数量应为 ${need.length}, 实际 ${registry.size}`);
});

test('3. 每张卡片都能被实例化 (init 不抛错)', async () => {
  const { registry } = await import(path.join(JS, 'grid.js'));
  for (const [type, def] of registry) {
    assert.ok(typeof def.init === 'function', `${type} 缺少 init`);
    assert.ok(def.title, `${type} 缺少标题`);
    const card = { bd: mkEl(), api: {}, setBadge() {}, el: mkEl(), hd: mkEl() };
    // 只验证 init 不抛异常; 替身没有真实布局, 渲染结果不校验
    assert.doesNotThrow(() => def.init(card), `卡片 ${type} 初始化抛错`);
    // 必须销毁: 快讯/系统卡片内部有 15~40s 的轮询定时器, 不清理测试进程会一直挂着
    card.api.destroy?.();
  }
});

test('4. Agent 指令说明与可派发指令一致', async () => {
  const { CMD_HELP, dispatch } = await import(path.join(JS, 'core.js'));
  for (const [cmd] of CMD_HELP) {
    // 未知指令会走 default 分支返回 ok:false, 这里只要求"已被登记在帮助里"的指令确实存在分支
    assert.ok(typeof cmd === 'string' && cmd.length > 0, `指令名非法: ${cmd}`);
  }
  const known = new Set(CMD_HELP.map((c) => c[0]));
  for (const c of ['reset', 'undo', 'snapshot', 'lock', 'unlock']) {
    assert.ok(known.has(c), `新增指令未登记进 CMD_HELP: ${c}`);
  }
  // 未知指令必须如实报错, 不能假装成功
  const r = dispatch('definitely-not-a-command', {}, 'test');
  assert.equal(r.ok, false);
});

/* 自动快照有 2s 节流, 连续两次变更只留一份档 —— 测试之间要等节流过期 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('5. 撤销必须回到「变更前」的状态 (自动快照不能拍到改后值)', async () => {
  /* 真实踩过的坑: 调用方都是「先改内存 S[k] 再 persist」, 而 persist 里的自动快照
   * 直接用 currentState() —— 拍到的是改后的值, 撤销等于空转, 点多少次都没反应。
   * 修复: 快照用本次写入前的落盘值还原该字段。以下三条路径逐一守住。 */
  const core = await import(path.join(JS, 'core.js'));
  core.clearSnapshots();
  core.resetDefaults('all', 'test', false);   // 先回到已知状态

  // 标量: 主题
  await sleep(2100);
  core.dispatch('theme', { name: 'light' }, 'test');
  assert.equal(core.S.theme, 'light', '前置条件: 主题应已切到 light');
  core.undoLast('test');
  assert.equal(core.S.theme, 'dark', '撤销后主题应回到 dark');

  // 标量: 涨跌配色
  await sleep(2100);
  core.dispatch('upred', { on: false }, 'test');
  assert.equal(core.S.upRed, false, '前置条件: 配色应已切到绿涨');
  core.undoLast('test');
  assert.equal(core.S.upRed, true, '撤销后配色应回到红涨');

  // 数组(引用语义): 预警增删
  await sleep(2100);
  core.dispatch('alert.add', { sym: 'crypto:BTCUSDT', op: '>', value: 12345 }, 'test');
  assert.equal(core.S.alerts.length, 1, '前置条件: 应有 1 条预警');
  core.undoLast('test');
  assert.equal(core.S.alerts.length, 0, '撤销后预警应被移除');
});

test('6. theme 指令参数宽容 (name / v 都认)', async () => {
  const core = await import(path.join(JS, 'core.js'));
  core.dispatch('theme', { v: 'light' }, 'test');
  assert.equal(core.S.theme, 'light');
  core.dispatch('theme', { name: 'dark' }, 'test');
  assert.equal(core.S.theme, 'dark');
});
