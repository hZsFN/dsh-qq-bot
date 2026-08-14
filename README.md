# dsh-qq-bot

[![CI](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml)

把 **QQ 官方机器人私聊（C2C）** 桥接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 agent 会话。

每个 QQ 用户（openid）对应一个持久化的 dsh 会话，会话历史即上下文；dsh 重启后自动 resume 恢复历史。agent 的回复经 QQ 网关实时发回。**只处理私聊，不处理群消息。**

## 功能

- ✅ 私聊消息 → 对应 openid 的独立 dsh 会话（懒创建 + 重启 resume）
- ✅ 图片附件自动下载到 agent 工作目录的 `inbox/`（文本模型也能通过本地文件工具处理）
- ✅ 回复自动回发（完整 turn 结束后的最终文本）
- ✅ **发图工具 `qq-send-image`**（v2.0）：agent 可把本地图片直接推送给当前 QQ 用户（富媒体消息 `msg_type: 7`；仅 QQ 会话可用，GUI 会话返回友好错误）
- ✅ 原生 WebSocket 网关：心跳保活、断线 10s/30s 自动重连、access_token 提前 5 分钟自动刷新
- ✅ 进程级兜底：未捕获异常只写日志，不会拖垮 dsh 进程
- ✅ 文件日志：`$DSH_HOME/storages/qq-bot.log`（排查全靠它）

## 安装

插件以 **cordis bundle 插件** 方式挂载到 dsh web profile：

1. 把本仓库放到任意位置，将 `index.js` 放入（或软链到）profile 目录，例如：
   ```
   ~/.dsh/profiles/web/qq-bot-plugin/index.js
   ```
2. 在 profile 的补丁层注册插件（`~/.dsh/profiles/web/cordis.patch.yml`）：
   ```yaml
   - insert:
       - id: qq-bot
         name: ./qq-bot-plugin/index.js
         config:
           enabled: true
           cwd: 'C:\your\agent\workspace'   # agent 工作目录（可选，默认取 dsh 进程 cwd）
   ```
3. 凭证两种给法（二选一）：
   - **环境变量**（推荐，不落盘）：`QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`
   - **config**（见 `cordis.patch.example.yml`）
4. 重启 dsh web，日志出现 `QQ 网关 READY（开始接收私聊）` 即成功。

## 获取 QQ 机器人凭证

1. 前往 [QQ 开放平台](https://q.qq.com/) → 创建应用/机器人，拿到 `AppID` 与 `AppSecret`。
2. 机器人需要开通 **C2C（私聊）** 能力（沙箱环境即可先测）。
3. 用该机器人的 QQ 号给你的 QQ 发消息 → 事件 `C2C_MESSAGE_CREATE` 会带 `author.user_openid`。
   > 注意：openid 是机器人视角下对你 QQ 的 ID，不是你的 QQ 号；不同机器人 openid 不同。

## 工作原理

```
QQ 用户 ──私聊──▶ QQ 开放平台网关 (WSS)
                      │ C2C_MESSAGE_CREATE
                      ▼
                dsh-qq-bot 插件
                 ├─ 图片附件 → 下载到 <cwd>/inbox/
                 ├─ 文本 + 附件路径 → createUserMessage → 该 openid 的 agent 会话
                 ├─ session/event 监听 turn 结束 → 最终文本 → POST /v2/users/<openid>/messages 回发
                 └─ 工具 qq-send-image：agent 上传本地图片（POST /files）→ 富媒体消息回发
```

- 会话映射持久化在 `$DSH_HOME/storages/qq-bot-sessions.json`（openid → sessionId）。
- 图片以**本地路径**进入 agent 上下文（不经过图像模态），纯文本模型也能处理。
- 发图工具通过 `exec.agent.id`（sessionId）反查 openid，多用户各发各的。
- 断线重连：网关关闭 10 秒重连；获取 token/网关失败 30 秒重试。

## 已知注意事项

- **只接私聊**：intents 仅订阅 `1<<25`（C2C），群消息不处理。
- 每个 openid 一个会话，消息排队进同一个 turn 上下文；不建议多用户共用一台机器时放敏感数据。
- 日志文件 `qq-bot.log` 会记录收到的消息摘要（前 60 字符），部署时注意隐私。
- 插件运行在 dsh web 进程内：dsh 重启 = 桥重启（自动 resume 会话）。

## License

MIT
