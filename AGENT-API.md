# IF TERMINAL · Agent API

终端把全部能力收敛为一条**指令总线**，任何 Agent（本地脚本、LLM 工具调用、自动化系统）都可以驱动它。

> 部署到自有域名（如 `https://your-domain.com/`）并开启 `ACCESS_CODE` 门禁时，Agent 需先换取会话 Cookie：
> `curl -c jar.txt -X POST https://your-domain.com/auth -d '{"code":"你的密令"}'`，之后所有请求带 `-b jar.txt`。

## 发现

```
GET /api/agent
→ { schema: [{cmd, args, desc}...], log: [...] }
```

## 执行指令

```
POST /api/agent
Content-Type: application/json

{"cmd": "select", "args": {"sym": "crypto:BTCUSDT"}, "from": "my-agent"}
```

- `from` 可选，用于在前端 Agent 控制台显示来源。
- 指令通过 SSE `agent` 事件广播到**所有**已打开的窗口（主终端、TV 大屏、弹窗小屏、移动端），语义等同在 UI 里手动操作。
- CORS 默认全开放（`Access-Control-Allow-Origin: *`）；接入自有系统时用环境变量 `CORS_ORIGIN` 收紧来源。
- 设置了 `ACCESS_CODE` 时，Agent 需先带会话 Cookie 调用（见文首），否则会拿到「入场」页 HTML。

## 指令表

| cmd | args | 作用 |
|---|---|---|
| `select` | `{sym}` | 全局联动切换选中品种（所有卡片跟随）。sym: `crypto:BTCUSDT` `cn:sh600519` `hk:00700` `us:NVDA.OQ` `idx:sh000001` `fut:hf_GC` `fx:fx_susdcny` |
| `open` | `{type}` | 打开卡片: `kline heatmap watchlist indices structure radar corr movers worldclock screener quant alerts agent news system` |
| `close` | `{id}` | 关闭卡片 |
| `layout` | `{name}` | 布局: `watch research tv1 tv2 mobile` |
| `tv` | `{on}` | 大屏 TV 模式（全屏轮播） |
| `edit` | `{on}` | 布局编辑模式 |
| `announce` | `{text}` | 大屏横幅播报（全窗口） |
| `say` | `{text}` | 语音播报 |
| `tts` | `{on}` | 语音开关 |
| `theme` | `{name}` | `dark` / `light` |
| `upred` | `{on}` | 红涨绿跌(true)/绿涨红跌(false) |
| `alert.add` | `{sym,op,value,note}` | 预警，op ∈ `> < >= <=`，触发时 toast+语音+横幅 |
| `fullscreen` | `{on}` | 浏览器全屏 |
| `reset` | `{scope}` | 恢复出厂默认。scope: `all`（全部）/ `watchlist` / `layout` / `alerts` / `view` / `filter`。前端会先存快照，可 `undo` 撤销 |
| `undo` | `{}` | 撤销上一次配置修改（配置快照栈，最多 12 份） |
| `snapshot` | `{label}` | 手动存一份配置快照 |
| `lock` | `{mode}` | 配置锁: `off`（不锁）/ `soft`（防远程）/ `hard`（全锁定） |
| `unlock` | `{}` | 解除配置锁（只读模式下也放行，避免上锁后解不开） |
| `help` | `{}` | 前端弹出指令说明 |

### 写保护：谁能改你的终端

| 手段 | 挡住的来源 |
|---|---|
| 服务端 `IF_READ_ONLY=1` | 一切会改配置的**远程**指令（select/open/layout/reset/undo/alert.add…）直接 403；播报、帮助、解锁仍放行 |
| 前端配置锁 `soft` | 只拦远程来源（Agent API / SSE 下发），本地手动操作照常 |
| 前端配置锁 `hard` | 连本地一起拦，必须先 `unlock` |

三层互相独立：服务端只读是**硬防线**（别人绕过前端也进不来），前端锁是**细粒度开关**。
`lock` / `unlock` 与播报类指令永远可用 —— 上锁后不会把自己锁死。

## 数据接口

| 端点 | 说明 |
|---|---|
| `GET /api/universe` | 全品种目录（含动态加密池）: `{sym, code, name, group, mcap}` |
| `GET /api/quotes?syms=a,b` | 即时行情快照数组 |
| `GET /api/kline?sym=&period=&limit=` | K线。period: `1m 5m 15m 1h 4h 1d 1w 1M min(分时,仅股票/指数)`，返回 `{bars:[{t,o,h,l,c,v}]}` |
| `GET /api/news` | 7×24 财经快讯 |
| `GET /api/health` | 数据源健康/延迟/SSE 客户端数，另含 `readOnly`（是否只读模式）、`gate`（是否开启密令门禁） |
| `GET /api/agent/log` | 指令历史（最近 200 条） |
| `GET /api/stream` | SSE 实时流: 事件 `hello / q(行情增量) / news / agent` |

## 典型 Agent 工作流

```bash
BASE=http://localhost:8787    # 线上换为 https://your-domain.com

# 1. 发现可用品种与指令
curl $BASE/api/agent
curl $BASE/api/universe

# 2. 拉数据做分析
curl "$BASE/api/kline?sym=crypto:BTCUSDT&period=1h&limit=500"

# 3. 把结论推上大屏: 切品种 + 播报 + 挂预警
curl -X POST $BASE/api/agent -d '{"cmd":"select","args":{"sym":"crypto:ETHUSDT"}}'
curl -X POST $BASE/api/agent -d '{"cmd":"announce","args":{"text":"ETH 1h 级别放量突破"}}'
curl -X POST $BASE/api/agent -d '{"cmd":"alert.add","args":{"sym":"crypto:ETHUSDT","op":">","value":3200,"note":"突破位"}}'

# 4. 切到加密市场视图 + 开大屏
curl -X POST $BASE/api/agent -d '{"cmd":"select","args":{"sym":"crypto:BTCUSDT"}}'   # 联动切市场基准
curl -X POST $BASE/api/agent -d '{"cmd":"tv","args":{"on":true}}'

# 5. 播完不希望别人再动配置: 上锁 (只挡远程, 本地照常)
curl -X POST $BASE/api/agent -d '{"cmd":"lock","args":{"mode":"soft"}}'
# 万一改错了, Agent 也能自己撤回 / 一键归零
curl -X POST $BASE/api/agent -d '{"cmd":"undo"}'
curl -X POST $BASE/api/agent -d '{"cmd":"reset","args":{"scope":"watchlist"}}'
```
