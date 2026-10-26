# Changelog

## v3.0.0 (2026-10-26)

### 新增
- **OneBot v11 后端**：`backend: 'onebot'` 时改走高兼容协议端（NapCat / SnowLuma 实测可用），一套插件两种后端，靠同名分派器 `sendText` / `sendImageTo` / `sendFileTo` 切换，下游调用点零改动
  - 事件两种来源：正向 WebSocket（插件主动连，15 秒重连）/ HTTP 上报（插件起服务收，支持 `X-Signature` HMAC-SHA1 校验、timingSafeEqual 比较）
  - 引用回复：发出的消息带 `reply` 段；别人点"回复"引用你的消息也算在跟你说话（`obSentIds` 记账）
  - 防回环 + 去重：自己发的不处理；同一 `message_id` 60 秒内只处理一次，跨热重载实例共享（`globalThis.__dshQqbotSeen`）
  - WS 连接接管：新实例连上前先关掉旧实例留下的连接（`globalThis.__dshQqbotObWs`），修掉"热重载后一条消息回两次"
- **群聊接话策略**：`atOnly`（只回 @）/ `groupKeywords`（关键词触发）/ `groupCooldownSec`（冷却秒数）/ `ownerUsers`（主人白名单），解决全量群消息刷屏
- **内置设置界面**：插件自带 HTTP 服务（默认 `127.0.0.1:3211`），`GET /` 出配置页、`GET/PUT /api/config` 读写运行时配置，带 CORS；`settings-page.html` 四块表单 + Ctrl+S 保存
- **运行时热配置**：配置独立成 `runtime-config.json`，插件每 3 秒比对 mtime 后热读；连接参数变了自动停旧连接重启后端，只改策略则原地换值不断线

### 变更
- `backend` 成为顶层开关，默认 `'official'`，行为与 v2.x 完全一致
- `appId` / `clientSecret` 改为可选（onebot 后端不需要），official 模式缺凭证时才告警退出
- 官方发送函数改名为 `officialSendText` / `officialSendImageTo` / `officialSendFileTo`，分派器沿用旧名，兼容原有调用
- OneBot 模式下主人判定只认 `ownerUsers` 里的真实 QQ 号，**不再认 `member_role="owner"`**（那是群主，不是主人）；私聊同样必须白名单
- `downloadImages` 在 OneBot 模式下裸取（不带 QQBot 鉴权头）
- 启动/停止逻辑抽成 `startBackend()` / `stopBackend()`，供热读复用

### 修复
- 两个 fire-and-forget 入口（`onC2CMessage` / `onGroupMessage`）补 `.catch`，未捕获拒绝不再拖垮 dsh 进程
- 错误回执不再把内部异常文本发给用户，改为中性提示 + 完整堆栈进日志
- 五处发送调用补 `.catch`，工具内仍抛出以便 agent 感知失败

### 文档
- README 中英两份补齐双后端、设置界面、热配置、群聊策略与已知限制
- `cordis.patch.example.yml` 加 OneBot 与运行时配置模板，全部占位符化
- `.gitignore` 排除 `runtime-config.json` / `qq-bot-sessions.json` / `inbox/`（含真实 token 与 QQ 号）

## v2.1.0 (2026-10-19)

### 新增
- **群聊支持**：响应 `GROUP_AT_MESSAGE_CREATE`（群里 @机器人），每个 `<group_openid>` 一个独立会话（前缀 `qq-grp2-`），可挂 `qqgroup` 预设实现「群里只能聊天、不能用本机工具」，与私聊会话互不影响
- **发文件工具 `qq-send-file`**：`file_type: 4`，≤5 MB 走 base64 直传，>5 MB 走分片上传四步（`upload_prepare` → 分片 PUT → `upload_part_finish` → `files` 合并），上限 200 MB，`md5_10m` 秒传
- **主动发消息工具 `qq-send-message`**：不要求当前会话来自 QQ，可主动推送纯文字
- **通用附件下载**：从「只下载图片」扩展到约 30 类扩展名（PDF / Office / 压缩包 / 音视频等），未知类型按 `Content-Type` → 文件名 → URL 依次推断，兜底 `.bin`；收到附件后提示 agent「已保存到本机，请直接读取」
- 新配置项：`fixedSessionId`、`allowedGroups`、`ownerOpenids`、`ownerGroupMembers`

### 变更
- 凭证支持**环境变量** `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`（config 优先，环境变量兜底，便于密钥不落盘）
- `cwd` 缺省值改为 `$DSH_QQ_BOT_CWD`，再缺省用进程 cwd（不再内置任何机器专属路径）
- `inject` 增加 `systemPrompt`
- README 改为中文主位，新增英文版 `README_EN.md`

### 修复
- 工具调用缺少 `output.render` 导致崩溃
- 网关多实例互顶 token、boot 阶段致命错误不退出等稳定性问题

## v2.0.0 (2026-08-14)

### 新增
- **发图能力**：注册 `qq-send-image` 工具，agent 可将本地图片直接推送给当前 QQ 私聊用户（QQ 富媒体消息，`msg_type: 7`）。
  - 通过 `exec.agent.id`（sessionId）反查 openid，多用户各发各的
  - 仅 QQ 私聊会话可用；GUI 会话调用返回友好错误
- peerDependencies 增加 `@deepseek-ai/dsh-tools`（工具注册依赖）

### 变更
- 无破坏性变更；v1.0.0 的配置方式完全兼容

## v1.0.0 (2026-08-14)

### 新增
- QQ 官方机器人私聊（C2C）桥接进 DeepSeek Harness (dsh) agent 会话
- 每个 openid 对应独立持久化会话（重启 resume）
- 图片附件自动下载到 `<cwd>/inbox/`
- 原生 WebSocket 网关：心跳、断线自动重连、token 自动刷新
- 进程级异常兜底 + 文件日志
