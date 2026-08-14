// dsh-qq-bot: 把 QQ 官方机器人私聊桥接进 DeepSeek Harness (dsh) 的 agent 会话。
// 每个 QQ 用户对应一个持久化 dsh 会话（默认 preset），会话历史即上下文；
// dsh 重启后通过 resume 恢复历史。agent 回复经 QQ 网关发回。
//
// QQ 官方 api-v2 凭证流程（与 OpenClaw 的 qqbot 通道同源）：
//   POST https://api.bot.qq.com/app/getAppAccessToken {appId, clientSecret} → access_token（约 2 小时有效，自动刷新）
//   GET  https://api.bot.qq.com/gateway/bot  (Authorization: QQBot <token>) → wss 地址
//   WSS  Identify: { token: "QQBot <access_token>", intents: 1<<25, shard: [0,1], properties }
//   发消息: POST https://api.bot.qq.com/v2/users/<openid>/messages (QQBot <token>)
//
// 三个必须注意的 dsh 内部约定（均为实测踩坑记录）：
//   1. setup 返回值若含 .commit() 会被创建流程调用 → 必须返回 undefined
//      （agentPresets.mount 返回 AgentPreset 对象，不能直接 return）。
//   2. persona 的 {{model}} 变量要求 agent 安装模型选择 → 在 setup 里
//      installModelSelection(agentCtx, { current: selection, assembled: undefined })，
//      标准写法见 dsh-headless 包。
//   3. 每个 openid 的会话 id 持久化在 $DSH_HOME/storages/qq-bot-sessions.json，
//      重启后 resume 同一会话，保持上下文连续。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { z } from "zod";
import { homedir } from "node:os";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";

export const name = "qq-bot";
export const inject = ["agents", "agentPresets", "agentDefaultModel"];

export const Config = z.object({
  appId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  cwd: z.string().default(""),
});

const API_BASE = "https://api.bot.qq.com";
const INTENTS_C2C = 1 << 25; // GROUP_AND_C2C_EVENT → C2C_MESSAGE_CREATE

