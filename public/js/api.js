/* 数据层: REST + SSE 实时流 (+ 轮询兜底) */

export async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 响应(如门禁页)按空处理 */ }
  if (!res.ok) {
    // 带上服务端给出的原因, 例如只读模式拒绝写指令时前端要能原样提示
    const msg = body?.error || body?.message;
    throw Object.assign(new Error(path + ' -> HTTP ' + res.status + (msg ? ' · ' + msg : '')), { status: res.status, body });
  }
  return body;
}

export const getUniverse = () => api('/api/universe');
export const getNews = () => api('/api/news');
export const getHealth = () => api('/api/health');
export const getAgentSchema = () => api('/api/agent');
export const getKline = (sym, period, limit) => api(`/api/kline?sym=${encodeURIComponent(sym)}&period=${period}&limit=${limit || 300}`);
export const getQuotes = syms => api('/api/quotes?syms=' + encodeURIComponent(syms.join(',')));
export const sendAgent = (cmd, args, from) => api('/api/agent', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cmd, args, from }),
});

/* SSE 连接 — 服务端把行情数组压缩为:
   [sym, price, pct, chg, high, low, open, vol, amt, name, ts]
   与 GET /api/snapshot 的 rows 完全同构, 因此解析逻辑只有这一份。

   关于降级: SSE 是首选通道, 但它依赖"整条链路都不缓冲"。
   反向代理、CDN、某些托管平台的入口层会把长连接缓冲或直接掐断 ——
   那种情况下连 onerror 都不会触发, 页面看上去一切正常, 但行情永远静止。
   所以对 SSE 做一次"活体检测": 打开后 SSE_TIMEOUT 毫秒内没等到任何事件,
   就判定这条通道死了, 切到轮询。宁可多一次握手, 也不要给用户一张静态截图。 */
export const SSE_TIMEOUT = 6500;    // 服务端首帧 hello 是连上立刻发的, 6.5 秒足够容纳一次网络抖动
const POLL_MS = 4000;               // 轮询间隔: 与服务端广播节奏一致
const NEWS_MS = 90000;
const AGENT_MS = 5000;
const PROBE_MS = 60000;             // 降级后每隔多久试探一次 SSE 是否恢复

