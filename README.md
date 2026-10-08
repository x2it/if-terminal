# IF TERMINAL · 极简全球金融终端

> **If 机会 · Then 策略** —— 盒子 · 卡片 · 插件 · Agent 开放 · 大屏/多屏/移动端 · 零成本

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![build](https://img.shields.io/badge/build-none-lightgrey.svg)
![pwa](https://img.shields.io/badge/PWA-installable-success.svg)

一个**单文件服务端 + 纯前端**的极简金融终端：全球盯盘 · 热力图 · 市场联动 · 智能信号雷达 · 量化回测，
全部能力收敛为一条可被外部 Agent 驱动的指令总线。

**零 npm 依赖、零构建步骤、零 API Key。** 克隆下来 `node server.js` 就能跑。

![桌面端](docs/screenshots/terminal-desktop.png)
<p align="center"><img src="docs/screenshots/terminal-mobile.png" width="320" alt="移动端"></p>

## 为什么是它

| | |
|---|---|
| **零依赖** | 只用 Node 内置模块 + 原生 Web API，没有 `node_modules`，没有打包器，不用 `npm install` |
| **零成本** | 全部数据来自免费公开接口，不需要注册、不需要 API Key |
| **零构建** | 改前端刷新即生效；静态资源每次请求读盘 |
| **可被 Agent 驱动** | 一条 HTTP 指令即可切换品种、开卡片、上大屏播报、挂预警，所有窗口同步响应 |
| **多屏同源** | 主终端 / TV 大屏 / 移动端 / 任意卡片弹窗，通过 BroadcastChannel + SSE 实时联动 |
| **可安装** | 标准 PWA：可加到桌面/手机主屏、离线打开外壳 |

## 快速开始

```bash
git clone https://github.com/x2it/if-terminal.git          # 或直接取 server.js + public/ 即可运行(零依赖)
cd if-terminal
node server.js                    # → http://localhost:8787
```

首次运行建议顺便验证环境：

```bash
npm test                                           # 63 项测试 (冒烟/配置层/模块链接/聚合/周期口径/实时通道), 不需要 npm install
BASE=http://localhost:8787 node tools/audit.mjs     # 全品种 × 全周期系统级审计
```

> 注意：加密货币池在启动时动态拉取，**服务监听成功 ≠ 数据已就绪**。
> 首次打开若品种不全，等待数十秒刷新即可；自动化脚本应先轮询 `/api/universe` 确认含「加密货币」分组。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `ACCESS_CODE` | 空 | 设置后所有页面/API 需密令（首页为「入场」门，认证 Cookie HttpOnly 7 天）。**留空 = 完全公开** |
| `CORS_ORIGIN` | `*` | Agent API 的 CORS 允许来源，接入自有系统时建议收紧 |
| `IF_READ_ONLY` | 空 | 设为 `1` 后 Agent API 只接受播报/帮助/解锁，一切会改配置的远程指令返回 403（服务端级写保护） |

```bash
PORT=80 ACCESS_CODE=你的密令 node server.js
```

> ⚠️ 未设置 `ACCESS_CODE` 时，`/api/agent` 对任何能访问该端口的人开放。公网部署请**同时**设置密令并启用 HTTPS，详见 [SECURITY.md](SECURITY.md)。

## 部署

**pm2（推荐）**

```bash
npm i -g pm2
pm2 start server.js --name if-terminal --env ACCESS_CODE=你的密令
pm2 save && pm2 startup
```

**systemd**

```ini
[Unit]
Description=IF TERMINAL
After=network.target

[Service]
WorkingDirectory=/opt/if-terminal
Environment=PORT=8787
Environment=ACCESS_CODE=你的密令
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

**Docker**

```bash
docker compose up -d            # 或: docker build -t if-terminal:1.0.0 . && docker run -p 8787:8787 if-terminal:1.0.0
```

**反向代理（SSE 必须关闭缓冲）**

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;        # 否则 /api/stream 实时推送会被缓冲
}
```

## 安装为 App（PWA）

- **桌面 Chrome / Edge**：地址栏右侧的安装图标，或顶栏出现的「安装」按钮
- **Android Chrome**：菜单 → 添加到主屏幕
- **iOS Safari**：分享 → 添加到主屏幕（iOS 无 `beforeinstallprompt`，也不显示安装按钮）

安装后以独立窗口运行（无地址栏），并注册 Service Worker 缓存**外壳**（HTML/CSS/JS/图标）。
行情、K线与 SSE 流始终直连，不走缓存 —— 因此离线只能打开界面骨架，数据仍需要网络。

> 浏览器只在 **HTTPS 或 localhost** 下允许安装与注册 Service Worker。

## Agent API

任何本地脚本、LLM 工具调用或自动化系统都可以驱动终端：

```bash
BASE=http://localhost:8787

curl $BASE/api/agent                                  # 指令 schema + 执行日志
curl -X POST $BASE/api/agent -H 'Content-Type: application/json' \
     -d '{"cmd":"select","args":{"sym":"crypto:ETHUSDT"},"from":"my-agent"}'
curl -X POST $BASE/api/agent -H 'Content-Type: application/json' \
     -d '{"cmd":"announce","args":{"text":"ETH 1h 级别放量突破"}}'
```

指令经 SSE 广播到**所有**已打开的窗口（主终端、TV 大屏、弹窗小屏、移动端），语义等同手动操作。
完整指令表与数据接口见 [AGENT-API.md](AGENT-API.md)。

## 卡片插件（15 个）

`indices` 全球指数带 · `kline` 蜡烛图（MA/MACD/RSI/分时/触控/十字光标全局同步） · `watchlist` 跨市场自选 ·
`heatmap` 热力图（组内归一 treemap） · `structure` 市场结构（大盘广度→板块强弱→品种下钻） ·
`radar` 信号雷达（背离/异常波动σ/放量/排列/RSI极值/板块共振/Risk-ON-OFF） · `corr` 相关性矩阵 ·
`movers` 涨跌榜 · `screener` 全市场选股 · `quant` 策略回测（夏普/回撤/胜率/盈亏比） ·
`alerts` 价格预警（toast+语音+横幅） · `worldclock` 全球开休市 · `agent` 指令控制台 · `news` 7×24快讯 ·
`system` 数据源健康

新增一个卡片 = 一个 `registerCard({ type, title, init })` 调用，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 数据源（真实可查证）

| 市场 | 主源 | 备份源 | 说明 |
|---|---|---|---|
| A股 / 港股 / 美股实时 | 腾讯 `qt.gtimg.cn` | — | 实时快照，4s 轮询；A股成交额已归一为「元」 |
| A股 / 沪深指数 K线 | 腾讯 `ifzq.gtimg.cn` | 新浪 `money.finance.sina.com.cn` | 日/周/月（前复权）；主源限流时自动切换备份源 |
| 港股 / 美股 K线 | 腾讯 `ifzq.gtimg.cn` | — | 无备份源，主源受限时**如实报不可用**，不伪造数据 |
| 分时 | 腾讯 `ifzq.gtimg.cn` | — | 仅 A股 / 港股 / 沪深指数 / 恒生指数提供；美股不提供 |
| 全球指数实时 | 新浪 `hq.sinajs.cn` | 腾讯 | 恒指/日经/富时/A50/黄金/白银/原油/天然气/铜/CNH |
| 外盘期货 / 外汇日K线 | 新浪 `stock2.finance.sina.com.cn` | — | 上游只有日线，周/月/季/年由服务端聚合 |
| 加密货币 | 币安公共端点 `data-api.binance.vision` | — | Top 120 USDT 交易对（已剔除稳定币/杠杆代币） |
| 7×24 快讯 | 新浪财经直播 | — | 40s 刷新 |

> **关于「用 ETF 代理指数」**：早期确实拿不到境外指数的 K 线，只能拿 SPY 当标普500 的替身。现在已经不需要了 —— 腾讯对美股指数要用带小数点的代码（`us.DJI` / `us.IXIC` / `us.INX`），写成不带点的 `usDJI` 它只肯给最新 1 根，历史全丢；换成正确写法后三大美股指数和恒生指数（`hkHSI`）都拿到了完整历史，标普500 更是直接有 54 根年线。
>
> 仍然拿不到的会**如实报不可用**：日经225、富时100 在免费源下没有 K 线历史（实时报价正常），SPY 的日线也只有 1 根。宁可明说没有，也不给一根孤零零的假K线。

### 周期支持矩阵（实测）

不同上游能给的粒度不同，**请求不支持的周期会返回 `ok:false`，不会用别的周期冒充**：

| 类别 | 支持周期 |
|---|---|
| A股 / 港股 | `1d` `1w` `1M` `1q` `1Y` `min`(分时) |
| 沪深指数 | `1d` `1w` `1M` `1q` `1Y` `min`(沪深/恒生提供) |
| 美股 / 美股指数 | `1d` `1w` `1M` `1q` `1Y` |
| 期货 / 外汇 | `1d` `1w` `1M` `1q` `1Y` |
| 加密货币 | `1m` `5m` `15m` `1h` `4h` `1d` `1w` `1M` `1q` `1Y` `min` |

#### 周/月/季/年从哪来

上游给不了的长周期，由服务端**按日历边界真实聚合**，而不是返回降级的替代数据：

| 缺口 | 做法 | 可得历史（实测） |
|---|---|---|
| 股票/指数的季线、年线 | 由腾讯/新浪**月线**聚合（腾讯只有 day/week/month，其 `year` 参数实测仅返回 1 根"今年至今"，不可用） | 上证年线 37 根（1990→2026） |
| 期货/外汇的周月季年 | 上游只有日线，拉全量日线后聚合 | 黄金年线 11 根；外汇年线 33 根（1994→2026） |
| 加密货币的季线、年线 | 币安原生最粗到月线，再按月聚合 | BTC 年线 10 根（2017→2026） |

聚合口径是严格且可被验证的：`o`=区间首根开盘、`c`=末根收盘、`h/l`=区间极值、`v`=求和、`t`=该周期的日历起点（周一/月初/季初/年初），全程按 UTC+8 日历分桶，避免跨时区把 1 月 1 日算进上一年。

**两种日历口径，不混用**：腾讯/新浪按北京时间零点换日，币安按 UTC 零点换日（实测 BTC 周线起点是北京时间周一 08:00）。服务端聚合与前端"实时价该贴到哪根 bar"的判断都显式带 `align` 字段（`bj`/`utc`），由 `test/period.test.mjs` 用上千个时间戳交叉锁定两份实现 —— 任何一侧漂移，测试立刻红。

历史太短导致聚合后不足 2 根时，返回 `ok:false` 并说明原因 —— 一根孤零零的"年线"没有分析价值，宁可不画。

> 美股与美股指数的长周期依赖腾讯月线，而该上限流较频繁；拿不到时会如实报错，不会退回短周期冒充。

### 实时通道：SSE 优先，轮询兜底

行情实时性靠 SSE 长连接，但 SSE 依赖"整条链路都不缓冲"——反向代理、CDN、部分托管平台的入口层会把流**缓冲或直接掐断**，且不报任何错：页面看起来一切正常，行情却永远停留在加载那一刻的静态快照。

所以前端对 SSE 做活体检测：连接建立后 `SSE_TIMEOUT`(6.5s) 内收不到任何一帧，就判定通道死亡，自动降级为轮询（`/api/snapshot`，数据格式与 SSE 逐字节一致）；连续 3 次重连失败也走同样降级。降级后顶栏连接指示点变为**琥珀色**，鼠标悬停可见"实时通道： 轮询降级"——数据照常更新，但通道变化必须让用户看得见。

### 数据质量保障

- 所有 K 线统一经过 `sanitizeBars()`：剔除 0/NaN/时间戳非法样本，并修正 `high`/`low` 与 `open`/`close` 矛盾的脏数据。
- 上游连续失败会触发**熔断**（60s 冷却），期间直接走备份源，避免高频重试加重限流。
- 响应中的 `src` 字段标明本次实际命中的数据源（`tencent` / `sina-fallback`），降级可观测。
- 系统级审计：`BASE=http://localhost:8787 node tools/audit.mjs`，覆盖报价一致性、K线合法性、**周期真实性（反静默降级）**、跨接口交叉验证。

## 恢复默认与配置锁

终端是给大家一起看的 —— 但**配置不该被别人随手改掉**，自己改错了也得能马上回来。这件事分三层做：

| 层 | 手段 | 挡什么 |
|---|---|---|
| **撤销（事后）** | 每次设置变更前自动留存快照（节流 2s，最多 12 份），`Ctrl+Shift+Z` 一键回到上一步 | 自己手滑 |
| **恢复默认（兜底）** | 顶栏「系统」卡片 / `Ctrl+K` 搜「恢复默认」，可整体或只回滚「自选 / 布局 / 预警 / 外观 / 过滤」某一类 | 改得乱七八糟时一键归零 |
| **配置锁（事前）** | 顶栏 🔒 按钮三档循环：`不锁定` → `防远程` → `全锁定` | 别人（含远程 Agent 指令）乱动 |

`防远程` 只拦来自 Agent API / SSE 的写指令，本地手动照常；`全锁定` 连本地一起拦。
锁状态单独存放，**「恢复默认」不会把锁解掉**；`unlock` 指令与播报永远可用，不会把自己锁死。

配合服务端的 `IF_READ_ONLY=1`，即使别人绕过前端直接 POST 指令，也会被 403 拒掉。

配置还能整体导出成 JSON 备份 / 跨设备迁移，导入时逐字段校验，脏数据跳过并列出原因，不会污染状态。

## 代码快照与回滚

改代码之前打一份快照，改崩了一条命令回滚（回滚本身也会留档，所以能反悔）：

```bash
sh tools/snapshot.sh "加自选锁之前"    # 打快照
sh tools/restore.sh                    # 列出所有快照
sh tools/restore.sh 1                  # 回滚 (1 = 最新)
```

## 快捷键

| 键 | 功能 | 键 | 功能 |
|---|---|---|---|
| `Ctrl+K` | 命令面板（可搜「恢复默认」/「撤销」/「配置锁」） | `1-7` | 市场过滤（加密/A股/美股/港股/期货/外汇/指数） |
| `Ctrl+Shift+Z` | 撤销上一次配置修改 | `/` | 搜索 |
| `↑ ↓` | 自选上下切换 | `E` | 编辑布局 |
| `T` | 大屏TV轮播 | `F` | 全屏 |
| `R` | 刷新数据 | `Esc` | 退出当前模式 |
| `?` | 帮助层 | | |

## 项目结构

```
server.js                  零依赖服务端: 静态服务 + 行情聚合 + SSE 推送 + Agent 总线 + 只读/门禁
public/index.html          页面骨架 (PWA 元信息在这里)
public/manifest.webmanifest / public/sw.js     PWA 清单与 Service Worker
public/js/config.js        配置层(纯逻辑): 出厂默认值 · 重置作用域 · 字段校验 · 快照栈 · 配置锁
public/js/core.js          状态 · 事件总线 · 指令总线 · 市场过滤 · 多窗口联动 · 预警引擎
public/js/grid.js          盒子网格: 布局预设 / 拖拽 / 弹出 / 插件注册表
public/js/chart.js         K线图引擎        public/js/quant.js  指标库 + 回测
public/js/plugins/*        market(盯盘) viz(热力图/相关性) chart tools radar
test/smoke.test.mjs        冒烟测试: 服务 / 数据契约 / K线合法性 / 反降级 / 只读模式
test/state.test.mjs        配置层单测: 默认值 / 快照 / 撤销 / 导入校验 / 配置锁
test/modules.test.mjs      模块链接检查: 抓"import 了不存在的导出"这类加载期错误
test/aggregate.test.mjs    聚合引擎纯函数: 日历边界 / OHLC 口径 / 脏样本
test/period.test.mjs       前端与服务端两份桶计算的交叉验证 + UTC/北京时间双口径
test/stream.test.mjs       实时通道: SSE 沉默必须降级, 降级后能自愈切回, 轮询走增量
tools/audit.mjs            系统级审计 (需先启动服务): 全品种 × 全周期 × 交叉验证
tools/gen-icons.py         重新生成 PWA 图标
tools/snapshot.sh          代码快照       tools/restore.sh  从快照回滚
```

## 安全

按**单用户自托管工具**设计，请勿直接当作多租户服务。要点：密令是共享口令而非账号系统；未设密令时
Agent API 完全开放；量化回测沙箱用 `new Function` 执行你输入的策略代码（只在你的浏览器里跑）。
完整威胁模型与已实现的防护见 [SECURITY.md](SECURITY.md)。

## 参与贡献

欢迎 Issue 与 PR —— 但请先读 [CONTRIBUTING.md](CONTRIBUTING.md)：**本项目刻意保持零依赖**，
能靠内置能力解决的方案优先。安全问题请走私密渠道，不要开公开 Issue。

## 免责声明

行情来自第三方免费公开接口，存在延迟、限流与中断的可能，**仅供学习研究，不构成任何投资建议**。
据此操作，风险自负。

## 许可证

[MIT](LICENSE) © 2026 知行工作室

<sub>[English](README.en.md)</sub>
