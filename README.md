[![](https://img.shields.io/badge/powered_by-dafeiyu-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/Dafeiyu111)

# dsh-qq-bot

[![CI](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml)

把 **QQ 官方机器人**（私聊 C2C + 群聊 @）桥接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 agent 会话。

每个 QQ 用户（openid）对应一个持久化的 dsh 会话，会话历史即上下文；dsh 重启后自动 resume 恢复历史。agent 的回复经 QQ 网关实时发回。群聊则每个群独立一个会话，可单独挂"只聊天、不碰本机"的 agent 预设。

## 功能

- ✅ **私聊**：每个 openid 一个独立 dsh 会话（懒创建 + 重启 resume）
- ✅ **群聊**：收到 `@机器人` 消息即响应，每个 `<group_openid>` 一个独立会话（默认前缀 `qq-grp2-`），可挂 `qqgroup` 预设实现"群里只能聊天、不能用本机工具"
- ✅ **通用附件下载**：图片、PDF、Office 文档、压缩包、音视频等约 30 类扩展名自动落到 agent 工作目录的 `inbox/`，未知类型按 `Content-Type` → 文件名 → URL 依次推断，兜底 `.bin`
- ✅ **三个 agent 工具**：
  - `qq-send-image` — 推送本地图片（富媒体消息 `msg_type: 7`）
  - `qq-send-file` — 推送任意文件（`file_type: 4`；≤5MB base64 直传，>5MB 走分片上传四步，上限 200MB，`md5_10m` 秒传）
  - `qq-send-message` — 纯文字主动发消息（不要求当前会话来自 QQ）
- ✅ **原生 WebSocket 网关**：心跳保活、断线 10s/30s 自动重连、access_token 提前 5 分钟自动刷新
- ✅ **进程级兜底**：未捕获异常只写日志，不会拖垮 dsh 进程
- ✅ **文件日志**：`$DSH_HOME/storages/qq-bot.log`（排查全靠它）

## 安装

插件以 **cordis bundle 插件** 方式挂载到 dsh profile：

1. 把本仓库的 `index.js` 放入（或软链到）profile 目录，例如：
   ```
   ~/.dsh/profiles/desktop/qq-bot-plugin/index.js
   ```
2. 在 profile 的补丁层注册插件（`~/.dsh/profiles/desktop/cordis.patch.yml`）：
   ```yaml
   - insert:
       - id: qq-bot
         name: ./qq-bot-plugin/index.js
         config:
           enabled: true
           cwd: 'C:\path\to\agent\workspace'   # agent 工作目录（可选，默认取 dsh 进程 cwd）
   ```
3. 凭证两种给法（二选一）：
   - **环境变量**（推荐，不落盘）：`QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`
   - **config**（见 `cordis.patch.example.yml`）
4. 重启 dsh web，日志出现 `QQ 网关 READY（开始接收私聊）` 即成功。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `appId` | `$QQ_BOT_APP_ID` | 机器人 AppID |
| `clientSecret` | `$QQ_BOT_APP_SECRET` | 机器人 AppSecret |
| `enabled` | `true` | 关掉则插件不启动 |
| `cwd` | `$DSH_QQ_BOT_CWD` → 进程 cwd | agent 工作目录（附件落到 `<cwd>/inbox/`） |
| `fixedSessionId` | — | 把某个 QQ 会话固定绑到指定 sessionId（默认回落 `qq-main-<openid 前 8 位>`） |
| `allowedGroups` | `[]` | 只响应这些群（`group_openid` 列表）；留空 = 所有群都响应 |
| `ownerOpenids` | `[]` | 哪些私聊 openid 算主人（留空 = 任何私聊都算） |
| `ownerGroupMembers` | `[]` | 群成员 openid 白名单（群消息只给匿名 `member_openid`，不给昵称） |

## 获取 QQ 机器人凭证

1. 前往 [QQ 开放平台](https://q.qq.com/) → 创建应用/机器人，拿到 `AppID` 与 `AppSecret`。
2. 机器人需要开通 **C2C（私聊）** 与/或 **群聊** 能力（沙箱环境即可先测）。
3. 用该机器人的 QQ 号给你的 QQ 发消息 → 事件 `C2C_MESSAGE_CREATE` 会带 `author.user_openid`。
   > 注意：openid 是机器人视角下对你 QQ 的 ID，不是你的 QQ 号；不同机器人 openid 不同。

## 工作原理

```
QQ 用户 ──私聊──▶ QQ 开放平台网关 (WSS)
                      │ C2C_MESSAGE_CREATE
                      ▼
                dsh-qq-bot 插件
                 ├─ 附件 → 下载到 <cwd>/inbox/
                 ├─ 文本 + 附件路径 → createUserMessage → 该 openid 的 agent 会话
                 ├─ session/event 监听 turn 结束 → 最终文本 → POST /v2/users/<openid>/messages 回发
                 └─ 工具 qq-send-image / qq-send-file：上传本地文件 → 富媒体消息回发

QQ 群 ──@机器人──▶ 事件 GROUP_AT_MESSAGE_CREATE → 同群独立会话（qq-grp2-*）→ POST /v2/groups/<group_openid>/messages
```

- 会话映射持久化在 `$DSH_HOME/storages/qq-bot-sessions.json`（openid / group_openid → sessionId）。
- 附件以**本地路径**进入 agent 上下文（不经过图像模态），纯文本模型也能处理。
- 工具通过 `exec.agent.id`（sessionId）反查 openid / group_openid，多用户各发各的。
- 断线重连：网关关闭 10 秒重连；获取 token / 网关失败 30 秒重试。

## 已知注意事项

- 群消息只处理 `@机器人`（`GROUP_AT_MESSAGE_CREATE`），普通群消息不处理。
- 每个 openid / 每个群一个会话，消息排队进同一个 turn 上下文；不建议多用户共用一台机器时放敏感数据。
- 日志文件 `qq-bot.log` 会记录消息摘要（前 60 字符），部署时注意隐私。
- 群聊预设 `qqgroup` 需要在同一份 `cordis.patch.yml` 里注册；未注册则群会话回落默认预设并在日志里告警。
- 插件运行在 dsh web 进程内：dsh 重启 = 桥重启（自动 resume 会话）。

## License

MIT
