# Changelog

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
