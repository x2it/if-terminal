#!/usr/bin/env node
/**
 * IF TERMINAL — 极简全球金融终端 · 零依赖服务端
 *
 * 职责:
 *   1. 静态资源服务 (public/)
 *   2. 聚合免费公开行情源: 腾讯(A/HK/US/K线) · 新浪(指数/期货/外汇/新闻) · 币安公共端点(加密货币)
 *      规范化为统一行情模型, 通过 SSE 增量推送
 *   3. K线/分时 代理 · 7x24 财经快讯代理
 *   4. Agent 开放 API: POST /api/agent 指令总线 (所有前端卡片可被外部 Agent 驱动)
 *
 * 运行: node server.js   (无需 npm install, Node >= 18)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const PUB = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const gbk = new TextDecoder('gbk');

/* ---------- 可选访问门禁: 设置环境变量 ACCESS_CODE=xxx 后, 访问需密令 ---------- */
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
/* ---------- 可选只读模式: IF_READ_ONLY=1 时, Agent API 只接受播报/帮助类指令 ----------
 * 这是"防止别人改乱你的终端"的服务端硬防线: 即使前端没上锁, 远程写指令也进不来。
 * 注意: 本地 UI 的顶栏按钮走浏览器内部总线, 不受本开关影响。 */
const READ_ONLY = /^(1|true|yes|on)$/i.test(String(process.env.IF_READ_ONLY || ''));
const authCookie = () => crypto.createHash('sha256').update('if-terminal:' + ACCESS_CODE).digest('hex').slice(0, 32);
/* 恒定时间比较: 避免按字符逐位试探密令 */
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const isAuthed = req => {
  if (!ACCESS_CODE) return true;
  const m = /(?:^|;\s*)if_auth=([^;]+)/.exec(req.headers.cookie || '');
  return !!m && safeEqual(m[1], authCookie());
};

