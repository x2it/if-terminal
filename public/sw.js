/* IF TERMINAL · Service Worker
 *
 * 缓存策略 (行情终端的三条硬约束):
 *  1. /api/* 与 /auth —— 一律直连, 绝不拦截/缓存。行情快照、K线、7×24 快讯要求实时,
 *     /api/stream 更是 SSE 长连接, 任何缓存或缓冲都会让推送断流。
 *  2. 页面导航 —— 网络优先。设了 ACCESS_CODE 时首屏是"入场"门禁页, 它与真外壳同为
 *     200 + text/html, 因此只在响应体含 id="grid" (真外壳标记) 时才写入缓存, 门禁页永不落盘。
 *  3. 壳资源 (html/css/js/图标/manifest) —— 网络优先 + 回写缓存: 在线时改代码刷新即生效,
 *     断网时用缓存兜底, 从而"可安装 + 可离线打开外壳"(行情本身仍需网络)。
 */
const CACHE = 'if-terminal-v1';
const SHELL_KEY = '/';
const ASSET_RE = /\.(?:css|js|png|svg|ico|webmanifest|woff2?)$/i;

/* 断网且从未缓存过任何外壳时的兜底页 */
const OFFLINE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>IF TERMINAL · 离线</title><style>
:root{color-scheme:dark}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#06090f;color:#8fa3b8;font:13px/1.7 ui-monospace,Menlo,Consolas,monospace}
.b{max-width:420px;padding:24px;text-align:center}
h1{margin:0 0 6px;font-size:15px;letter-spacing:2px;color:#ffb02e}
p{margin:6px 0}
kbd{border:1px solid #1b2836;border-radius:3px;padding:1px 5px;color:#cfe0f0}
</style></head><body><div class="b">
<h1>IF TERMINAL</h1>
<p>当前处于离线状态, 且尚未缓存终端外壳。</p>
<p>请连接网络后打开一次 <kbd>/</kbd>, 此后即可离线启动外壳 (行情数据仍需联网)。</p>
</div></body></html>`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                                   // 外部行情源/第三方: 直连
  if (url.pathname.startsWith('/api/') || url.pathname === '/auth') return;          // API / SSE / 门禁: 直连

  if (req.mode === 'navigate') { event.respondWith(networkFirst(req, true)); return; }
  if (ASSET_RE.test(url.pathname)) event.respondWith(networkFirst(req, false));
});

async function networkFirst(req, isNav) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && !res.headers.get('set-cookie')) {
      if (isNav) {
        // 门禁页也是 200 text/html —— 只认真外壳的标记
        const body = await res.clone().text();
        if (body.includes('id="grid"')) await cache.put(SHELL_KEY, res.clone());
      } else if (!/text\/html/i.test(res.headers.get('content-type') || '')) {
        await cache.put(req, res.clone());
      }
    }
    return res;
  } catch (err) {
    const hit = isNav
      ? (await cache.match(req)) || (await cache.match(SHELL_KEY))
      : await cache.match(req);
    if (hit) return hit;
    if (isNav) {
      return new Response(OFFLINE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    throw err;
  }
}
