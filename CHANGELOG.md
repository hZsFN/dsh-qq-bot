# Changelog

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