/* ---------- 安全响应头 ----------
 * CSP 保留 'unsafe-inline'/'unsafe-eval': 前端大量内联样式与门禁页内联脚本,
 * 且量化回测沙箱用 new Function 执行用户自己的策略代码 (见 SECURITY.md)。
 * 其余指令仍能挡住外部脚本注入、base 标签劫持、object 嵌入与跨站 frame。 */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'";
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy': CSP,
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* ---------- 门禁爆破防护: 同 IP 10 分钟内 8 次失败 → 429 ---------- */
const AUTH_FAILS = new Map();
const AUTH_WINDOW = 10 * 60 * 1000, AUTH_MAX = 8;
const authBlocked = ip => { const r = AUTH_FAILS.get(ip); return !!r && r.n >= AUTH_MAX && Date.now() - r.ts < AUTH_WINDOW; };
const noteAuthFail = ip => {
  const r = AUTH_FAILS.get(ip);
  if (r && Date.now() - r.ts < AUTH_WINDOW) { r.n++; r.ts = Date.now(); } else AUTH_FAILS.set(ip, { n: 1, ts: Date.now() });
};
setInterval(() => { const now = Date.now(); for (const [ip, r] of AUTH_FAILS) if (now - r.ts > AUTH_WINDOW) AUTH_FAILS.delete(ip); }, AUTH_WINDOW).unref?.();
const GATE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IF TERMINAL</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#06090f;color:#d8e3f0;font-family:Consolas,'Microsoft YaHei',monospace}
.box{text-align:center;padding:40px}
b{color:#ffb02e;letter-spacing:6px;font-size:26px}
p{color:#5c7288;font-size:12px;margin:10px 0 30px;letter-spacing:3px}
input{background:#0f1826;border:1px solid #24344c;color:#d8e3f0;font-size:15px;padding:11px 16px;border-radius:4px;width:240px;outline:none;text-align:center;letter-spacing:2px}
input:focus{border-color:#ffb02e}
button{background:none;border:1px solid #ffb02e;color:#ffb02e;font-size:13px;padding:11px 20px;border-radius:4px;margin-left:10px;cursor:pointer;letter-spacing:4px}
button:hover{background:#ffb02e22}
.err{color:#ff5757;font-size:11px;height:16px;margin-top:14px}
</style></head><body><div class="box"><b>IF TERMINAL</b><p>IF 机会 · THEN 策略</p>
<form onsubmit="fetch('/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:this.c.value})}).then(r=>r.json()).then(j=>{if(j.ok)location.reload();else document.getElementById('e').textContent='密令不对'}).catch(()=>document.getElementById('e').textContent='网络异常');return false">
<input type="password" name="c" placeholder="密 令" autofocus><button>入 场</button></form>
<div class="err" id="e"></div></div></body></html>`;

/* ------------------------------------------------------------------ *
 * 品种目录 (sym 规则: 市场:代码)
 * ------------------------------------------------------------------ */
const CATALOG = [
  // A股 (腾讯代码)
  ...['sh600519 贵州茅台', 'sh601318 中国平安', 'sh600036 招商银行', 'sz300750 宁德时代',
      'sz002594 比亚迪', 'sh600900 长江电力', 'sh601398 工商银行', 'sh601939 建设银行',
      'sh601857 中国石油', 'sh601899 紫金矿业', 'sz000858 五粮液', 'sh600030 中信证券',
      'sz300059 东方财富', 'sh688981 中芯国际', 'sz000333 美的集团', 'sz002415 海康威视',
      'sh600276 恒瑞医药', 'sz000725 京东方A'].map(s => {
        const [code, name] = s.split(' ');
        return { sym: 'cn:' + code, code, name, group: 'A股', src: 'tx' };
      }),
  // 港股
  ...['hk00700 腾讯控股', 'hk09988 阿里巴巴-W', 'hk03690 美团-W', 'hk01810 小米集团-W',
      'hk00941 中国移动', 'hk00005 汇丰控股', 'hk01299 友邦保险', 'hk09618 京东集团-SW',
      'hk09999 网易-S', 'hk00388 香港交易所', 'hk02318 中国平安', 'hk00939 建设银行',
      'hk01024 快手-W', 'hk09888 百度集团-SW', 'hk00386 中国石油股份', 'hk02800 盈富基金'].map(s => {
        const [code, name] = s.split(' ');
        return { sym: 'hk:' + code.slice(2), code, name, group: '港股', src: 'tx' };
      }),
  // 美股 ETF (全球指数的标准化代理: SPY≈标普500)
  { sym: 'us:SPY', code: 'usSPY.OQ', qcode: 'usSPY', name: '标普500ETF', group: '美股', src: 'tx' },
  // 美股 (腾讯行情代码无交易所后缀, K线保留后缀)
  ...['usNVDA.OQ 英伟达', 'usAAPL.OQ 苹果', 'usMSFT.OQ 微软', 'usGOOGL.OQ 谷歌-A',
      'usAMZN.OQ 亚马逊', 'usMETA.OQ Meta', 'usTSLA.OQ 特斯拉', 'usAVGO.OQ 博通',
      'usJPM.N 摩根大通', 'usLLY.N 礼来', 'usV.N 维萨',
      'usWMT.N 沃尔玛', 'usXOM.N 埃克森美孚', 'usUNH.N 联合健康', 'usMA.N 万事达',
      'usPG.N 宝洁', 'usCOST.OQ 好市多', 'usHD.N 家得宝', 'usJNJ.N 强生',
      'usAMD.OQ 超微半导体', 'usNFLX.OQ 奈飞', 'usORCL.N 甲骨文', 'usDIS.N 迪士尼',
      'usBABA.N 阿里巴巴', 'usCOIN.OQ Coinbase', 'usMSTR.OQ 微策略', 'usPLTR.OQ Palantir']
    .map(s => {
      const [code, name] = s.split(' ');
      return { sym: 'us:' + code.slice(2), code, qcode: code.replace(/\.[A-Z]+$/, ''), name, group: '美股', src: 'tx' };
    }),
  // 伯克希尔: 腾讯行情代码为 usBRK.B(带类别后缀), 去掉后缀的 usBRK 查不到, 故显式声明
  { sym: 'us:BRK.B', code: 'usBRK.B', qcode: 'usBRK.B', name: '伯克希尔B', group: '美股', src: 'tx' },
  // 全球指数
  { sym: 'idx:usDJI', code: 'usDJI', name: '道琼斯', group: '指数', src: 'tx' },
  { sym: 'idx:usIXIC', code: 'usIXIC', name: '纳斯达克', group: '指数', src: 'tx' },
  { sym: 'idx:usINX', code: 'usINX', name: '标普500', group: '指数', src: 'tx' },
  { sym: 'idx:sh000001', code: 'sh000001', name: '上证指数', group: '指数', src: 'tx' },
  { sym: 'idx:sz399001', code: 'sz399001', name: '深证成指', group: '指数', src: 'tx' },
  { sym: 'idx:sz399006', code: 'sz399006', name: '创业板指', group: '指数', src: 'tx' },
  { sym: 'idx:sh000300', code: 'sh000300', name: '沪深300', group: '指数', src: 'tx' },
  { sym: 'idx:int_hangseng', code: 'int_hangseng', name: '恒生指数', group: '指数', src: 'sina' },
  { sym: 'idx:int_nikkei', code: 'int_nikkei', name: '日经225', group: '指数', src: 'sina' },
  { sym: 'idx:int_ftse', code: 'int_ftse', name: '富时100', group: '指数', src: 'sina' },
  /* 标普500 只保留 idx:usINX(腾讯, 全周期K线)。此前另有一条 idx:int_sp500(新浪)
   * 指向同一标的 us.INX —— 同一个东西在列表里出现两次、还叫两个名字("标普500"/"标普指数"),
   * 用户会当成两个品种, 并在两张卡片上看到不同源、不同刷新时刻的两个数字,
   * 直接违背本项目"数据一致"的承诺。宁可少一个条目, 也不制造歧义。 */
  // 外盘期货 / 商品
  ...[['hf_CHA50CFD', '富时A50期货', 1], ['hf_GC', 'COMEX黄金', 1], ['hf_SI', 'COMEX白银', 1],
      ['hf_CL', 'NYMEX原油', 1], ['hf_NG', '天然气', 1], ['hf_CAD', 'LME铜', 1]].map(([code, name]) =>
        ({ sym: 'fut:' + code, code, name, group: '期货', src: 'sina' })),
  // 外汇
  ...[['fx_susdcny', '美元/离岸·在岸人民币'], ['fx_susdcnh', '离岸人民币CNH'], ['fx_seurusd', '欧元/美元'],
      ['fx_susdjpy', '美元/日元']].map(([code, name]) =>
        ({ sym: 'fx:' + code, code, name, group: '外汇', src: 'sina' })),
];

/* ------------------------------------------------------------------ *
 * 网络工具
 * ------------------------------------------------------------------ */
async function get(url, { timeout = 9000, headers = {}, binary = false } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, ...headers },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return binary ? gbk.decode(Buffer.from(await res.arrayBuffer())) : await res.text();
  } finally { clearTimeout(timer); }
}
const touchSrc = (name, ok, ms, err) => {
  HEALTH[name] = { ok, ms, err: err ? String(err.message || err).slice(0, 90) : null, ts: Date.now() };
};

/* ------------------------------------------------------------------ *
 * 行情抓取器
 * ------------------------------------------------------------------ */
const QUOTES = new Map();          // sym -> 规范化行情
let CRYPTO_POOL = [];              // 动态加密货币池 (top 交易额)
let QSEQ = 0;                      // 行情版本号: 只在"价格真的变了"时递增, 供增量快照使用

function setQ(sym, patch) {
  const q = QUOTES.get(sym) || { sym };
  const prev = q.price;
  Object.assign(q, patch, { ts: Date.now() });
  // 首次写入 / 价格变化 → 分配一个新版本号。收盘后 A股价格恒定, 就不会产生新版本,
  // 增量快照因此能在休市时段返回几乎为零的响应, 而不是每 4 秒重发 200 个品种。
  if (patch.price == null || patch.price !== prev) q.seq = ++QSEQ;
  QUOTES.set(sym, q);
  return q;
}
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// 腾讯: A股/港股/美股/美股指数
async function fetchTencent(codes) {
  const txt = await get(`https://qt.gtimg.cn/q=${codes.join(',')}`, { binary: true, headers: { Referer: 'https://gu.qq.com/' } });
  const out = [];
  for (const m of txt.matchAll(/v_([^=]+)="([^"]*)"/g)) {
    const code = m[1], f = m[2].split('~');
    if (f.length < 30) continue;
    const price = num(f[3]), prev = num(f[4]);
    if (price == null || price <= 0) continue;
    let pct = num(f[32]); const chg = num(f[31]);
    if (pct == null && prev) pct = (price - prev) / prev * 100;
    // 腾讯 A股成交额单位为万元, 港股/美股为原生货币 — 统一归一为"元"
    const isCn = /^(sh|sz|bj)/.test(code);
    const rawAmt = num(f[37]);
    out.push({
      code,
      name: f[1], price, prev, open: num(f[5]),
      high: num(f[33]), low: num(f[34]),
      chg, pct, vol: num(f[6]),
      amt: rawAmt == null ? null : (isCn ? rawAmt * 1e4 : rawAmt),
      time: f[30] || '',
    });
  }
  return out;
}

// 新浪: 全球指数(int_) / 外盘期货(hf_) / 外汇(fx_)
async function fetchSina(codes) {
  const txt = await get(`https://hq.sinajs.cn/list=${codes.join(',')}`, {
    binary: true, headers: { Referer: 'https://finance.sina.com.cn' },
  });
  const out = [];
  for (const m of txt.matchAll(/hq_str_(\w+)="([^"]*)"/g)) {
    const code = m[1], f = m[2].split(',');
    if (!f[0]) continue;
    let q = null;
    if (code.startsWith('int_')) {                       // 名称,点位,涨跌额,涨跌幅
      const price = num(f[1]); if (price == null) continue;
      q = { name: f[0], price, chg: num(f[2]), pct: num(f[3]) };
    } else if (code.startsWith('hf_')) {                 // [0]现价 [4]高 [5]低 [7]昨结 [8]开盘 [13]名称
      const price = num(f[0]), prev = num(f[7]);
      if (price == null) continue;
      q = { name: f[13] || code, price, prev, open: num(f[8]), high: num(f[4]), low: num(f[5]),
            chg: prev ? price - prev : null, pct: prev ? (price - prev) / prev * 100 : null };
    } else if (code.startsWith('fx_')) {                 // [8]现价 [9]名称 [10]涨跌% [11]涨跌 [5]开 [6]高 [7]低
      const price = num(f[8]); if (price == null) continue;
      const pct = num(f[10]), chg = num(f[11]);
      q = { name: f[9] || code, price, pct, chg, open: num(f[5]), high: num(f[6]), low: num(f[7]) };
    }
    if (q) out.push({ code, ...q });
  }
  return out;
}

// 币安公共数据端点: 全市场 24h 行情 → top 池
async function fetchCrypto() {
  const txt = await get('https://data-api.binance.vision/api/v3/ticker/24hr', { timeout: 12000 });
  const all = JSON.parse(txt);
  const rows = all.filter(x => x.symbol.endsWith('USDT') && !/UPUSDT|DOWNUSDT|BULL|BEAR/.test(x.symbol)
    && !/^(USDC|FDUSD|TUSD|USDP|DAI|USD1|BUSD|USDD|PYUSD|EUR|AEUR|EURI|XUSD|USDE)USDT$/.test(x.symbol))
    .map(x => ({ code: x.symbol, name: x.symbol.slice(0, -4), price: +x.lastPrice,
                 pct: +x.priceChangePercent, chg: +x.priceChange,
                 high: +x.highPrice, low: +x.lowPrice,
                 vol: +x.volume, amt: +x.quoteVolume, prev: +x.prevClosePrice }))
    .filter(x => x.price > 0 && x.amt > 3e6)
    .sort((a, b) => b.amt - a.amt);
  CRYPTO_POOL = rows.slice(0, 120);
  return rows;
}

/* ------------------------------------------------------------------ *
 * K线数据清洗层
 * 上游免费接口偶发返回: 0 值样本、null 时间戳、high/low 与 open/close 矛盾。
 * 直接透传会渲染出"不可能的K线"(如 high<low), 或让不支持的周期伪装成全 0 数据。
 * 统一在此收敛: 剔除非法样本 + 修正 OHLC 关系, 清洗后为空即视为该周期不可用。
 * ------------------------------------------------------------------ */
function sanitizeBars(bars) {
  const out = [];
  for (const b of bars || []) {
    const t = Number(b.t), o = +b.o, h = +b.h, l = +b.l, c = +b.c;
    if (!Number.isFinite(t) || t <= 0) continue;                        // 时间戳缺失(如美股分时返回 null)
    if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue; // 0 / NaN 样本
    out.push({
      t,
      o,
      h: Math.max(h, o, c, l),   // 保证 high 是区间最高
      l: Math.min(l, o, c, h),   // 保证 low 是区间最低
      c,
      v: Number.isFinite(+b.v) ? +b.v : 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 数据源熔断
 * 上游免费接口在高频访问下会限流(实测腾讯 K线会返回 501)。若无节制重试,
 * 既拖慢响应, 又会加重限流。连续失败达阈值即熔断该源一段时间, 期间直接走备份源。
 * ------------------------------------------------------------------ */
const CB = new Map();
const CB_THRESHOLD = 3;
const CB_COOLDOWN_MS = 60 * 1000;
function cbOpen(key) { const s = CB.get(key); return !!(s && s.until > Date.now()); }
function cbFail(key) {
  const s = CB.get(key) || { fails: 0, until: 0 };
  if (++s.fails >= CB_THRESHOLD) { s.until = Date.now() + CB_COOLDOWN_MS; s.fails = 0; }
  CB.set(key, s);
}
function cbOk(key) { CB.delete(key); }

/* ------------------------------------------------------------------ *
 * 周期聚合: 把日线/月线按日历边界合成周/月/季/年线
 *
 * 为什么需要: 上游给不了的东西不硬编造, 但也不必让用户看不了长周期 ——
 *   腾讯/币安原生只到月线(腾讯的 year 参数实测只返回 1 根"今年至今", 无分析价值)
 *   新浪期货/外汇只有日线
 * 这两类缺口都用"从更低周期真实聚合"补上, 而不是返回假的降級数据。
 * ------------------------------------------------------------------ */
const DAY_MS = 86400000, SH = 8 * 3600000;   // 固定北京时间, 无夏令时

/* 日历口径: 同一个"日线"概念, 不同上游并不在同一个时刻换交易日。
 *   'bj'  北京时间零点换日 —— 腾讯(A股/港股/美股)、新浪(期货/外汇)都是这一套
 *   'utc' UTC 零点换日 —— 币安全部周期如此(实测: BTC 周线起点是北京时间周一 08:00)
 * 混用两种口径会让"季/年聚合"与它自己的月线原料差 8 小时, 也会让前端判断
 * "这个 tick 该贴到哪根 bar"时误判。所以口径必须显式传, 不靠猜。 */
const calOff = (align) => (align === 'utc' ? 0 : SH);

/* 某个时间戳落在哪个日历桶里, 返回该桶起点的时间戳
 * unit: 1w 周一 / 1M 月初 / 1q 季初 / 1Y 年初   align: 'bj' | 'utc' */
function bucketStart(ts, unit, align) {
  // 先把时间戳抬到该口径的日历再截断到日, day0 的 UTC 各字段 == 该口径下的年月日,
  // 后面读 y/m/dow 都靠它。真正的"当日零点"是 day0 - off —— 少了这一步,
  // 周线桶会落在当日 08:00 而不是 00:00(与上游原生周K对不上)。
  const off = calOff(align);
  const day0 = Math.floor((+ts + off) / DAY_MS) * DAY_MS;
  const d = new Date(day0);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const monthStart = mm => Date.UTC(y, mm - 1, 1) - off;
  if (unit === '1w') { const dow = (d.getUTCDay() + 6) % 7; return day0 - dow * DAY_MS - off; }  // 周一=0
  if (unit === '1M') return monthStart(m);
  if (unit === '1q') return monthStart(Math.floor((m - 1) / 3) * 3 + 1);
  if (unit === '1Y') return monthStart(1);
  return null;
}

/* 聚合一组 bar。必须是真实聚合:
 *   o = 区间内最早一根的开盘, c = 最晚一根的收盘, h/l = 区间极值, v = 成交量求和
 *   t = 该区间的日历起点(而不是简单取首根时间), 这样相邻间隔才符合周期语义、可被审计校验 */
function aggregateBars(bars, unit, align) {
  const list = Array.isArray(bars) ? bars : [];
  if (!list.length) return [];
  const g = new Map();
  for (const b of [...list].sort((a, b2) => a.t - b2.t)) {
    const t = bucketStart(b.t, unit, align);
    if (t == null) continue;
    if (!g.has(t)) g.set(t, []);
    g.get(t).push(b);
  }
  const out = [];
  for (const [t, rows] of [...g.entries()].sort((a, b2) => a[0] - b2[0])) {
    let h = -Infinity, l = Infinity, v = 0;
    for (const r of rows) {
      if (Number.isFinite(+r.h) && +r.h > h) h = +r.h;
      if (Number.isFinite(+r.l) && +r.l < l) l = +r.l;
      v += Number.isFinite(+r.v) ? +r.v : 0;
    }
    const [first, last] = [rows[0], rows[rows.length - 1]];
    out.push({ t, o: +first.o, c: +last.c, h, l, v });
  }
  return sanitizeBars(out);
}

/* ------------------------------------------------------------------ *
 * K线 (加密货币走币安; 股票/指数走腾讯 ifzq; 分时走腾讯 minute)
 * ------------------------------------------------------------------ */
const CRYPTO_TF = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w', '1M': '1M' };

/* 腾讯 K 线的代码别名
 * CATALOG 里的 code 主要服务于报价接口, 但腾讯 K 线端点对部分品种认的是另一套代码:
 *   usDJI      → us.DJI    实测: 不带小数点时只返回最新 1 根, 历史全丢
 *   usIXIC     → us.IXIC   同上
 *   usINX      → us.INX    同上
 *   int_hangseng → hkHSI   新浪系的 int_* 腾讯根本不认, 但 hkHSI 能给全周期
 * 日经(int_nikkei)/富时(int_ftse) 在当前免费源下无可用 K 线, 保持原样如实报错。 */
const TX_KLINE_ALIAS = {
  usDJI: 'us.DJI', usIXIC: 'us.IXIC', usINX: 'us.INX',
  int_hangseng: 'hkHSI',
};
/* 在所有免费源下都拿不到 K 线的品种: 实时报价正常, 但历史数据确实不存在。
 * 与其让用户看到"主源受限"(像是临时故障), 不如直接说清楚 —— 这是能力边界, 不是故障。 */
const NO_KLINE = new Set(['int_nikkei', 'int_ftse', 'usSPY.OQ']);

const PERIOD_CN = {
  min: '分时', '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟',
  '1h': '1小时', '4h': '4小时', '1d': '日线', '1w': '周线', '1M': '月线', '1q': '季线', '1Y': '年线',
};
/* K线缓存有效期 —— 按周期自身的更新速度分级, 而不是一刀切:
 * 一分钟线 15 秒就该换, 年线一天换一次都嫌快。最后一根的实时性由前端贴价保证,
 * 所以缓存不会影响"图表是否在动"。 */
const KLINE_CACHE = new Map();
const KLINE_TTL = {
  min: 15000, '1m': 15000, '5m': 30000, '15m': 60000, '30m': 60000,
  '1h': 120000, '4h': 300000, '1d': 60000, '1w': 600000, '1M': 1800000, '1q': 1800000, '1Y': 3600000,
};
/* 毫秒 -> "3 分钟" / "2 小时" / "3 天"。用于把缓存数据的年龄说清楚:
 * 上游限流时退回缓存是允许的, 但必须告诉用户这份数据有多旧, 否则就是拿旧数据冒充实时。 */
function ageCn(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}
/* 不由上游直出、而是从月线聚合而来的周期 */
const AGG_FROM_MONTH = new Set(['1q', '1Y']);
/* 期货/外汇的数据源只有日线, 长周期一律由日线聚合 */
const FUT_FX_PERIODS = new Set(['1d', '1w', '1M', '1q', '1Y']);

async function klineCrypto(sym, period, limit) {
  const symbol = sym.split(':')[1];
  // 币安不支持的周期此前会兜底成 '1d', 造成"要月线给日线"的静默降级, 这里显式拒绝。
  const interval = CRYPTO_TF[period];
  if (!interval) throw new Error(`加密不支持 ${period} 周期`);
  // 币安对 limit 有自己的脾气: 太小(实测 <5)直接返回 400, 超过 1000 会被拒绝。
  // 前端只会传 320/500, 但 Agent/手敲 URL 可能传任意值 —— 钳住, 别把 400 当成"数据不存在"。
  const n = Math.min(Math.max(Math.floor(+limit) || 300, 5), 1000);
  const txt = await get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${n}`);
  const bars = sanitizeBars(JSON.parse(txt).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })));
  return { kind: 'candle', bars };
}

// 新浪 A股/沪深指数K线 —— 腾讯K线限流时的备份源(scale: 240日 / 1200周 / 7200月)
async function klineSinaStock(code, period, limit) {
  const scale = period === '1w' ? 1200 : period === '1M' ? 7200 : 240;
  const n = Math.min(Math.max(+limit || 320, 1), 640);   // 与腾讯一致的钳制, 避免把异常参数打给上游
  const txt = await get(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=${scale}&ma=no&datalen=${n}`, { headers: { Referer: 'https://finance.sina.com.cn' } });
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr)) throw new Error('新浪K线返回异常');
  return sanitizeBars(arr.map((r) => ({
    t: +new Date(r.day + 'T00:00:00+08:00'), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0,
  })));
}

async function klineTxDay(code, period, limit) {
  // 股票/指数上游只有 日/周/月。此前 1h/4h/5m/15m 会落进 'day' 分支, 静默返回日线,
  // 前端拿到的是"合法但周期错误"的数据 —— 比报错更危险, 这里显式拒绝。
  const p = period === '1w' ? 'week' : period === '1M' ? 'month' : period === '1d' ? 'day' : null;
  if (!p) throw new Error(`股票/指数不支持 ${period} 周期(仅 1d/1w/1M/min)`);

  // 腾讯对过大的 limit 会换一种返回结构(实测 >=2400 时 data 不再是对象, data[code] 直接抛错),
  // 而且月线上限本来也就 ~301 根, 多要没意义 —— 统一钳到安全值。
  const n = Math.min(Math.max(+limit || 320, 1), 640);

  // 主源: 腾讯(熔断打开时直接跳过, 避免加重限流)
  if (!cbOpen('txkline')) {
    try {
      const txt = await get(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${p},,${''},${n},qfq`);
      const d = JSON.parse(txt).data[code];
      const arr = d.qfqday || d.qfqweek || d.qfqmonth || d[p] || [];
      const raw = Array.isArray(arr) ? arr : [];
      const bars = sanitizeBars(raw.map((r) => ({ t: +new Date(r[0] + 'T00:00:00+08:00'), o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] || 0 })));
      if (bars.length) { cbOk('txkline'); return { kind: 'candle', bars, src: 'tencent' }; }
      cbFail('txkline');
    } catch (e) { cbFail('txkline'); }
  }
  // 备份源: 新浪(仅 A股与沪深指数有对应代码)
  if (/^(sh|sz)\d/.test(code)) {
    const bars = await klineSinaStock(code, period, limit);
    if (bars.length) return { kind: 'candle', bars, src: 'sina-fallback' };
  }
  throw new Error(`K线不可用(${code} ${period}): 主源受限且无可用备份源`);
}

async function klineTxMinute(code) {
  const txt = await get(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`);
  const d = JSON.parse(txt).data[code];
  const date = d?.data?.date; const rows = d?.data?.data || [];
  // 美股/部分指数不提供分时: 上游会返回空 date 或空行, 此前会产出 t=null 的全 0 样本。
  if (!date || !rows.length) throw new Error(`该品种不支持分时数据 (${code})`);
  const dateIso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const bars = []; let pv = 0, pc = null;
  for (const r of rows) {
    const [hm, price, cvol] = r.split(' ');
    const vol = Math.max(0, +cvol - pv); pv = +cvol;
    const c = +price;
    bars.push({ t: +new Date(`${dateIso}T${hm.slice(0, 2)}:${hm.slice(2)}:00+08:00`), c, o: pc == null ? c : pc, h: Math.max(c, pc == null ? c : pc), l: Math.min(c, pc == null ? c : pc), v: vol });
    pc = c;
  }
  const clean = sanitizeBars(bars);
  if (!clean.length) throw new Error(`分时数据清洗后为空 (${code})`);
  return { kind: 'line', bars: clean };
}

/* 剥掉新浪 jsonp 外壳 var t=(...);
 * 上游偶尔不返回数据、而是回一段 `/*<script>location.href='//sina.com'*\/` 反爬壳,
 * 那时正则匹配失败, 之前的写法直接 "Cannot read properties of null" —— 用户看到的是崩溃堆栈,
 * 既不知道发生了什么也不知道该不该重试。这里如实翻译成"上游临时拒绝"。 */
function unwrapJsonp(txt, code, what) {
  const m = txt && txt.match(/\(([\s\S]*)\);\s*$/);
  if (!m) throw new Error(`${what}K线上游返回了非预期内容(${code}): 疑似被限流或反爬, 稍后会自动重试`);
  try { return JSON.parse(m[1]); } catch (e) { throw new Error(`${what}K线解析失败(${code}): ${String(e.message).slice(0, 60)}`); }
}

// 新浪外盘期货日K (hf_GC → GC)
async function klineSinaFutures(code, limit) {
  const symbol = code.replace(/^hf_/, '');
  const txt = await get(`https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${symbol}`, { headers: { Referer: 'https://finance.sina.com.cn' } });
  const arr = unwrapJsonp(txt, code, '期货');   // 注意: unwrapJsonp 内部已做过 JSON.parse, 这里不能再包一层
  const bars = arr.slice(-(limit || 300)).map(r => ({
    t: +new Date(r.date + 'T00:00:00+08:00'), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0,
  }));
  const clean = sanitizeBars(bars);
  if (!clean.length) throw new Error(`期货K线清洗后为空 (${code})`);
  return { kind: 'candle', bars: clean };
}

// 新浪外汇日K (fx_susdcnh)
async function klineSinaForex(code, limit) {
  const txt = await get(`https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20t=/NewForexService.getDayKLine?symbol=${code}`, { headers: { Referer: 'https://finance.sina.com.cn' } });
  const s = unwrapJsonp(txt, code, '外汇');
  const rows = s.split('|').filter(Boolean).slice(-(limit || 300));
  const bars = rows.map(r => {
    const [d, o, a, b, c] = r.split(',');
    return { t: +new Date(d + 'T00:00:00+08:00'), o: +o, h: Math.max(+a, +b, +o, +c), l: Math.min(+a, +b, +o, +c), c: +c, v: 0 };
  });
  const clean = sanitizeBars(bars);
  if (!clean.length) throw new Error(`外汇K线清洗后为空 (${code})`);
  return { kind: 'candle', bars: clean };
}

/* ------------------------------------------------------------------ *
 * 新闻 (新浪 7x24 财经直播)
 * ------------------------------------------------------------------ */
let NEWS = [];
async function fetchNews() {
  const txt = await get('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=30&zhibo_id=152', { timeout: 10000 });
  const list = JSON.parse(txt).result.data.feed.list || [];
  NEWS = list.map(x => ({ time: x.create_time, text: x.rich_text, id: x.id }));
  return NEWS;
}

/* ------------------------------------------------------------------ *
 * SSE 客户端管理 & 广播
 * ------------------------------------------------------------------ */
const SSE = new Set();
function ssePush(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of SSE) { try { res.write(payload); } catch { SSE.delete(res); } }
}

/* ------------------------------------------------------------------ *
 * 轮询循环
 * ------------------------------------------------------------------ */
const HEALTH = {};
function chunk(arr, n) { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; }

/* 轮询调度: 用"跑完再排下一次"而不是 setInterval。
 * setInterval 不等上一轮返回 —— 上游一旦变慢, 请求就会自我叠加, 把免费源直接打到限流
 * (我们自己的审计脚本就曾因此把腾讯K线打挂)。慢的时候只会更慢, 不会更乱。 */
const POLL_MS = 4000;
let polling = false, pollTimer = 0;
async function pollOnce() {
  if (polling) return;
  polling = true;
  const seq0 = QSEQ;                 // 本轮开始时的版本号, 用于判断是否真的有变化
  const now = Date.now();
  try {
  // --- 腾讯 (A股/港股/美股/美股指数) — 美股个股行情用 qcode (无后缀) ---
  const txList = CATALOG.filter(c => c.src === 'tx').map(c => ({ cat: c, qcode: c.qcode || c.code }));
  const byQcode = new Map(txList.map(x => [x.qcode, x.cat]));
  for (const part of chunk(txList.map(x => x.qcode), 55)) {
    try {
      const t0 = Date.now();
      const rows = await fetchTencent(part);
      touchSrc('tencent', true, Date.now() - t0);
      for (const r of rows) {
        const cat = byQcode.get(r.code);
        if (!cat) continue;
        setQ(cat.sym, r);
      }
    } catch (e) { touchSrc('tencent', false, 0, e); }
  }
  // --- 新浪 (指数/期货/外汇) ---
  const sinaCodes = CATALOG.filter(c => c.src === 'sina').map(c => c.code);
  for (const part of chunk(sinaCodes, 40)) {
    try {
      const t0 = Date.now();
      const rows = await fetchSina(part);
      touchSrc('sina', true, Date.now() - t0);
      for (const r of rows) {
        const cat = CATALOG.find(c => c.code === r.code);
        if (cat) setQ(cat.sym, r);
      }
    } catch (e) { touchSrc('sina', false, 0, e); }
  }
  // --- 加密货币 (每两轮一次, 独立节流) ---
  if (now - LAST_CRYPTO > 6000) {
    LAST_CRYPTO = now;
    try {
      const t0 = Date.now();
      const rows = await fetchCrypto();
      touchSrc('crypto', true, Date.now() - t0);
      for (const r of rows.slice(0, 130)) setQ('crypto:' + r.code, r);
    } catch (e) { touchSrc('crypto', false, 0, e); }
  }
  /* 本轮没有任何品种变化 (休市 / 无成交) 就不重发整张快照 —— 每次 20KB × 每 4 秒,
   * 对 SSE 长连接是纯浪费。连接保活由 15 秒心跳负责, 客户端不会误判成断线。 */
  if (QSEQ !== seq0) broadcast('q', [...QUOTES.values()].map(q => [q.sym, q.price, q.pct, q.chg, q.high, q.low, q.open, q.vol, q.amt, q.name, q.ts]));
  } finally {
    polling = false;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, POLL_MS);
  }
}
let LAST_CRYPTO = 0;
function startPolling() { clearTimeout(pollTimer); pollTimer = setTimeout(pollOnce, 0); }

async function pollNews() {
  try { await fetchNews(); touchSrc('news', true, 0); broadcast('news', NEWS.slice(0, 30)); }
  catch (e) { touchSrc('news', false, 0, e); }
}

/* ------------------------------------------------------------------ *
 * Agent 指令总线
 * ------------------------------------------------------------------ */
const AGENT_SCHEMA = [
  { cmd: 'select',      args: { sym: 'crypto:BTCUSDT' }, desc: '全局联动切换选中品种 (所有卡片跟随)' },
  { cmd: 'open',        args: { type: 'heatmap' }, desc: '打开卡片(15个): indices/kline/watchlist/heatmap/structure/radar/corr/movers/screener/quant/alerts/worldclock/agent/news/system' },
  { cmd: 'close',       args: { id: 'card-3' }, desc: '关闭指定卡片' },
  { cmd: 'layout',      args: { name: 'watch' }, desc: '切换布局: watch(盯盘)/research(研究)/tv1/tv2(大屏页)' },
  { cmd: 'tv',          args: { on: true }, desc: '大屏TV模式开关 (自动轮播)' },
  { cmd: 'edit',        args: { on: true }, desc: '布局编辑模式开关' },
  { cmd: 'announce',    args: { text: 'BTC 突破 100000' }, desc: '大屏横幅播报' },
  { cmd: 'say',         args: { text: '关注黄金创新高' }, desc: '语音播报 (需开启TTS)' },
  { cmd: 'tts',         args: { on: true }, desc: '语音播报开关' },
  { cmd: 'theme',       args: { name: 'light' }, desc: '主题: dark/light' },
  { cmd: 'upred',       args: { on: true }, desc: '红涨绿跌(true,中式) / 绿涨红跌(false)' },
  { cmd: 'alert.add',   args: { sym: 'crypto:BTCUSDT', op: '>', value: 100000, note: '破十万' }, desc: '添加价格预警' },
  { cmd: 'fullscreen',  args: { on: true }, desc: '请求浏览器全屏' },
  { cmd: 'reset',       args: { scope: 'all' }, desc: '恢复出厂默认: all/watchlist/layout/alerts/view/filter (前端会先存快照, 可撤销)' },
  { cmd: 'undo',        args: {}, desc: '撤销上一次配置修改' },
  { cmd: 'snapshot',    args: { label: '夜盘前' }, desc: '存一份配置快照' },
  { cmd: 'lock',        args: { mode: 'soft' }, desc: '配置锁: off(不锁)/soft(防远程)/hard(全锁定)' },
  { cmd: 'unlock',      args: {}, desc: '解除配置锁 (只读模式下也放行, 避免上锁后无法解开)' },
  { cmd: 'help',        args: {}, desc: '在前端弹出本指令说明' },
];
/* 会改动前端持久化状态的指令: 只读模式下这些一律拒, 播报/帮助/解锁 仍然放行 */
const AGENT_WRITE_CMDS = new Set(['select', 'open', 'close', 'layout', 'tv', 'edit', 'tts', 'theme',
  'upred', 'alert.add', 'fullscreen', 'reset', 'undo', 'snapshot']);
const AGENT_LOG = [];
function agentCommand(cmd, args, from) {
  const entry = { cmd, args: args || {}, from: from || 'anonymous', ts: Date.now() };
  AGENT_LOG.push(entry); if (AGENT_LOG.length > 200) AGENT_LOG.shift();
  broadcast('agent', entry);
  return entry;
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon',
               // PWA: manifest 必须用 application/manifest+json, 否则 Chrome 会忽略; 图标/字体补齐类型
               '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
               '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff' };

/* K线上游失败日志限频: 同一 symbol 5 分钟内只提示一次, 避免刷屏 */
const KLINE_WARN = new Map();
function warnKline(sym, msg) {
  const last = KLINE_WARN.get(sym) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  KLINE_WARN.set(sym, Date.now());
  console.warn(`[kline] ${sym} 数据源不可用: ${msg}`);
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw new Error('body too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'OPTIONS') { json(res, 204, {}); return; }

    // ---- 门禁 ----
    if (ACCESS_CODE && !isAuthed(req)) {
      const ip = req.socket.remoteAddress || 'unknown';
      if (p === '/auth' && req.method === 'POST') {
        if (authBlocked(ip)) {
          res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '600', ...SECURITY_HEADERS });
          res.end('{"ok":false,"error":"too many attempts"}');
          return;
        }
        const body = JSON.parse(await readBody(req) || '{}');
        if (safeEqual(body.code || '', ACCESS_CODE)) {
          AUTH_FAILS.delete(ip);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `if_auth=${authCookie()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
            ...SECURITY_HEADERS,
          });
          res.end('{"ok":true}');
        } else {
          noteAuthFail(ip);
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
          res.end('{"ok":false}');
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(GATE_HTML);
      return;
    }

    // ---- SSE 实时流 ----
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...SECURITY_HEADERS });
      ssePush(res, 'hello', { version: '1.0', sources: HEALTH, universe: CATALOG.length + CRYPTO_POOL.length, news: NEWS.slice(0, 10) });
      ssePush(res, 'q', [...QUOTES.values()].map(q => [q.sym, q.price, q.pct, q.chg, q.high, q.low, q.open, q.vol, q.amt, q.name, q.ts]));
      ssePush(res, 'news', NEWS.slice(0, 30));
      SSE.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(hb); SSE.delete(res); });
      return;
    }

    // ---- 品种目录 (含动态加密池) ----
    if (p === '/api/universe') {
      const crypto = CRYPTO_POOL.map(r => ({ sym: 'crypto:' + r.code, code: r.code, name: r.name, group: '加密货币', src: 'crypto' }));
      json(res, 200, { groups: ['A股', '港股', '美股', '加密货币', '指数', '期货', '外汇'], catalog: [...CATALOG, ...crypto] });
      return;
    }

    // ---- 即时行情快照 ----
    if (p === '/api/quotes') {
      const syms = (u.searchParams.get('syms') || '').split(',').filter(Boolean);
      const out = syms.map(s => QUOTES.get(s)).filter(Boolean);
      json(res, 200, out);
      return;
    }

    /* ---- 全市场行情快照: SSE 不可用时的兜底通道 ----
     * SSE 长连接会被反向代理/网关缓冲甚至直接掐断(实测某些部署环境下 /api/stream
     * 一个字节都收不到, 页面因此变成静态截图)。与其把这当成"环境不支持", 不如给一条
     * 等价的拉取式通道: 格式与 SSE 的 q 事件逐字节一致, 前端可以复用同一套解析。 */
    if (p === '/api/snapshot') {
      /* 增量: 前端带上次的 seq, 只回"此后价格变过的品种"。
       * 休市时段 A股/期货价格恒定, 响应趋近于空 —— 轮询兜底不该比 SSE 更费流量。
       * since=0 表示首次拉取, 返回全量。 */
      const since = +u.searchParams.get('since') || 0;
      const rows = []; let max = since;
      for (const q of QUOTES.values()) {
        const s = q.seq || 0;
        if (s <= since) continue;
        rows.push([q.sym, q.price, q.pct, q.chg, q.high, q.low, q.open, q.vol, q.amt, q.name, q.ts]);
        if (s > max) max = s;
      }
      json(res, 200, { ts: Date.now(), seq: max, full: since === 0, rows });
      return;
    }

    // ---- K线/分时 ----
    if (p === '/api/kline') {
      const sym = u.searchParams.get('sym') || '';
      const period = u.searchParams.get('period') || '1d';
      const limit = +u.searchParams.get('limit') || 300;
      /* ck / hit 必须声明在 try 之外: catch 里的缓存兜底要用 hit,
       * 写在 try 内部会因块级作用域直接 ReferenceError —— 兜底代码本身崩掉, 比没有兜底更糟。 */
      const ck = `k|${sym}|${period}|${limit}`;
      const hit = KLINE_CACHE.get(ck);
      try {
        // 命中新鲜缓存直接返回: K线历史本来就不需秒级刷新, 最后一根由前端实时贴价覆盖。
        // 更重要的是抗限流 —— 免费源扛不住频繁请求, 连续审计就能把腾讯K线打挂。
        if (hit && Date.now() - hit.ts < (KLINE_TTL[period] || 60000)) {
          json(res, 200, { ...hit.doc, cached: true, ageMs: Date.now() - hit.ts });
          return;
        }
        let data, align = 'bj';
        if (sym.startsWith('crypto:')) {
          align = 'utc';                       // 币安所有周期都以 UTC 日切分, 必须跟着它走
          if (AGG_FROM_MONTH.has(period)) {
            // 币安原生最粗到月线; 季/年由月线聚合 (实测 1M 可得 111 根 ≈ 9 年)
            const base = await klineCrypto(sym, '1M', 1000);
            data = { kind: 'candle', bars: aggregateBars(base.bars, period, align), src: 'binance+agg' };
          } else {
            // 加密货币没有"分时"独立接口, 分时 = 币安 1m 收盘连线(折线);
            // 1分钟K线 = 币安 1m 真 OHLC 柱(蜡烛)。两者数据同源但图表类型不同, 不冒充两套数据。
            const cd = await klineCrypto(sym, period === 'min' ? '1m' : period, limit);
            if (period === 'min') cd.kind = 'line';
            data = cd;
          }
        } else if (sym.startsWith('fut:') || sym.startsWith('fx:')) {
          // 新浪外盘期货/外汇只有日K —— 拉全量日线再聚合成长周期
          const isFut = sym.startsWith('fut:');
          if (!FUT_FX_PERIODS.has(period)) {
            throw new Error(`${isFut ? '期货' : '外汇'}支持 日/周/月/季/年, 不支持 ${period || '该周期'}`);
          }
          const code = sym.split(':')[1];
          const base = isFut ? await klineSinaFutures(code, 3000) : await klineSinaForex(code, 9000);
          data = period === '1d' ? base
            : { kind: 'candle', bars: aggregateBars(base.bars, period, align), src: 'sina+agg' };
        } else {
          const cat = CATALOG.find(c => c.sym === sym);
          const code = TX_KLINE_ALIAS[cat?.code] || (cat ? cat.code : sym.split(':')[1]);
          if (NO_KLINE.has(code)) throw new Error('该品种在免费数据源下没有可用的K线历史 (仅提供实时报价)');
          /* 腾讯系只有"分时"(当日每分钟收盘线)和 日/周/月。1分钟K线这种独立 OHLC 柱接口
           * 免费源不提供 —— 此前 min 和 1m 都走分时接口, 导致"分时图"和"1分钟K线"拿到
           * 完全相同的同一份数据, 用户看到两张图一模一样。这里 1m 直接如实拒绝, 前端也不再
           * 给腾讯系/指数显示"1分"按钮, 避免给用户一个注定和分时重合的入口(那是假功能)。 */
          if (period === 'min') data = await klineTxMinute(code);
          else if (period === '1m') throw new Error('该品种免费数据源仅提供分时级数据, 无独立1分钟K线 (请用"分时")');
          else if (AGG_FROM_MONTH.has(period)) {
            // 腾讯/新浪原生只到周月季中的"日/周/月", 季/年由月线聚合 (实测月线 301 根 ≈ 25 年)
            const base = await klineTxDay(code, '1M', Math.max(limit * 12, 400));
            data = { kind: 'candle', bars: aggregateBars(base.bars, period, align), src: (base.src || 'tencent') + '+agg' };
          } else data = await klineTxDay(code, period, limit);
        }
        // 二次清洗: 即便上游"成功"返回, 只要没有一条合法样本, 就必须如实报不可用,
        // 绝不能把全 0 / t=null 的伪样本当作数据交给前端。
        const cleaned = sanitizeBars(data.bars);
        if (!cleaned.length) {
          json(res, 200, { sym, period, ok: false, kind: data.kind, bars: [], error: '该品种暂不支持该周期' });
          return;
        }
        // 聚合来的周期若只剩 1 根(多半是上市太短), 画一根孤零零的"年线"没有分析价值, 如实说明
        if (String(data.src || '').includes('+agg') && cleaned.length < 2) {
          json(res, 200, {
            sym, period, ok: false, kind: data.kind, bars: [],
            error: `历史数据不足: 仅能聚合出 ${cleaned.length} 根${PERIOD_CN[period] || period}, 至少需要 2 根`,
          });
          return;
        }
        // src 暴露实际命中的数据源(主源/备份源/聚合), 便于排障与观测降级情况;
        // align 暴露这批 K 线用的是哪套日历 —— 前端判断"实时价该贴到哪根 bar"时必须与之对齐
        const doc = { sym, period, ok: true, kind: data.kind, src: data.src, align, bars: cleaned };
        KLINE_CACHE.set(ck, { ts: Date.now(), doc });
        if (KLINE_CACHE.size > 600) KLINE_CACHE.delete(KLINE_CACHE.keys().next().value);
        json(res, 200, doc);
      } catch (e) {
        /* 上游全挂时, 宁可给用户一份"带时间戳的旧数据", 也不给一片空白 ——
         * 但必须如实标注 stale 与数据年龄。这不算冒充: 冒充是拿别的周期/别的品种顶替,
         * 而这里是同一份真实历史, 只是不是最新的一帧。 */
        if (hit) {
          warnKline(sym, e.message);
          json(res, 200, { ...hit.doc, cached: true, stale: true, ageMs: Date.now() - hit.ts,
            warn: `上游暂不可用, 显示 ${ageCn(Date.now() - hit.ts)}前的数据` });
          return;
        }
        // 上游(腾讯/新浪/币安)临时失效属于"网关"问题, 不是服务端 bug:
        // 返回 200 + 空序列, 让卡片按"暂无数据"渲染, 避免整页刷 500 噪声。
        // 错误信息带上具体原因, 便于定位; 服务端日志按 symbol 限频, 保留可诊断性。
        warnKline(sym, e.message);
        json(res, 200, { sym, period, ok: false, bars: [], error: String(e.message || '数据源暂不可用') });
      }
      return;
    }

    // ---- 新闻 ----
    if (p === '/api/news') { json(res, 200, NEWS); return; }

    // ---- Agent API ----
    if (p === '/api/agent' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.cmd) { json(res, 400, { ok: false, error: 'missing cmd' }); return; }
      if (READ_ONLY && AGENT_WRITE_CMDS.has(body.cmd)) {
        json(res, 403, { ok: false, error: `只读模式 (IF_READ_ONLY=1): 指令 "${body.cmd}" 会改动配置, 已拒绝` });
        return;
      }
      const entry = agentCommand(body.cmd, body.args, body.from);
      json(res, 200, { ok: true, entry });
      return;
    }
    if (p === '/api/agent' && req.method === 'GET') {
      json(res, 200, { schema: AGENT_SCHEMA, log: AGENT_LOG.slice(-50) });
      return;
    }
    if (p === '/api/agent/log') { json(res, 200, AGENT_LOG); return; }

    // ---- 健康检查 ----
    if (p === '/api/health') {
      json(res, 200, { ok: true, uptime: process.uptime(), quotes: QUOTES.size, sources: HEALTH, clients: SSE.size,
        readOnly: READ_ONLY, gate: !!ACCESS_CODE });
      return;
    }

    // ---- 静态资源 ----
    let fp = path.join(PUB, p === '/' ? 'index.html' : decodeURIComponent(p));
    const rel = path.relative(PUB, fp);
    // 目录穿越防护: 必须真正落在 public/ 之内 (仅前缀比较会被 publicX/ 之类的兄弟目录绕过)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403, { ...SECURITY_HEADERS }); res.end(); return;
    }
    const extra = path.basename(fp) === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {};
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404, { ...SECURITY_HEADERS }); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
        ...extra,
      });
      res.end(buf);
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

/* 被 require 时不自动起服务 —— 便于单测直接引用下面的纯函数 (聚合/清洗)。
 * 直接用 `node server.js` 运行时 require.main === module, 行为不变。 */
module.exports = { aggregateBars, bucketStart, sanitizeBars, PERIOD_CN, AGG_FROM_MONTH, FUT_FX_PERIODS, TX_KLINE_ALIAS, NO_KLINE };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[IF TERMINAL] http://localhost:${PORT}  (零依赖, 数据源: 腾讯/新浪/币安公共端点)`);
    if (READ_ONLY) console.log('[IF TERMINAL] 只读模式 IF_READ_ONLY=1: Agent 写指令已全部拒绝 (仅放行 播报/帮助/解锁)');
    if (!ACCESS_CODE) console.warn('[IF TERMINAL] 未设置 ACCESS_CODE: 任何人可访问本终端, 公网部署建议设置');
    startPolling(); pollNews();
    setInterval(pollNews, 40000);
  });
}
