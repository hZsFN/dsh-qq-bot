[![](https://img.shields.io/badge/powered_by-dafeiyu-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/Dafeiyu111)

# dsh-qq-bot

[![CI](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml)

把 QQ 桥接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 agent 会话。**两种后端，一套插件**：

| 后端 | 走什么 | 适合谁 |
|---|---|---|
| `official` | QQ 官方机器人开放平台（私聊 C2C + 群聊 @） | 有开放平台账号、要正规不封号 |
| `onebot` | 自建协议端：NapCat / SnowLuma（OneBot v11） | 想用自己的 QQ 号、要全量群消息 |

每个 QQ 用户 / 每个群对应一个持久化的 dsh 会话，会话历史即上下文，dsh 重启后自动 resume。agent 的回复实时发回 QQ。

## 功能

**通用**

- ✅ 每个 QQ 用户 / 每个群一个独立 dsh 会话（懒创建 + 重启 resume）
- ✅ 通用附件下载：图片、PDF、Office、压缩包、音视频等约 30 类扩展名落到 `<cwd>/inbox/`，未知类型按 `Content-Type` → 文件名 → URL 推断，兜底 `.bin`
- ✅ 三个 agent 工具：`qq-send-image`（富媒体图）、`qq-send-file`（≤5MB 直传 / >5MB 分片，上限 200MB）、`qq-send-message`（主动推文字，不要求当前会话来自 QQ）
- ✅ 文件日志 `$DSH_HOME/storages/qq-bot.log`
- ✅ 进程级兜底：未捕获异常只写日志，不拖垮 dsh

**official 后端**

- ✅ 原生 WebSocket 网关：心跳保活、断线 10s/30s 重连、access_token 提前 5 分钟刷新
- ✅ 群聊响应 `GROUP_AT_MESSAGE_CREATE`，每群独立会话（前缀 `qq-grp2-`）
- ✅ 凭证可走环境变量 `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`，不落盘

**onebot 后端**（v3.0.0 新增）

- ✅ 两种事件来源：正向 WebSocket（插件主动连）/ HTTP 上报（插件起服务收）
- ✅ HTTP 上报支持 `X-Signature` HMAC-SHA1 校验（timingSafeEqual）
- ✅ 引用回复：发出的消息带 `reply` 段，别人点"回复"引用它也算在跟你说话
- ✅ 防回环 + 消息去重：自己发的不处理，同一 `message_id` 60 秒内只处理一次（跨热重载实例）
- ✅ 群聊接话策略：只回 @ / 关键词触发 / 冷却秒数 / 主人白名单
- ✅ WS 连接接管：热重载后新实例自动关掉旧实例的连接

**v3.0.0 另外两项**

- ✅ **内置设置界面**：插件自带 HTTP 服务（默认 `127.0.0.1:3211`）提供可视化配置页，改完点保存即生效
- ✅ **运行时热配置**：配置独立成 `runtime-config.json`，插件每 3 秒读取一次，**改完不用重启 dsh**

## 安装

插件以 cordis bundle 插件方式挂载到 dsh profile：

1. 把本仓库放进 profile 能引到的地方，例如 `~/.dsh/profiles/desktop/qq-bot-plugin/`
2. 在 profile 补丁层注册（`~/.dsh/profiles/desktop/cordis.patch.yml`），模板见 `cordis.patch.example.yml`
3. 重启 dsh

### 后端一：官方机器人

```yaml
config:
  backend: 'official'
  appId: 'YOUR_APP_ID'          # 或环境变量 QQ_BOT_APP_ID
  clientSecret: 'YOUR_SECRET'   # 或环境变量 QQ_BOT_APP_SECRET
```

到 [QQ 开放平台](https://q.qq.com/) 创建应用拿 `AppID` / `AppSecret`，开通 C2C（私聊）与/或群聊能力（沙箱即可先测）。

### 后端二：OneBot v11（NapCat / SnowLuma）

1. 装协议端（[NapCat](https://github.com/NapNeko/NapCatQQ) 或 [SnowLuma](https://github.com/SnowLuma/SnowLuma)），用你的 QQ 登录
2. 协议端里开 OneBot v11 的 **HTTP API**（记下端口与 token）和 **WebSocket 服务**（正向 WS，同样有 token）
3. 本插件配置：

```yaml
config:
  backend: 'onebot'
  onebot:
    apiBase: 'http://127.0.0.1:3000'   # 协议端 HTTP API
    accessToken: 'YOUR_HTTP_TOKEN'
    events: 'ws'                        # ws = 插件主动连；http = 插件起服务收上报
    wsUrl: 'ws://127.0.0.1:3001'        # 正向 WS 地址
    wsToken: 'YOUR_WS_TOKEN'            # 与 HTTP token 不同时单独填，留空回退 accessToken
    selfId: 'YOUR_BOT_QQ'               # 机器人自己的 QQ 号（用于防回环 / @ 判定）
    ownerUsers: ['YOUR_QQ']             # 主人白名单（真实 QQ 号）
```

> **HTTP 与 WS 的 token 通常是两个不同的值**，SnowLuma 就是分开的。连不上先看协议端日志里有没有 `rejected unauthorized WebSocket upgrade` —— 那是 token 不对，不是路径问题。

## 设置界面（v3.0.0）

插件自带配置页：`http://127.0.0.1:3211/`（浏览器直接打开就能用）。四块表单——后端选择、会话预设、群聊策略、OneBot 连接；右下「保存」写入 `runtime-config.json`，3 秒内自动生效；Ctrl+S 也能保存。

想在 dsh 设置页里内嵌，再装一个只负责注册 `settings.section` 的客户端插件（渲染 iframe 指向上面这个地址）即可，本仓库的 `settings-page.html` 就是页面本体。

## 配置项

### 顶层

| 键 | 默认 | 说明 |
|---|---|---|
| `backend` | `'official'` | `official` / `onebot`，**单选**，两种后端暂不能同时跑 |
| `enabled` | `true` | 关掉则插件不启动 |
| `preset` | `''` | 统一指定 agent 预设；留空 = 群用 `qqgroup`、私聊用默认预设 |
| `cwd` | `$DSH_QQ_BOT_CWD` → 进程 cwd | agent 工作目录（附件落 `<cwd>/inbox/`） |
| `appId` / `clientSecret` | 环境变量 | official 后端凭证 |
| `fixedSessionId` | — | 把私聊固定绑到某个 sessionId |
| `runtimeConfig` | `''` | 运行时配置文件名（相对插件目录，默认 `runtime-config.json`） |
| `settingsPort` | `3211` | 设置界面监听的本地端口（改完要重启） |

### `onebot.*`

| 键 | 默认 | 说明 |
|---|---|---|
| `apiBase` | `http://127.0.0.1:3000` | OneBot HTTP API 地址 |
| `accessToken` | — | HTTP API token |
| `events` | `'http'` | `ws`（主动连）/ `http`（起服务收上报） |
| `wsUrl` / `wsToken` | — / 回退 accessToken | 正向 WS 地址与 token |
| `selfId` | — | 机器人 QQ 号 |
| `listenHost` / `listenPort` / `listenPath` | `127.0.0.1` / `3200` / `/onebot` | HTTP 上报监听 |
| `secret` | `''` | HTTP 上报的 `X-Signature` 密钥，留空不校验 |
| `atOnly` | `true` | 群里只回 @；`false` = 全量群消息都进 agent |
| `groupKeywords` | `[]` | 没被 @ 时，只有文本命中这些词才接（解决全量群消息刷屏） |
| `groupCooldownSec` | `0` | 非 @ 消息的接话冷却秒数，0 = 不冷却 |
| `ownerUsers` | `[]` | 主人白名单（真实 QQ 号）。**OneBot 模式下私聊也必须是白名单** |

## 运行时热配置

`runtime-config.json` 里可以放上述任意字段（`backend`、`preset`、`onebot.*` 都行），插件每 3 秒检查文件 mtime：

- 连接参数变了（token / 地址 / selfId / events…）→ 停旧连接、400ms 后重启后端
- 只改了策略（`atOnly` / 关键词 / 冷却 / preset）→ 直接换值，不断线
- JSON 写坏了 → 只记日志，继续用旧配置跑

**注意**：`enabled` / `appId` / `clientSecret` / `runtimeConfig` 这几项不能靠热配置改，仍要改 profile 的 patch 并重启。

## 工作原理

```
official：QQ 用户 ──私聊/群@──▶ QQ 开放平台网关 (WSS) ──▶ 插件 ──▶ dsh 会话 ──▶ POST /v2/users|groups/<id>/messages

onebot：  QQ 用户 ──消息──▶ 协议端(HTTP API + WS) ──事件──▶ 插件 ──▶ dsh 会话 ──▶ POST /{send_private_msg|send_group_msg}
```

- 会话映射持久化在 `$DSH_HOME/storages/qq-bot-sessions.json`
- 附件以**本地路径**进 agent 上下文（不经过图像模态），纯文本模型也能处理
- 工具通过 `exec.agent.id`（sessionId）反查 openid / group_openid / QQ 号，多用户各发各的

## 已知限制

- `backend` 单选。要同时跑官方和 OneBot，得改会话映射与发送分派（约 5 处），当前版本不支持
- OneBot 后端依赖第三方协议端，**有账号风控风险**（新号、异地 IP、高频群发最危险），小号建议先正常挂几天
- 群消息来自协议端时只有 QQ 号与群名片，没有官方那套 openid；主人判定用 `ownerUsers` 白名单
- 日志会记录消息摘要（前 60 字符），部署注意隐私
- 插件跑在 dsh 进程内：dsh 重启 = 桥重启（自动 resume 会话）
- 热重载插件代码会留下旧实例的 WS 连接，v3.0.0 已做接管与去重，但仍建议改完代码重启一次

## License

MIT
