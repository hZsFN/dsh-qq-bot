[![](https://img.shields.io/badge/powered_by-dafeiyu-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/Dafeiyu111)

# dsh-qq-bot

[![CI](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml)

Chinese version: [README.md](./README.md)

Bridge the **QQ official bot** (private chat C2C + group @-mentions) into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent sessions.

Every QQ user (openid) gets one persistent dsh session — the conversation history *is* the context, and it is resumed automatically after a dsh restart. Replies are pushed back through the QQ gateway in real time. For groups, each group gets its own session, which can be pinned to a chat-only agent preset with no access to local tools.

## Features

- ✅ **Private chat**: one independent dsh session per openid (lazily created, resumed on restart)
- ✅ **Group chat**: replies to `@bot` messages, one session per `<group_openid>` (default prefix `qq-grp2-`), can be pinned to the `qqgroup` preset so the bot can only chat, never touch the host
- ✅ **Generic attachment download**: ~30 extension families (images, PDF, Office documents, archives, audio/video, …) are saved into `<cwd>/inbox/`; unknown types are resolved via `Content-Type` → filename → URL, falling back to `.bin`
- ✅ **Three agent tools**:
  - `qq-send-image` — push a local image (rich-media message, `msg_type: 7`)
  - `qq-send-file` — push any file (`file_type: 4`; ≤5 MB as base64, >5 MB via the four-step chunked upload, 200 MB cap, `md5_10m` instant-upload)
  - `qq-send-message` — send a plain text message proactively (does not require the current session to come from QQ)
- ✅ **Native WebSocket gateway**: heartbeat keep-alive, auto-reconnect after 10 s / 30 s, access_token refreshed 5 minutes early
- ✅ **Process-level guard**: uncaught exceptions are logged instead of killing the dsh process
- ✅ **File log**: `$DSH_HOME/storages/qq-bot.log`

## Installation

The plugin is mounted as a **cordis bundle plugin** into a dsh profile:

1. Put `index.js` from this repo into (or symlink it to) your profile directory, e.g.:
   ```
   ~/.dsh/profiles/desktop/qq-bot-plugin/index.js
   ```
2. Register it in the profile patch layer (`~/.dsh/profiles/desktop/cordis.patch.yml`):
   ```yaml
   - insert:
       - id: qq-bot
         name: ./qq-bot-plugin/index.js
         config:
           enabled: true
           cwd: 'C:\path\to\agent\workspace'   # optional, defaults to the dsh process cwd
   ```
3. Credentials, either way:
   - **Environment variables** (recommended, nothing on disk): `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`
   - **config** (see `cordis.patch.example.yml`)
4. Restart dsh web; `QQ 网关 READY（开始接收私聊）` in the log means success.

## Configuration

| Key | Default | Description |
|---|---|---|
| `appId` | `$QQ_BOT_APP_ID` | Bot AppID |
| `clientSecret` | `$QQ_BOT_APP_SECRET` | Bot AppSecret |
| `enabled` | `true` | Set `false` to disable the plugin |
| `cwd` | `$DSH_QQ_BOT_CWD` → process cwd | Agent working directory (attachments go to `<cwd>/inbox/`) |
| `fixedSessionId` | — | Bind a QQ conversation to a fixed sessionId (defaults to `qq-main-<openid[:8]>`) |
| `allowedGroups` | `[]` | Only respond in these groups (`group_openid` list); empty = all groups |
| `ownerOpenids` | `[]` | Which private openids count as the owner (empty = any) |
| `ownerGroupMembers` | `[]` | Group member openid allowlist (group events expose anonymous `member_openid`, no nicknames) |

## Getting bot credentials

1. Go to the [QQ Open Platform](https://q.qq.com/) → create an app/bot → copy `AppID` and `AppSecret`.
2. Enable the **C2C (private chat)** and/or **group chat** capability (the sandbox is enough to start).
3. Message the bot from your own QQ → the `C2C_MESSAGE_CREATE` event carries `author.user_openid`.
   > Note: an openid identifies your QQ account *as seen by that bot* — it is not your QQ number, and it differs per bot.

## How it works

```
QQ user ──private chat──▶ QQ gateway (WSS)
                              │ C2C_MESSAGE_CREATE
                              ▼
                        dsh-qq-bot plugin
                         ├─ attachments → <cwd>/inbox/
                         ├─ text + attachment paths → createUserMessage → that openid's agent session
                         ├─ listen for turn end → final text → POST /v2/users/<openid>/messages
                         └─ tools qq-send-image / qq-send-file: upload local file → rich-media reply

QQ group ──@bot──▶ GROUP_AT_MESSAGE_CREATE → per-group session (qq-grp2-*) → POST /v2/groups/<group_openid>/messages
```

- Session mapping is persisted in `$DSH_HOME/storages/qq-bot-sessions.json` (openid / group_openid → sessionId).
- Attachments enter the agent context as **local paths** (not as image modality), so text-only models can handle them.
- Tools resolve the target via `exec.agent.id` (sessionId), so multiple users each get their own reply.
- Reconnect: gateway close → retry in 10 s; token/gateway failure → retry in 30 s.

## Caveats

- Group messages are handled only when the bot is @-mentioned (`GROUP_AT_MESSAGE_CREATE`).
- One session per openid / per group — messages queue into the same turn context; do not keep secrets on a host shared by untrusted users.
- `qq-bot.log` records a message digest (first 60 chars): mind the privacy of your deployment.
- The `qqgroup` preset must be registered in the same `cordis.patch.yml`; otherwise group sessions fall back to the default preset and log a warning.
- The plugin runs inside the dsh web process: restarting dsh restarts the bridge (sessions are resumed automatically).

## License

MIT
