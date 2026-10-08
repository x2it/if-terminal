/**
 * 实时通道: SSE 不可用时的轮询降级
 *   node --test test/stream.test.mjs
 *
 * 背景: SSE 长连接依赖"整条链路都不缓冲"。反向代理、CDN 或托管平台的入口层可能直接掐断
 * (实测某部署环境下 /api/stream 一个字节都收不到, 而且连 onerror 都不触发)。
 * 那种情况下页面看着一切正常, 行情却永远是加载那一刻的静态快照 —— 这正是最难自查的一类故障。
 * 所以 connectSSE 自带活体检测 + 轮询兜底, 这里把它钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SMILES = () => ({
  modes: [], states: [], hello: 0, quotes: [], news: 0, agent: 0,
});

/* 一个可完全控制的 EventSource 替身: 只有被代码显式唤醒时才回调, 否则永远沉默 */
function fakeGlobal({ silentEs = true, esFails = false } = {}) {
  const made = [];
  class FakeES {
    constructor(url) {
      this.url = url; this.listeners = new Map(); this.closed = false;
      made.push(this);
      if (esFails) setTimeout(() => this.emit('error'), 5);
    }
    addEventListener(t, fn) { (this.listeners.get(t) || this.listeners.set(t, []).get(t)).push(fn); return this; }
    emit(t, ev = { data: '{}' }) { if (!this.closed) for (const fn of this.listeners.get(t) || []) fn(ev); }
    close() { this.closed = true; }
  }
  globalThis.EventSource = FakeES;
  const h = SMILES();
  const rows = [[['crypto:BTCUSDT', 86190, 0.12, 100, 87000, 85000, 86000, 1, 2, 'BTC', Date.now()]]];
  const news = [{ id: 1, text: 'x' }];
  const agent = [{ cmd: 'theme', args: { name: 'dark' }, from: 'agent:t', ts: 1 }];
  globalThis.fetch = async (path) => {
    const body =
      path.includes('/api/snapshot') ? { ts: Date.now(), rows: rows[0] } :
      path.includes('/api/news') ? news :
      path.includes('/api/agent/log') ? agent : {};
    return { ok: true, status: 200, json: async () => body };
  };
  return {
    made, handlers: {
      onState: (ok) => h.states.push(ok),
      onMode: (m) => h.modes.push(m),
      onHello: () => h.hello++,
      onQuotes: (l) => h.quotes.push(l),
      onNews: () => h.news++,
      onAgent: () => h.agent++,
    },
    log: h,
    silent: silentEs,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('SSE 沉默不报错时, 自动降级为轮询并继续拿到行情', async () => {
  const g = fakeGlobal();
  const { connectSSE, SSE_TIMEOUT } = await import('../public/js/api.js');
  const stop = connectSSE(g.handlers);

  assert.equal(g.made.length, 1, '应尝试建立 SSE 连接');
  assert.equal(g.log.modes[0], 'sse');

  const before = g.log.quotes.length;
  await sleep(SSE_TIMEOUT + 400);            // 网关把 SSE 掐住: 不报错、也不给数据

  assert.equal(g.log.modes.at(-1), 'poll', '超时后必须切到轮询, 否则行情永久静止');
  assert.ok(g.log.quotes.length > before, '降级后必须真的把行情数据交付给上层');
  assert.ok(g.log.states.at(-1) === true, '轮询拿得到数据, 不应被标成离线');
  assert.ok(g.made[0].closed, '降級后应关掉那条死掉的 SSE, 不要留着占资源');
  stop();
});

test('降级后不会再重复开 SSE', async () => {
  const g = fakeGlobal();
  const { connectSSE, SSE_TIMEOUT } = await import('../public/js/api.js');
  const stop = connectSSE(g.handlers);
  await sleep(SSE_TIMEOUT + 900);
  const n = g.made.length;
  await sleep(400);
  assert.equal(g.made.length, n, '切到轮询后不应再新建 EventSource');
  stop();
});

test('SSE 连续失败时提前转轮询, 不无限重连', async () => {
  const g = fakeGlobal({ esFails: true });
  const { connectSSE } = await import('../public/js/api.js');
  const stop = connectSSE(g.handlers);
  await sleep(15000);                       // 重连退避累计 1.5+3+4.5s, 第 3 次触发降级
  assert.equal(g.log.modes.at(-1), 'poll', '反复重连仍无数据时应停止空转');
  stop();
});

test('SSE 恢复后能自动切回去, 不把临时故障永久化', async () => {
  const g = fakeGlobal();
  const { connectSSE, SSE_TIMEOUT } = await import('../public/js/api.js');
  // 探测间隔压到 1s, 否则要等 60 秒 —— 这个用例的价值就在"降级不是单向的"
  const stop = connectSSE(g.handlers, { probeMs: 1000 });
  await sleep(SSE_TIMEOUT + 300);
  assert.equal(g.log.modes.at(-1), 'poll');

  // 模拟网关恢复: 让"之后新建的 EventSource"能收到推送
  let n = 0;
  const OrigES = globalThis.EventSource;
  globalThis.EventSource = class extends OrigES {
    constructor(url) {
      super(url);
      if (++n > 1) setTimeout(() => this.emit('q', { data: JSON.stringify([['crypto:BTCUSDT', 1, 0, 0, 1, 1, 1, 1, 1, 'BTC', Date.now()]]) }), 20);
    }
  };
  await sleep(3000);
  assert.equal(g.log.modes.at(-1), 'sse', '探测到 SSE 已恢复时必须切回长连接');
  globalThis.EventSource = OrigES;
  stop();
});

test('轮询走增量: 没有变化就不打扰上层', async () => {
  const g = fakeGlobal();
  const { connectSSE, SSE_TIMEOUT } = await import('../public/js/api.js');
  const paths = [];
  const rawFetch = globalThis.fetch;
  globalThis.fetch = async (p, o) => { paths.push(String(p)); return rawFetch(p, o); };
  const stop = connectSSE(g.handlers);
  await sleep(SSE_TIMEOUT + 900);
  const snaps = paths.filter((p) => p.includes('/api/snapshot'));
  assert.ok(snaps.length >= 1, '应发起快照请求');
  assert.ok(snaps.some((p) => p.includes('since=')), '快照请求必须带 since, 否则每次都全量重发 200 个品种');
  stop();
});

test('轮询模式的数据格式与 SSE 一致 (上层无需区分来源)', async () => {
  const g = fakeGlobal();
  const { connectSSE, SSE_TIMEOUT } = await import('../public/js/api.js');
  const stop = connectSSE(g.handlers);
  await sleep(SSE_TIMEOUT + 400);
  const q = g.log.quotes.at(-1)[0];
  assert.deepEqual(Object.keys(q).sort(),
    ['amt', 'chg', 'high', 'low', 'name', 'open', 'pct', 'price', 'sym', 'ts', 'vol'].sort());
  assert.equal(q.sym, 'crypto:BTCUSDT');
  assert.equal(q.price, 86190);
  stop();
});

test('stop() 之后不再有任何后台请求', async () => {
  const g = fakeGlobal();
  const { connectSSE, SSE_TIMEOUT } = await import('../public/js/api.js');
  const stop = connectSSE(g.handlers);
  await sleep(SSE_TIMEOUT + 600);
  stop();
  const n = g.log.quotes.length;
  await sleep(POLL_WAIT);
  assert.equal(g.log.quotes.length, n, '卸载后必须停干净, 否则卡片销毁后会继续写内存');
});

const POLL_WAIT = 4500;
