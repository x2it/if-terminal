/**
 * IF TERMINAL 冒烟测试 —— 零依赖，无需 npm install
 *   node --test test/smoke.test.mjs
 *
 * 覆盖：服务启动 / 数据契约 / 品种完整性 / K线合法性 / 周期反降级 / Agent 指令。
 * 全部走真实 HTTP，不 mock —— 目的是在部署前发现"看起来能跑但其实没数据"的问题。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
// 第二个实例开 IF_READ_ONLY=1, 用来验证"防他人改配置"的服务端硬防线
const PORT_RO = PORT + 1;
const BASE_RO = `http://127.0.0.1:${PORT_RO}`;
let child, childRO;

async function waitReady(base, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// 加密池是启动时动态拉取的, 服务起来 ≠ 数据就绪。
// 必须等 universe 同时含静态品种与加密池, 否则测的是"半初始化"状态。
async function waitUniverse(base, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const u = await (await fetch(`${base}/api/universe`)).json();
      const g = new Set((u.catalog || []).map((x) => x.group));
      if (g.has('A股') && g.has('加密货币')) return true;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  childRO = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT_RO), IF_READ_ONLY: '1' }, stdio: 'ignore',
  });
  if (!(await waitReady(BASE))) throw new Error(`服务未能在 30s 内监听 (端口 ${PORT})`);
  if (!(await waitUniverse(BASE))) throw new Error('品种目录(含加密池)未能在 60s 内就绪');
  if (!(await waitReady(BASE_RO))) throw new Error(`只读实例未能在 30s 内监听 (端口 ${PORT_RO})`);
});

after(() => { if (child) child.kill(); if (childRO) childRO.kill(); });

const j = async (u) => (await fetch(BASE + u)).json();

test('1. 健康检查返回 ok', async () => {
  const h = await j('/api/health');
  assert.equal(h.ok, true, 'health.ok 应为 true');
});

test('2. 品种目录覆盖全部市场分组', async () => {
  const u = await j('/api/universe');
  const groups = new Set(u.catalog.map((x) => x.group));
  for (const g of ['A股', '港股', '美股', '指数', '期货', '外汇', '加密货币']) {
    assert.ok(groups.has(g), `缺少分组: ${g}`);
  }
});

test('3. 品种条目字段完整', async () => {
  const u = await j('/api/universe');
  for (const it of u.catalog) {
    assert.ok(it.sym && it.code && it.name && it.group, `字段缺失: ${JSON.stringify(it)}`);
  }
});

test('4. sym 唯一（无重复品种）', async () => {
  const u = await j('/api/universe');
  const seen = new Set();
  for (const it of u.catalog) {
    assert.ok(!seen.has(it.sym), `sym 重复: ${it.sym}`);
    seen.add(it.sym);
  }
});

test('5. 报价接口不丢品种', async () => {
  const u = await j('/api/universe');
  const syms = u.catalog.map((x) => x.sym);
  const q = await j(`/api/quotes?syms=${encodeURIComponent(syms.join(','))}`);
  assert.equal(q.length, syms.length, `请求 ${syms.length} 个, 返回 ${q.length} 个`);
});

test('6. 报价数值合法', async () => {
  const q = await j('/api/quotes?syms=cn:sh600519,us:NVDA.OQ,crypto:BTCUSDT');
  for (const x of q) {
    assert.ok(Number(x.price) > 0, `${x.sym} price 非正数: ${x.price}`);
    assert.ok(Number(x.high) >= Number(x.low), `${x.sym} high<low`);
  }
});

test('6b. 增量快照: since 语义正确（SSE 降级通道靠它省流量）', async () => {
  const a = await j('/api/snapshot?since=0');
  assert.equal(a.full, true, 'since=0 必须回全量, 否则首屏拿不到数据');
  assert.ok(a.rows.length > 100, `全量快照只有 ${a.rows.length} 行, 品种没抓齐`);
  assert.ok(a.seq > 0, 'seq 应为正整数版本号');
  for (const r of a.rows) assert.equal(r.length, 11, '快照行格式必须与 SSE 一致 (11 列)');

  // 同一 since 之后只回"变过的": 立刻再取一次, 行数不应超过全量
  const b = await j(`/api/snapshot?since=${a.seq}`);
  assert.equal(b.full, false, '带 since 的请求不应再标 full');
  assert.ok(b.rows.length <= a.rows.length, '增量行数不应超过全量');
  assert.ok(b.seq >= a.seq, 'seq 必须单调不减, 否则前端会漏掉变化');
  // 价格没动的品种不该被重复下发 —— 休市时段这条能挡住"每 4 秒重发 200 个品种"
  const dup = b.rows.filter((r) => !a.rows.some((x) => x[0] === r[0]));
  assert.equal(dup.length, 0, '增量里出现了全量中没有的品种');
});

test('7. A股日K合法（OHLC 关系成立）', async () => {
  const k = await j('/api/kline?sym=cn:sh600519&period=1d&limit=10');
  assert.equal(k.ok, true, '日K应可用');
  assert.ok(k.bars.length > 0, 'bars 不应为空');
  for (const b of k.bars) {
    assert.ok([b.o, b.h, b.l, b.c].every((n) => Number.isFinite(n) && n > 0), `非法样本: ${JSON.stringify(b)}`);
    assert.ok(b.h >= Math.max(b.o, b.c) - 1e-9, `high 不是最高: ${JSON.stringify(b)}`);
    assert.ok(b.l <= Math.min(b.o, b.c) + 1e-9, `low 不是最低: ${JSON.stringify(b)}`);
    assert.ok(Number(b.t) > 0, `时间戳非法: ${b.t}`);
  }
});

test('8. 不支持的周期如实报错（不静默降级）', async () => {
  const k = await j('/api/kline?sym=cn:sh600519&period=1h&limit=5');
  assert.equal(k.ok, false, '股票不应支持 1h, 必须返回 ok:false');
  assert.equal(k.bars.length, 0, '不得返回日线冒充小时线');
});

test('9. 加密K线支持多周期且无全 0 样本', async () => {
  for (const p of ['1h', '1d']) {
    const k = await j(`/api/kline?sym=crypto:BTCUSDT&period=${p}&limit=5`);
    assert.equal(k.ok, true, `${p} 应可用`);
    for (const b of k.bars) {
      assert.ok(b.c > 0 && b.t > 0, `${p} 出现全 0 样本: ${JSON.stringify(b)}`);
    }
  }
});

test('10. Agent 指令总线可用', async () => {
  const s = await j('/api/agent');
  assert.ok(Array.isArray(s.schema) && s.schema.length > 0, '应返回指令 schema');
  const r = await fetch(`${BASE}/api/agent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'select', args: { sym: 'crypto:BTCUSDT' }, from: 'smoke-test' }),
  });
  assert.ok(r.status < 400, `指令执行失败: HTTP ${r.status}`);
});

test('11. Agent schema 覆盖配置恢复与配置锁指令', async () => {
  const s = await j('/api/agent');
  const cmds = new Set(s.schema.map((x) => x.cmd));
  for (const c of ['reset', 'undo', 'snapshot', 'lock']) {
    assert.ok(cmds.has(c), `schema 缺少指令: ${c}`);
  }
});

test('12. 健康检查暴露只读/门禁状态', async () => {
  const h = await j('/api/health');
  assert.equal(h.readOnly, false, '默认实例不应是只读');
  assert.equal(typeof h.gate, 'boolean', '应暴露是否开启访问门禁');
});

test('13. 只读模式: 远程写指令被拒, 播报仍然放行', async () => {
  const post = (cmd, args = {}) => fetch(`${BASE_RO}/api/agent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args, from: 'smoke-test' }),
  });
  for (const cmd of ['select', 'reset', 'layout', 'alert.add', 'theme', 'undo']) {
    const r = await post(cmd, { sym: 'crypto:ETHUSDT', scope: 'all' });
    assert.equal(r.status, 403, `只读模式下 ${cmd} 必须被拒`);
    assert.match((await r.json()).error, /只读模式/, `${cmd} 拒绝原因应说明是只读模式`);
  }
  // 播报不改动任何持久化状态, 只读模式下必须仍然可用
  const ok = await post('announce', { text: '只读模式冒烟测试' });
  assert.equal(ok.status, 200, '播报必须仍然可用');
});
