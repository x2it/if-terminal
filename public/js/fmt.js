/* 数字/颜色/时间格式化 — 中式红涨绿跌默认 */

export const F = {
  num(v, d) {
    if (v == null || !isFinite(v)) return '--';
    const av = Math.abs(v);
    if (d == null) d = av >= 10000 ? 2 : av >= 100 ? 2 : av >= 1 ? 2 : av >= 0.01 ? 4 : 6;
    return v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  price(v) { return F.num(v); },
  pct(v) { return v == null || !isFinite(v) ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; },
  chg(v) { return v == null || !isFinite(v) ? '--' : (v > 0 ? '+' : '') + F.num(v); },
  // 大额: 万/亿/万亿
  big(v) {
    if (v == null || !isFinite(v)) return '--';
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
    if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return F.num(v);
  },
  cls(v) { return v == null || !isFinite(v) ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; },
  /* 毫秒 -> 完整短语: "刚刚" / "3 秒前" / "5 分钟前" / "2 小时前" / "3 天前"。
   * 返回完整短语而不是量词, 是为了让调用方不必各自拼"前"字 —— 那样拼出来的是"刚刚前"。
   * 用途只有一个: 把数据年龄写在脸上。上游限流时会退回缓存, 那份数据是真的但不是最新一帧,
   * 不标注年龄就等于拿旧数据冒充实时。 */
  ago(ms) {
    if (ms == null || !isFinite(ms)) return '';
    const s = Math.round(Math.max(0, ms) / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  },
};

/* 涨跌幅 -> 颜色 (考虑红涨/绿涨配置)
 * 端点色必须与全局涨跌色 (#ff5757 / #1fc98e) 完全一致 —— 此前这里用的是另一套
 * #ff4040 / #00c98e, 同一张页面上 K 线和热力图是两种红绿, 属于配色失控。
 * 曲线加 gamma 0.75: 小涨幅也能读出颜色倾向, 大涨幅不会一上来就糊满屏纯色。
 * 底色/端点必须跟随主题: 深色端点画在浅色卡片上就是一坨坨黑块 (实测踩过)。 */
export function heatColor(pct, upRed = true) {
  const light = typeof document !== 'undefined' && document.body.classList.contains('theme-light');
  const BASE = light ? '#e9edf2' : '#1e2937';
  const UP = light ? ['#f4e2e2', '#d93838'] : ['#2b2124', '#ff5757'];
  const DN = light ? ['#dff0ea', '#0f9c6d'] : ['#1b2d33', '#1fc98e'];
  if (pct == null || !isFinite(pct)) return BASE;
  const raw = Math.max(-5, Math.min(5, pct)) / 5;
  const x = Math.sign(raw) * Math.pow(Math.abs(raw), 0.75);
  const [lo, hi] = upRed ? (x > 0 ? UP : DN) : (x > 0 ? DN : UP);
  return x > 0 ? blend(lo, hi, x) : blend(lo, hi, -x);
}
function blend(a, b, t) {
  const pa = hex(a), pb = hex(b);
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
}
function hex(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
