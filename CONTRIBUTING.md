# 贡献指南

欢迎 Issue 与 PR。请先读这篇，能省掉来回沟通。

## 一条铁律：保持零依赖

项目刻意做到 **0 npm 依赖、0 构建步骤**：只用 Node 内置模块 + 原生 Web API。
判断标准很简单——**能靠内置能力解决的，就不引入依赖**。

- 需要 HTTP？用内置 `fetch`（Node 18+）。
- 需要图表？用 Canvas / SVG 手绘，不引图表库。
- 需要日期处理？用 `Date` 与 `toLocaleString`，不引 dayjs。

新增依赖的 PR 大概率会被拒绝，除非有充分理由。

## 新增一张卡片

卡片是插件化的，一个 `registerCard({ type, title, init })` 调用即是一张卡片：

```js
registerCard({
  type: 'mycard',        // 唯一类型名, 同时是 Agent `open` 指令的参数
  title: '我的卡片',
  badge: '数据源',
  init(card) {
    card.body.append(/* 你的 DOM */);
    const off = bus.on('select', render);   // 订阅全局事件, 跟随选中品种联动
    card.api.destroy = () => off();         // 必须提供销毁钩子
  },
});
```

加完后请同步更新三处，保持"实现 / 文档 / Agent"一致：

1. `server.js` 里 `open` 指令的 `desc`（列出全部卡片类型）
2. `README.md` 的「卡片插件」章节
3. `AGENT-API.md` 的指令表

> 历史教训：某版本漏登记了 `radar` 与 `structure`，导致 Agent 使用者根本发现不了这两张卡片。

## 新增数据源

1. 优先选**免费、无需 API Key** 的公开接口。
2. 在函数内完成拉取 + 解析，并**统一过一遍 `sanitizeBars()`**：它会剔除 0/NaN/时间戳非法的样本，并修正 `high/low` 与 `open/close` 矛盾。
3. **不要静默降级**：不支持的周期必须抛错，绝不能返回另一种周期的数据冒充（例如要 1h 却给日线）。
4. **控制并发**：批量拉 K 线时请分批（参考 `plugins/radar.js` 的 `SCAN_CONC = 6`）。一次并发几十个请求会把上游打到限流。
5. **失败要退避**：任何"数据没拿到就再试一次"的自动重试都必须带上最小间隔，否则数据源故障时客户端会自重扫成死循环（历史上真的发生过）。
6. 在 `README.md` 的「数据源」表格登记来源。

## 改默认值 / 加配置项

出厂默认值**只写在 `public/js/config.js` 的 `DEFAULTS`**，不要在别处再复制一份。
需要扩字段时三处一起动：

1. `config.js` 的 `DEFAULTS`
2. `config.js` 的 `validateField()` —— 导入外部 JSON 时的字段校验，缺了它脏数据就能写进状态
3. `config.js` 的 `RESET_SCOPES` —— 决定该项属于哪个「恢复默认」作用域

`config.js` 是**纯逻辑层**（只依赖 `localStorage`，不碰 DOM），这样它才能被 `test/state.test.mjs` 直接单测。
与 UI/事件总线相关的接线放在 `core.js`。

> `public/js/package.json` 只写了一句 `{"type": "module"}`，作用是让 node 能把前端 ES module 直接 import 进单测。浏览器不读它。

### 写入顺序：先留档，再改内存

「撤销」能生效的前提是**快照拍到的是变更前的状态**。这里踩过一次坑：

调用方的自然写法是「先改内存，再落盘」——

```js
S.theme = name;        // ① 内存已经变成新值
persist('theme', name); // ② 这里的自动快照读 currentState()，拍到的是新值
```

结果快照存的就是改后的值，用户点「撤销」等于什么都没发生，而且**界面上看不出任何异常**（提示还显示"已撤销 xxx"）。

`persist()` 现在的做法是：留档时用本次写入前的**落盘值**把该字段还原回去。所以新增写入点时不必刻意调整顺序，但**不要绕过 `persist()` 直接改 `localStorage`**，也不要在 `persist` 之外自己实现快照。

数组字段同理：`S.alerts.push(...)` 改的是同一引用，落盘旧值才是变更前的内容。

`test/modules.test.mjs` 的用例 5 守着 theme / upRed / alerts 三条路径，改动这块前先跑 `npm test`。

## 测试

```bash
npm test                                           # 63 项: 冒烟 + 配置层 + 模块链接 + 聚合 + 周期口径 + 实时通道
BASE=http://localhost:8787 node tools/audit.mjs     # 全品种 × 全周期系统级审计
```

五个测试文件各管一段：

| 文件 | 管什么 |
|---|---|
| `test/smoke.test.mjs` | HTTP 层: 服务启动 / 数据契约 / K线合法性 / 反静默降级 / 只读模式 |
| `test/state.test.mjs` | 配置层: 默认值 / 快照 / 撤销 / 恢复默认 / 导入校验 / 配置锁 |
| `test/modules.test.mjs` | 前端模块能否被加载、15 张卡片能否实例化 |
| `test/aggregate.test.mjs` | 聚合引擎纯函数: 日历边界 / OHLC 口径 / 脏样本 |
| `test/period.test.mjs` | 前端与服务端**两份**桶计算的交叉验证 + UTC/北京时间双口径 |
| `test/stream.test.mjs` | SSE 活体检测与轮询降级: 沉默超时必须切通道, 降级后不再开 SSE |

`modules.test.mjs` 存在的理由是抓一类特殊错误：**`import` 了一个并不存在的导出**
（例如 core.js 漏导出 `clearSnapshots`）。它在链接期就炸，会让整个插件文件加载失败 ——
表现是某几张卡片凭空消失，而服务端 HTTP 一切正常，光跑接口测试永远发现不了。

提交前请确认：

- `npm test` 全绿；
- 若改动了数据层，跑一次 `tools/audit.mjs` 确认无 `ohlc` / `downgrade` 类失败。

## 改代码前先打快照

```bash
sh tools/snapshot.sh "我要改 X"    # 打快照
sh tools/restore.sh                # 列出
sh tools/restore.sh 1              # 回滚 (1 = 最新)
```

回滚前会自动再存一份「回滚前」快照，所以回滚错了也能反悔。

## 提交信息

用简洁的中文或英文均可，建议格式：`模块: 做了什么`，例如 `kline: 修复周线时间戳`。