export function connectSSE(handlers, opts = {}) {
  const probeMs = opts.probeMs || PROBE_MS;
  let es = null, retry = 0, watchdog = 0;
  let mode = 'sse';                                   // sse | poll
  let pollQ = 0, pollNews = 0, pollAgent = 0;
  let stop = false;
  let agentSeen = 0, since = 0;
  let probeEs = null, probeTimer = 0;                 // 探测用的临时连接, 收尾时必须一并关掉
  const hidden = () => (typeof document !== 'undefined' && document.hidden);

  const say = (m) => { mode = m; handlers.onMode?.(m); };
  // 收到任何一帧就证明通道活着
  const alive = () => { clearTimeout(watchdog); watchdog = 0; handlers.onState(true); };

  /* 轮询期间定期试探 SSE —— 网关可能只是短暂抽风。
   * 单向降级(一旦降级就一辈子轮询)看着稳妥, 其实是把临时故障永久化。 */
  function probeSse() {
    if (stop || mode !== 'poll') return;
    let probe = null, timer = 0, settled = false;
    const finish = (recovered) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { probe?.close(); } catch { /* 已关闭 */ }
      if (probeEs === probe) probeEs = null;
      if (recovered) switchToSse();
    };
    try { probeEs = probe = new EventSource('/api/stream'); } catch { probeTimer = setTimeout(probeSse, probeMs); return; }
    probe.addEventListener('hello', () => finish(true));
    probe.addEventListener('q', () => finish(true));
    timer = setTimeout(() => finish(false), SSE_TIMEOUT);
    probeTimer = setTimeout(probeSse, probeMs);
  }

  function switchToSse() {
    if (stop || mode === 'sse') return;
    clearTimeout(pollQ); clearTimeout(pollNews); clearTimeout(pollAgent);
    console.info('[IF] SSE 已恢复 — 切回长连接');
    say('sse'); retry = 0; since = 0; open();
  }

  function startPoll(reason) {
    if (stop || mode === 'poll') return;
    try { es?.close(); } catch { /* 已关闭 */ }
    es = null;
    say('poll');
    console.warn(`[IF] SSE 不可用(${reason}) — 已降级为轮询 @${POLL_MS}ms`);
    handlers.onState(true);                           // 轮询照样拿得到数据, 状态栏不该显示"离线"
    const tick = async () => {
      if (stop) return;
      // 后台标签页不必再拉: 省流量, 也省服务端连接; 回到前台立刻补一次
      if (!hidden()) {
        try {
          const d = await api(`/api/snapshot?since=${since}`);
          if (stop) return;
          if (d.rows?.length) {                       // 没有变化就不打扰上层, 避免无谓重绘
            since = d.seq || since;
            handlers.onQuotes(d.rows.map(toQuote));
          }
          handlers.onState(true);
        } catch { handlers.onState(false); }
      }
      pollQ = setTimeout(tick, POLL_MS);
    };
    const tickNews = async () => {
      if (stop) return;
      try { const n = await getNews(); if (!stop && n?.length) handlers.onNews(n); } catch { /* 新闻失败不影响行情 */ }
      pollNews = setTimeout(tickNews, NEWS_MS);
    };
    const tickAgent = async () => {
      if (stop) return;
      try {
        const log = await api('/api/agent/log');
        if (!stop && Array.isArray(log)) {
          for (const e of log.slice(agentSeen)) handlers.onAgent(e);
          agentSeen = log.length;
        }
      } catch { /* 指令日志拉取失败可忽略 */ }
      pollAgent = setTimeout(tickAgent, AGENT_MS);
    };
    tick(); tickNews(); tickAgent();
    probeTimer = setTimeout(probeSse, probeMs);       // 不要认命, 定期看看 SSE 是不是恢复了
  }

  const open = () => {
    // 轮询模式不开新 SSE: 两条通道并存会重复喂数据。要切回去必须走 switchToSse(),
    // 由它统一停掉轮询定时器 —— 这是"只有一处能决定当前用哪条通道"的收口。
    if (stop || mode === 'poll') return;
    es = new EventSource('/api/stream');
    es.onopen = () => { retry = 0; alive(); };
    es.addEventListener('hello', e => { alive(); handlers.onHello(JSON.parse(e.data)); });
    es.addEventListener('q', e => { alive(); handlers.onQuotes(JSON.parse(e.data).map(toQuote)); });
    es.addEventListener('news', e => { alive(); handlers.onNews(JSON.parse(e.data)); });
    es.addEventListener('agent', e => { alive(); handlers.onAgent(JSON.parse(e.data)); });
    es.onerror = () => {
      clearTimeout(watchdog); watchdog = 0;
      handlers.onState(false);
      try { es.close(); } catch { /* 已关闭 */ }
      if (!stop) setTimeout(open, Math.min(10000, 1500 * ++retry));
      // 连续重连还看不到数据, 多半是中间层在掐, 重试是无意义的空转 —— 直接转轮询
      if (retry >= 3) startPoll('SSE 连续重连失败');
    };
    // 活体检测: 网关缓冲 SSE 时不会报错, 只会永远沉默。这时必须自救。
    clearTimeout(watchdog);
    watchdog = setTimeout(() => startPoll('超时未收到任何推送'), SSE_TIMEOUT);
  };

  say('sse');
  open();
  return () => {
    stop = true;
    clearTimeout(watchdog); clearTimeout(pollQ); clearTimeout(pollNews); clearTimeout(pollAgent);
    clearTimeout(probeTimer);
    try { es?.close(); } catch { /* 已关闭 */ }
    try { probeEs?.close(); } catch { /* 已关闭 */ }
  };
}

function toQuote(a) {
  return {
    sym: a[0], price: a[1], pct: a[2], chg: a[3], high: a[4], low: a[5],
    open: a[6], vol: a[7], amt: a[8], name: a[9], ts: a[10],
  };
}
