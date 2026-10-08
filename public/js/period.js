/* 周期桶起点计算 —— 前端侧实现
 *
 * 为什么这里有第二份 bucketStart:
 *   服务端 /api/kline 返回每根 bar 的 t, 就是它自己算出来的"桶起点"; 而前端收到 SSE 实时价后,
 *   必须能独立判断"这个 tick 该贴到最后一根 bar 上, 还是已经跨进了新的周期需要开一根新的"。
 *   做不到这一点, 图表就只能是加载那一刻的静态快照。
 *   server.js 是 CJS, 浏览器是 ESM, 同一个文件无法两边共用, 于是这里刻意保留第二份实现 ——
 *   并由 test/period.test.mjs 用上千个时间戳交叉比对两份。一旦任何一侧漂移, 测试立刻变红。
 *
 * 两条不许违反的口径:
 *   1) 分钟/小时级: 币安 klines 的 open time、腾讯分时的时间戳, 都是 UTC epoch 对齐值,
 *      直接整除即可, 绝不能掺时区。
 *   2) 日及以上: 服务端按 UTC+8 日历分桶, 且中国与全球主要市场都无夏令时, 固定偏移 8 小时。
 *      前端必须跟着同一套日历走, 否则周末/月初会出现"前端认为该开新周、服务端其实还归上一周"。
 */
export const BAR_MS = {
  min: 60e3, '1m': 60e3, '5m': 5 * 60e3, '15m': 15 * 60e3, '30m': 30 * 60e3,
  '1h': 3600e3, '4h': 4 * 3600e3,
};

/* 名义周期长度 —— 日/周/月/季/年不是等长的(月有 28~31 天), 取近似值只用于判断
 * "实时数据与手上最后一根之间, 到底是正常跨了一根, 还是中间缺了不止一根"。 */
const DAY_MS = 86400000, SH = 8 * 3600000;
export const BAR_NOMINAL_MS = {
  ...BAR_MS,
  '1d': DAY_MS, '1w': 7 * DAY_MS, '1M': 30 * DAY_MS, '1q': 91 * DAY_MS, '1Y': 365 * DAY_MS,
};

/**
 * @param {number} ts     毫秒时间戳
 * @param {string} unit   min/1m/5m/15m/30m/1h/4h/1d/1w/1M/1q/1Y
 * @param {'bj'|'utc'} align 日历口径。
 *        'bj'  北京时间零点换日 —— 腾讯(A股/港股/美股)、新浪(期货/外汇)
 *        'utc' UTC 零点换日 —— 币安(它的周线起点是北京时间周一 08:00, 不是 00:00)
 *        由服务端在 /api/kline 的 align 字段里给出; 前端必须与它一致,
 *        否则在 UTC 与北京时间交界处会误判"该开一根新的", 凭空画出半根假的 K 线。
 * @returns {number|null} 桶起点时间戳, 未知周期返回 null
 */
export function bucketStart(ts, unit, align) {
  const t = +ts;
  if (!Number.isFinite(t)) return null;
  const ms = BAR_MS[unit];
  if (ms) return Math.floor(t / ms) * ms;                    // 分钟/小时: UTC epoch 对齐
  const off = align === 'utc' ? 0 : SH;
  const day0 = Math.floor((t + off) / DAY_MS) * DAY_MS;      // UTC 日起点, 其 UTC 字段 == 该口径下的年月日
  const d = new Date(day0);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const monthStart = (mm) => Date.UTC(y, mm - 1, 1) - off;
  if (unit === '1d') return day0 - off;
  if (unit === '1w') { const dow = (d.getUTCDay() + 6) % 7; return day0 - dow * DAY_MS - off; }  // 周一为本周起点
  if (unit === '1M') return monthStart(m);
  if (unit === '1q') return monthStart(Math.floor((m - 1) / 3) * 3 + 1);
  if (unit === '1Y') return monthStart(1);
  return null;
}