// 文件日志（ctx.logger 在 web 组合下不进 stdout，落盘便于排查）
const HOME_DIR = process.env.DSH_HOME || join(homedir(), ".dsh");
const LOG_FILE = join(HOME_DIR, "storages", "qq-bot.log");
function dlog(msg) {
  try {
    mkdirSync(join(HOME_DIR, "storages"), { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

// 进程级兜底：任何未捕获异常只记日志，不让整个 dsh 进程死掉（QQ 桥必须长活）
// 背景：turn 崩溃时 agent-loop 的 throwError 会重抛，未处理 rejection 会直接杀死 node 进程
process.on("unhandledRejection", (err) => {
  dlog(`unhandledRejection: ${err?.stack ?? err}`);
});
process.on("uncaughtException", (err) => {
  dlog(`uncaughtException: ${err?.stack ?? err}`);
});

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  // 凭证来源：插件配置优先，其次环境变量（方便无配置文件部署）
  const appId = config.appId || process.env.QQ_BOT_APP_ID || "";
  const clientSecret = config.clientSecret || process.env.QQ_BOT_APP_SECRET || "";
  if (!appId || !clientSecret) {
    ctx.logger.warn("[qq-bot] 未配置 appId/clientSecret（config 或 QQ_BOT_APP_ID/QQ_BOT_APP_SECRET 环境变量），插件不启用");
    return;
  }
  // 附件下载与 agent 工作目录：优先 config.cwd，其次进程工作目录
  const cwd = config.cwd || process.cwd() || homedir();

  // ---- access_token 管理（提前 5 分钟刷新）----
  let tokenCache = { token: "", expiresAt: 0 };
  async function getAccessToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
      return tokenCache.token;
    }
    const res = await fetch(`${API_BASE}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`getAppAccessToken ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data?.access_token) throw new Error("getAppAccessToken 未返回 access_token");
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in ?? 7200) * 1000,
    };
    dlog(`access_token 已刷新（${Number(data.expires_in ?? 7200)}s 有效）`);
    return tokenCache.token;
  }

  // ---- openid → sessionId 映射（持久化）----
  const mapFile = join(HOME_DIR, "storages", "qq-bot-sessions.json");
  const loadMap = () => {
    try { return JSON.parse(readFileSync(mapFile, "utf8")); } catch { return {}; }
  };
  const saveMap = (m) => {
    try {
      mkdirSync(join(HOME_DIR, "storages"), { recursive: true });
      writeFileSync(mapFile, JSON.stringify(m, null, 2));
    } catch (e) { ctx.logger.warn(`[qq-bot] 保存会话映射失败: ${e?.message ?? e}`); }
  };
  let openidToSession = loadMap();

  // ---- live agent 与待回复状态 ----
  const handles = new Map(); // openid -> AgentHandle
  const pending = new Map(); // sessionId -> { turns: Map<turn, text>, reply: (text) => void }

  const sendToQq = async (openid, text, msgId) => {
    try {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify({ content: text, msg_type: 0, msg_id: msgId || "", msg_seq: 1 }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        ctx.logger.warn(`[qq-bot] 回复失败 ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (e) { ctx.logger.warn(`[qq-bot] 回复异常: ${e?.message ?? e}`); }
  };

  // ---- 下载 QQ 图片附件到 agent 工作目录（纯文本模型也能通过文件工具处理）----
  const IMAGE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
  };
  const downloadImages = async (attachments, msgId) => {
    const inbox = join(cwd, "inbox");
    const out = { saved: [], failed: 0 };
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const ct = att?.content_type ?? "";
      const url = att?.url;
      if (!ct.startsWith("image/") || !url) continue;
      const ext = IMAGE_EXT[ct] || extname(String(url).split("?")[0]) || ".img";
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        let res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
          // QQ 富媒体 url 偶尔要求鉴权头，带 token 重试一次
          const token = await getAccessToken();
          res = await fetch(url, { headers: { Authorization: `QQBot ${token}` } });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error("empty body");
        mkdirSync(inbox, { recursive: true });
        const stamp = String(msgId || Date.now()).replace(/[^a-zA-Z0-9]/g, "").slice(-16);
        const file = join(inbox, `qq-${stamp}-${i}${ext}`);
        writeFileSync(file, buf);
        out.saved.push(file);
        dlog(`图片已保存: ${file} (${buf.length} bytes)`);
      } catch (e) {
        out.failed += 1;
        dlog(`图片下载失败: ${e?.message ?? e}`);
      }
    }
    return out;
  };

  // ---- DSH 会话事件 → 收集最终 assistant 文本，turn 结束时回发 ----
  const offEvents = ctx.on("session/event", (session, event) => {
    const p = pending.get(session?.id);
    if (!p) return;
    if (event.type === "assistant/message") {
      const turn = event.data?.turn;
      const text = (event.data?.message?.content ?? [])
        .filter((b) => b?.type === "text" && typeof b?.text === "string")
        .map((b) => b.text)
        .join("");
      if (typeof turn === "number") p.turns.set(turn, text);
    } else if (event.type === "turn/end") {
      const turn = event.data?.turn;
      const reason = event.data?.reason;
      const text = (p.turns.get(turn) ?? "").trim();
      const reply = p.reply;
      pending.delete(session.id);
      if (reason?.kind !== "completed") {
        dlog(`turn=${turn} 非正常结束: ${JSON.stringify(reason)}`);
      }
      if (reply) reply(text || "（本次没有生成文字回复）");
    }
  });

  // ---- 获取或创建该 openid 的 agent（懒加载；重启后 resume 恢复历史）----
  const getAgent = async (openid) => {
    const hit = handles.get(openid);
    if (hit) return hit.agent;
    const selection = ctx.agentDefaultModel.currentSelection();
    // setup 必须返回 undefined（见文件头注释 1、2）
    const setup = async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx);
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
    };
    const agentOptions = { provider: selection.provider, model: selection.model };
    let sessionId = openidToSession[openid];
    let handle;
    if (sessionId) {
      try {
        handle = await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup });
      } catch (e) {
        dlog(`resume 会话 ${sessionId} 失败（将新建）: ${e?.stack ?? e}`);
        ctx.logger.warn(`[qq-bot] resume 失败（将新建会话）: ${e?.message ?? e}`);
        handle = undefined;
      }
    }
    if (!handle) {
      const prevSessionId = sessionId;
      sessionId = `qq-${randomUUID()}`;
      handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd },
        agentOptions,
        setup,
      });
      openidToSession[openid] = sessionId;
      if (prevSessionId) openidToSession[`${openid}#prev`] = prevSessionId;
      saveMap(openidToSession);
      if (prevSessionId) {
        dlog(`已为 ${openid} 新建会话 ${sessionId}（旧会话 ${prevSessionId} 保留）`);
        sendToQq(openid, `[系统提示] 上次会话恢复失败，已开启新会话。旧会话（${prevSessionId.slice(0, 8)}…）的上下文不再自动带出。`, undefined);
      }
    }
    handles.set(openid, handle);
    return handle.agent;
  };

  // ---- QQ 私聊消息入口（文本 + 图片附件）----
  const onC2CMessage = async (msg) => {
    const openid = msg?.author?.user_openid ?? msg?.author?.id;
    const content = typeof msg?.content === "string" ? msg.content.trim() : "";
    const msgId = msg?.id;
    const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
    if (!openid || (!content && attachments.length === 0)) return;
    const images = await downloadImages(attachments, msgId);
    dlog(`收到私聊 ${String(openid).slice(0, 8)}…: ${content ? content.slice(0, 60) : `[图片 x${attachments.length}]`}`);
    const text = [
      content,
      images.saved.length > 0
        ? `\n[图片附件] 用户发来 ${images.saved.length} 张图片，已保存到本机（当前模型不接收图像输入，请用本地工具链处理文件）：\n${images.saved.map((f) => `- ${f}`).join("\n")}`
        : "",
      images.failed > 0 ? `\n[图片附件] 另有 ${images.failed} 张图片下载失败。` : "",
    ].join("");
    if (!text) return;
    try {
      const agent = await getAgent(openid);
      const sid = agent.id;
      if (!pending.has(sid)) pending.set(sid, { turns: new Map(), reply: null });
      const p = pending.get(sid);
      p.reply = (text) => sendToQq(openid, text, msgId);
      agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }));
    } catch (e) {
      const stack = e?.stack ?? String(e);
      ctx.logger.error(`[qq-bot] 处理失败: ${stack}`);
      dlog(`处理失败: ${stack}`);
      sendToQq(openid, `出错了：${e?.message ?? e}`, msgId);
    }
  };

  // ---- WebSocket 网关（原生实现 + 断线重连 + 心跳）----
  let ws = null;
  let heartbeatTimer = null;
  let lastSeq = null;
  let reconnectTimer = null;
  let closed = false;

  const stopHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  async function connectGateway() {
    if (closed) return;
    try {
      const token = await getAccessToken();
      const gwRes = await fetch(`${API_BASE}/gateway/bot`, {
        headers: { Authorization: `QQBot ${token}` },
      });
      if (!gwRes.ok) throw new Error(`gateway ${gwRes.status}: ${(await gwRes.text()).slice(0, 200)}`);
      const gw = await gwRes.json();
      const url = gw?.url;
      if (!url) throw new Error("gateway 未返回 wss url");
      dlog(`连接网关 ${url}`);

      ws = new WebSocket(url);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: INTENTS_C2C,
            shard: [0, 1],
            properties: { $os: "win32", $browser: "dsh-qq-bot", $device: "dsh-qq-bot" },
          },
        }));
      };
      ws.onmessage = (ev) => {
        let frame;
        try { frame = JSON.parse(String(ev.data)); } catch { return; }
        if (frame.s != null) lastSeq = frame.s;
        if (frame.op === 10) { // Hello：启动心跳
          stopHeartbeat();
          const interval = frame.d?.heartbeat_interval ?? 45000;
          heartbeatTimer = setInterval(() => {
            if (ws?.readyState === 1) ws.send(JSON.stringify({ op: 1, d: lastSeq }));
          }, interval);
        } else if (frame.op === 0) {
          if (frame.t === "READY") {
            dlog("QQ 网关 READY（开始接收私聊）");
          } else if (frame.t === "C2C_MESSAGE_CREATE") {
            onC2CMessage(frame.d);
          }
        }
      };
      ws.onclose = (ev) => {
        stopHeartbeat();
        dlog(`WebSocket 断开 (code=${ev.code})，10 秒后重连`);
        if (!closed) {
          reconnectTimer = setTimeout(() => connectGateway(), 10_000);
        }
      };
      ws.onerror = (e) => {
        dlog(`WebSocket 错误: ${e?.message ?? String(e)}`);
      };
    } catch (e) {
      dlog(`网关连接失败: ${e?.message ?? e}，30 秒后重试`);
      if (!closed) {
        reconnectTimer = setTimeout(() => connectGateway(), 30_000);
      }
    }
  }

  connectGateway();

  ctx.on("dispose", () => {
    closed = true;
    stopHeartbeat();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch { /* ignore */ }
    offEvents();
  });
}
