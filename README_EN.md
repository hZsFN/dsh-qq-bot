[![](https://img.shields.io/badge/powered_by-dafeiyu-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/Dafeiyu111)

# dsh-qq-bot

[![CI](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/hZsFN/dsh-qq-bot/actions/workflows/ci.yml)

Bridge QQ into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent sessions. **One plugin, two backends**:

| Backend | Transport | Pick it when |
|---|---|---|
| `official` | QQ Bot Open Platform (C2C private chat + group @) | you have an official bot app; no ban risk |
| `onebot` | self-hosted OneBot v11: NapCat / SnowLuma | you want your own QQ account and full group traffic |

One persistent dsh session per QQ user / per group; session history is the context, resumed after a dsh restart. Replies go straight back to QQ.

## Features

**Shared**

- Session-per-user / session-per-group, lazily created and resumed on restart
- Attachments (about 30 extensions: images, PDF, Office, archives, audio/video) saved to `<cwd>/inbox/`; unknown types inferred from `Content-Type` → filename → URL, fallback `.bin`
- Three agent tools: `qq-send-image`, `qq-send-file` (≤5MB direct, >5MB chunked upload, 200MB cap), `qq-send-message`
- File log at `$DSH_HOME/storages/qq-bot.log`
- Process-level guard: uncaught errors are logged, never crash dsh

**official backend**

- Native WebSocket gateway with heartbeat, 10s/30s reconnect, token refresh 5 minutes early
- Group messages via `GROUP_AT_MESSAGE_CREATE`, one session per group (prefix `qq-grp2-`)
- Credentials can live in `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`

**onebot backend** (new in v3.0.0)

- Two event sources: forward WebSocket (plugin connects out) or HTTP reporting (plugin listens)
- `X-Signature` HMAC-SHA1 verification for HTTP reporting (timing-safe compare)
- Quote replies: outgoing messages carry a `reply` segment; a user quoting your message counts as talking to you
- Loop protection and message de-duplication (same `message_id` handled once per 60s, across hot-reload instances)
- Group engagement policy: @-only / keyword trigger / cooldown / owner allowlist
- WebSocket takeover: a fresh instance closes the stale connection left by a hot reload

**Also in v3.0.0**

- Built-in settings UI: the plugin serves a config page at `127.0.0.1:3211`, save and it applies
- Hot runtime config: `runtime-config.json` is polled every 3 seconds — **no restart needed**

## Install

1. Drop this repo somewhere the profile can reach, e.g. `~/.dsh/profiles/desktop/qq-bot-plugin/`
2. Register it in the profile patch layer (`~/.dsh/profiles/desktop/cordis.patch.yml`), see `cordis.patch.example.yml`
3. Restart dsh

### official

```yaml
config:
  backend: 'official'
  appId: 'YOUR_APP_ID'
  clientSecret: 'YOUR_SECRET'
```

Create an app at [QQ Open Platform](https://q.qq.com/) and enable C2C (private) and/or group capability (sandbox is fine first).

### OneBot v11 (NapCat / SnowLuma)

```yaml
config:
  backend: 'onebot'
  onebot:
    apiBase: 'http://127.0.0.1:3000'
    accessToken: 'YOUR_HTTP_TOKEN'
    events: 'ws'
    wsUrl: 'ws://127.0.0.1:3001'
    wsToken: 'YOUR_WS_TOKEN'      # careful: HTTP and WS tokens are usually different
    selfId: 'YOUR_BOT_QQ'
    ownerUsers: ['YOUR_QQ']
```

If the WebSocket keeps failing with `rejected unauthorized WebSocket upgrade`, the token is wrong — that is not a path problem.

## Settings UI

Open `http://127.0.0.1:3211/` (or embed it via a client plugin that registers `settings.section` and renders an iframe). Four cards: backend, session preset, group policy, OneBot connection. Saving writes `runtime-config.json`, effective within 3 seconds. Ctrl+S works too.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `backend` | `'official'` | `official` or `onebot`; **single choice**, they cannot run together yet |
| `enabled` | `true` | disable the plugin |
| `preset` | `''` | agent preset for all QQ sessions; empty = `qqgroup` for groups, default for DMs |
| `cwd` | `$DSH_QQ_BOT_CWD` → process cwd | agent workspace (attachments in `<cwd>/inbox/`) |
| `appId` / `clientSecret` | env | official credentials |
| `fixedSessionId` | — | pin private chat to a specific session |
| `runtimeConfig` | `''` | runtime config filename (relative to the plugin dir) |
| `settingsPort` | `3211` | local port for the settings UI (needs a restart) |

`onebot.*`: `apiBase`, `accessToken`, `events` (`ws`/`http`), `wsUrl`, `wsToken`, `selfId`, `listenHost`/`listenPort`/`listenPath` (default `127.0.0.1:3200/onebot`), `secret`, `atOnly` (default `true`), `groupKeywords` (`[]`), `groupCooldownSec` (`0`), `ownerUsers` (`[]`, required for DMs on OneBot).

## Hot runtime config

Any field (`backend`, `preset`, `onebot.*`) can live in `runtime-config.json`, polled every 3 seconds:

- connection-level change (token / endpoint / selfId / events) → stop and restart the backend after 400ms
- policy-only change (`atOnly` / keywords / cooldown / preset) → applied in place, no reconnect
- malformed JSON → logged, keeps running on the previous config

`enabled` / `appId` / `clientSecret` / `runtimeConfig` still need a profile patch edit plus restart.

## Limitations

- `backend` is exclusive; running both needs changes in five places (session maps, send dispatch, owner check)
- The OneBot backend relies on a third-party protocol implementation — **account risk exists** (fresh accounts, foreign IPs, high-frequency group posting are the dangerous cases)
- Session map persists at `$DSH_HOME/storages/qq-bot-sessions.json`
- The log records a 60-character message digest; mind your privacy when deploying
- Hot-reloading plugin code leaves stale WS connections; v3.0.0 handles takeover and dedup, but a restart is still the clean move

## License

MIT
