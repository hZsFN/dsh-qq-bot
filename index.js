// dsh-qq-bot: 把 QQ 官方机器人私聊桥接进 DSH agent 会话。
// 每个 QQ 用户对应一个持久化 DSH 会话（默认 preset），会话历史即上下文；
// dsh 重启后通过 resume 恢复历史。agent 回复经 QQ 网关发回。
//
// QQ 凭证流程（官方 api-v2，与 OpenClaw 的 qqbot 通道同源）：
//   POST https://api.bot.qq.com/app/getAppAccessToken {appId, clientSecret} → access_token（约 2 小时有效，自动刷新）
//   GET  https://api.bot.qq.com/gateway/bot  (Authorization: QQBot <token>) → wss 地址
//   WSS  Identify: { token: "QQBot <access_token>", intents: 1<<25, shard: [0,1], properties }
//   发消息: POST https://api.bot.qq.com/v2/users/<openid>/messages (QQBot <token>)
//   群聊:   POST https://api.bot.qq.com/v2/groups/<group_openid>/messages（事件 GROUP_AT_MESSAGE_CREATE）
//   群会话单独绑定：qq-grp-<group_openid 前 8 位>（挂 qqgroup 预设：只聊天、无本机工具），与私聊 qq-main-<openid 前 8 位> 互不影响
//
// 三个必须注意的 DSH 内部约定（均为实测踩坑记录）：
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
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, statSync } from "node:fs";

export const name = "qq-bot";
export const inject = ["agents", "agentPresets", "agentDefaultModel", "tools", "systemPrompt"];


// 缺省工作目录：优先环境变量 DSH_QQ_BOT_CWD，其次用户主目录下的 .deepseek harness。
// 发布版不含任何真实机器路径。
const DEFAULT_CWD = process.env.DSH_QQ_BOT_CWD || process.cwd();

export const Config = z.object({
  appId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  cwd: z.string().default(""),
  // 可选：把 QQ 会话固定绑到指定 sessionId（默认回落 qq-main-<openid前8位>）
  fixedSessionId: z.string().optional(),
  // 可选：只响应这些群（group_openid 列表）；留空 = 所有群都响应
  allowedGroups: z.array(z.string()).default([]),
  // 谁的私聊 openid 算主人（留空 = 任何私聊机器人的都算主人）；用于学习 union_openid
  ownerOpenids: z.array(z.string()).default([]),
  // 手动指定群成员 openid 白名单（可选：QQ 群消息只给匿名的 member_openid，不给昵称）
  ownerGroupMembers: z.array(z.string()).default([]),
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
// 2026-08-16 修复：boot 阶段致命错误（端口占用/插件树加载失败）必须让进程退出，
// 否则失败实例半死不活地继续抢 QQ 网关（多实例互顶 token、inactive context 报错）。
process.on("uncaughtException", (err) => {
  dlog(`uncaughtException: ${err?.stack ?? err}`);
  const msg = String(err?.stack ?? err);
  if (msg.includes("plugin tree failed to load") || msg.includes("EADDRINUSE")) {
    process.exit(1);
  }
});

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  // 凭证来源：config 优先，其次环境变量（推荐环境变量，避免密钥落盘）
  const appId = config.appId || process.env.QQ_BOT_APP_ID || "";
  const clientSecret = config.clientSecret || process.env.QQ_BOT_APP_SECRET || "";
  if (!appId || !clientSecret) {
    ctx.logger.warn(
      "[qq-bot] 未配置 appId/clientSecret（config 或 QQ_BOT_APP_ID/QQ_BOT_APP_SECRET 环境变量），插件不启用",
    );
    return;
  }

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

  // ---- 主人身份指纹（QQ 群消息不给昵称，只能靠 openid 认人）----
  // union_openid 跨私聊/群一致，member_openid 只在单个群内有效。
  const ownerFile = join(HOME_DIR, "storages", "qq-bot-owner.json");
  const loadOwner = () => {
    try {
      const o = JSON.parse(readFileSync(ownerFile, "utf8"));
      return {
        unionOpenids: Array.isArray(o.unionOpenids) ? o.unionOpenids : [],
        memberOpenids: Array.isArray(o.memberOpenids) ? o.memberOpenids : [],
      };
    } catch { return { unionOpenids: [], memberOpenids: [] }; }
  };
  const saveOwner = () => {
    try { writeFileSync(ownerFile, JSON.stringify(ownerIds, null, 2)); }
    catch (e) { ctx.logger.warn(`[qq-bot] 保存主人指纹失败: ${e?.message ?? e}`); }
  };
  const ownerIds = loadOwner();
  const rememberOwnerAuthor = (a) => {
    let changed = false;
    for (const f of ["union_openid", "member_openid"]) {
      const v = a?.[f];
      if (typeof v === "string" && v.length > 0) {
        const bucket = f === "union_openid" ? ownerIds.unionOpenids : ownerIds.memberOpenids;
        if (!bucket.includes(v)) { bucket.push(v); changed = true; }
      }
    }
    if (changed) { saveOwner(); dlog(`已记录主人身份指纹: ${JSON.stringify(ownerIds)}`); }
  };
  const isOwnerAuthor = (a) => {
    if (!a) return false;
    // 2026-10-14：QQ 群消息其实带 member_role（owner=群主）和 username，直接用它最可靠
    if (a.member_role === "owner") return true;
    const name = typeof a.username === "string" ? a.username.trim() : "";
    if (/^hZs/i.test(name)) return true;
    const u = a.union_openid, m = a.member_openid;
    return (typeof u === "string" && ownerIds.unionOpenids.includes(u))
      || (typeof m === "string" && m.length > 0
          && (ownerIds.memberOpenids.includes(m) || config.ownerGroupMembers.includes(m)));
  };

  // ---- sessionId → openid 反查（供发图工具路由到正确的 QQ 用户）----
  const openidForSession = (sid) => {
    for (const [openid, s] of Object.entries(openidToSession)) {
      if (s === sid) return openid;
    }
    return null;
  };

  // ---- live agent 与待回复状态 ----
  const handles = new Map(); // openid -> AgentHandle
  const pending = new Map(); // sessionId -> { turns: Map<turn, text>, reply: (text) => void }
  const orphanTurns = new Map(); // sessionId -> Map<turn, text>（非 QQ 私聊触发的轮次，用于自动转发）

  // target 规则：私聊 = openid 本体；群聊 = "group:<group_openid>"（与 qq-bot-sessions.json 的键一致）
  const parseTarget = (target) => {
    const s = String(target ?? "");
    return s.startsWith("group:")
      ? { kind: "group", id: s.slice(6) }
      : { kind: "user", id: s };
  };
  const apiPath = (t, tail) =>
    `${API_BASE}/v2/${t.kind === "group" ? "groups" : "users"}/${encodeURIComponent(t.id)}/${tail}`;

  const sendText = async (target, text, msgId) => {
    const t = parseTarget(target);
    try {
      const token = await getAccessToken();
      const res = await fetch(apiPath(t, "messages"), {
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

  // ---- 发送图片到 QQ 私聊（富媒体消息：上传 → msg_type=7）----
  const sendImageTo = async (target, imagePath, msgId) => {
    const t = parseTarget(target);
    const buf = readFileSync(imagePath);
    const token = await getAccessToken();
    const upRes = await fetch(apiPath(t, "files"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify({ file_type: 1, file_data: buf.toString("base64"), srv_send_msg: false }),
    });
    if (!upRes.ok) throw new Error(`上传图片失败 ${upRes.status}: ${(await upRes.text()).slice(0, 200)}`);
    const up = JSON.parse(await upRes.text());
    if (!up?.file_info) throw new Error("上传图片未返回 file_info");
    const msgRes = await fetch(apiPath(t, "messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify({
        media: { file_info: up.file_info },
        msg_type: 7,
        msg_id: msgId || "",
        msg_seq: 1,
      }),
    });
    if (!msgRes.ok) throw new Error(`发送图片失败 ${msgRes.status}: ${(await msgRes.text()).slice(0, 200)}`);
    dlog(`图片已发送(${t.kind}): ${imagePath}`);
  };

  // ---- 发送任意文件到 QQ（file_type=4：≤5MB 走 base64 直传，>5MB 走分片上传四步）----
  // 官方文档：{users|groups}/upload_prepare → 分片 PUT 预签名 URL → upload_part_finish → files 合并拿 file_info → msg_type=7
  const sendFileTo = async (target, filePath, msgId) => {
    const t = parseTarget(target);
    if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
    const st = statSync(filePath);
    if (!st.isFile()) throw new Error(`不是普通文件: ${filePath}`);
    const size = st.size;
    if (size > 200 * 1024 * 1024) throw new Error(`文件 ${(size / 1048576).toFixed(1)}MB 超过 200MB 上限`);
    const fname = basename(filePath);
    const token = await getAccessToken();
    const auth = { Authorization: `QQBot ${token}` };
    const jpost = async (tail, body, timeoutMs = 30000) => {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(apiPath(t, tail), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        const txt = await res.text();
        if (!res.ok) throw new Error(`${tail} ${res.status}: ${txt.slice(0, 300)}`);
        return txt ? JSON.parse(txt) : {};
      } finally { clearTimeout(tm); }
    };
    let fileInfo = "";
    if (size <= 5 * 1024 * 1024) {
      // 小文件：二进制直传（base64），一步到位
      const buf = readFileSync(filePath);
      const r = await jpost("files", { file_type: 4, file_name: fname, file_data: buf.toString("base64"), srv_send_msg: false }, 60000);
      fileInfo = r?.file_info;
    } else {
      // 大文件：分片上传
      const { createHash } = await import("node:crypto");
      const buf = readFileSync(filePath);
      const md5 = createHash("md5").update(buf).digest("hex");
      const sha1 = createHash("sha1").update(buf).digest("hex");
      const md5_10m = createHash("md5").update(buf.subarray(0, 10002432)).digest("hex");
      const prep = await jpost("upload_prepare", {
        file_type: 4, file_size: String(size), file_name: fname, md5, sha1, md5_10m,
      }, 60000);
      const uploadId = prep?.upload_id;
      const blockSize = Number(prep?.block_size || 5 * 1024 * 1024);
      const rawParts = Array.isArray(prep?.parts) ? prep.parts : [];
      if (!uploadId || rawParts.length === 0) throw new Error(`预上传响应异常: ${JSON.stringify(prep).slice(0, 300)}`);
      const concurrency = Math.max(1, Math.min(Number(prep?.upload_config?.concurrency || 3), 5));
      let acc = 0;
      const queue = rawParts.map((p, i) => {
        const sz = Number(p?.block_size || blockSize);
        const item = {
          idx: Number(p?.part_index ?? p?.index ?? p?.part_number ?? i + 1),
          url: p?.url ?? p?.presigned_url ?? p?.upload_url ?? p?.part_url,
          size: sz,
          start: acc,
        };
        acc += sz;
        return item;
      }).filter((p) => p.url);
      if (queue.length === 0) throw new Error("预上传未返回分片 URL");
      dlog(`发文件分片: ${fname} ${(size / 1048576).toFixed(2)}MB / ${queue.length} 片 / block=${blockSize} / 并发=${concurrency}`);
      let cursor = 0;
      const finishPart = async (item, chunk) => {
        // 官方要求带 block_size（该分块实际大小）与 md5（该分片校验值），否则服务端转存失败报 850012
        const body = {
          upload_id: uploadId,
          part_index: item.idx,
          block_size: String(chunk.length),
          md5: createHash("md5").update(chunk).digest("hex"),
        };
        let lastErr = "";
        for (let k = 0; k < 6; k++) {
          try {
            await jpost("upload_part_finish", body, 30000);
            return;
          } catch (e) {
            lastErr = e?.message ?? String(e);
            // 40093001 = 分片转存 BDH 通道异常，官方建议重试
            await new Promise((r) => setTimeout(r, 500 * (k + 1)));
          }
        }
        throw new Error(`分片 ${item.idx} 完成确认失败: ${lastErr}`);
      };
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= queue.length) return;
          const item = queue[i];
          const start = item.start;
          const chunk = buf.subarray(start, Math.min(start + item.size, size));
          const pr = await fetch(item.url, {
            method: "PUT",
            body: chunk,
            headers: { "Content-Type": "application/octet-stream" },
          });
          if (!pr.ok) throw new Error(`分片 ${item.idx} PUT 失败 ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
          await finishPart(item, chunk);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      const done = await jpost("files", { upload_id: uploadId, file_name: fname }, 180000);
      fileInfo = done?.file_info;
    }
    if (!fileInfo) throw new Error("上传未返回 file_info");
    const msgRes = await fetch(apiPath(t, "messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ media: { file_info: fileInfo }, msg_type: 7, msg_id: msgId || "", msg_seq: 1 }),
    });
    if (!msgRes.ok) throw new Error(`发送文件失败 ${msgRes.status}: ${(await msgRes.text()).slice(0, 200)}`);
    dlog(`文件已发送(${t.kind}): ${filePath} (${size} B)`);
  };

  // ---- 下载 QQ 图片附件到 agent 工作目录（纯文本模型也能通过文件工具处理）----
  const IMAGE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "application/x-7z-compressed": ".7z",
    "application/x-rar-compressed": ".rar",
    "application/json": ".json",
    "application/octet-stream": ".bin",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "text/html": ".html",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
  };
  const isImageCt = (ct) => String(ct || "").startsWith("image/");
  const downloadImages = async (attachments, msgId, prefix = "qq") => {
    const cwd = config.cwd || DEFAULT_CWD;
    const inbox = join(cwd, "inbox");
    const out = { saved: [], failed: 0 };
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const ct = att?.content_type ?? "";
      const fname = att?.filename ?? att?.file_name ?? "";
      const url = att?.url;
      if (!url) continue;
      const ext = IMAGE_EXT[ct] || extname(String(fname)) || extname(String(url).split("?")[0]) || (isImageCt(ct) ? ".img" : ".bin");
      try {
        // [patch 2026-10-18 by 大肥鱼] 原来是 20s 单次硬超时，大图/慢网必失败
        // （2026-10-18 一天失败 4 次）。现在：60s 超时 + 最多 3 次重试（间隔 1s/2s），
        // 文件较小，整体重下比断点续传简单可靠，鉴权头兜底逻辑保留。
        const hostOf = (u) => {
          try {
            return new URL(u).hostname;
          } catch {
            return "?";
          }
        };
        const fetchOnce = async (u, headers, timeoutMs) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await fetch(u, { signal: controller.signal, ...(headers ? { headers } : {}) });
          } finally {
            clearTimeout(timer);
          }
        };
        const fetchWithRetry = async (u) => {
          const delays = [0, 1000, 2000];
          let lastErr;
          for (let attempt = 0; attempt < delays.length; attempt += 1) {
            if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
            const t0 = Date.now();
            try {
              // [patch 2026-10-19 by 大肥鱼] 带鉴权头优先。
              // QQ 富媒体 URL 对无鉴权请求常先挂起十几秒才回（10-19 实测单图 19s），
              // 原来的「先裸请求、失败了再带 token」等于每张图白等一整轮。
              const token = await getAccessToken();
              let r = await fetchOnce(u, { Authorization: `QQBot ${token}` }, 30_000);
              if (!r.ok) {
                // 兜底：少数 URL 是公开的，带 token 被拒就裸试一次（最坏与旧逻辑等价）
                r = await fetchOnce(u, null, 30_000);
              }
              if (r.ok) {
                dlog(`附件响应 ${r.status} 耗时 ${Date.now() - t0}ms host=${hostOf(u)}`);
                return r;
              }
              lastErr = new Error(`HTTP ${r.status}`);
            } catch (e) {
              lastErr = e;
            }
            dlog(
              `附件下载重试 ${attempt + 1}/${delays.length} 耗时 ${Date.now() - t0}ms host=${hostOf(u)}: ${lastErr?.message ?? lastErr}`,
            );
          }
          throw lastErr ?? new Error("download failed");
        };
        const res = await fetchWithRetry(url);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error("empty body");
        mkdirSync(inbox, { recursive: true });
        const stamp = String(msgId || Date.now()).replace(/[^a-zA-Z0-9]/g, "").slice(-16);
        const file = join(inbox, `${prefix}-${stamp}-${i}${ext}`);
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
  // [patch 2026-10-03 by 大肥鱼] 原实现只在 pending 存在（即本条消息来自 QQ 私聊）时才回发，
  // 于由心跳投递 / 定时任务 / 其他插件触发、或主人在 GUI 里直接对话的轮次一律静默 —— 心跳说的话
  // 只能留在 DSH 里，到不了 QQ。现在：非 QQ 私聊触发的轮次，只要该会话映射到某个 openid，
  // 就走「主动发」（sendText(openid, text, undefined)）把最终文本转发到 QQ。
  const offEvents = ctx.on("session/event", (session, event) => {
    const sid = session?.id;
    if (!sid) return;
    const p = pending.get(sid);
    if (event.type === "assistant/message") {
      const turn = event.data?.turn;
      const text = (event.data?.message?.content ?? [])
        .filter((b) => b?.type === "text" && typeof b?.text === "string")
        .map((b) => b.text)
        .join("");
      if (typeof turn !== "number") return;
      if (p) {
        p.turns.set(turn, text);
      } else {
        let m = orphanTurns.get(sid);
        if (!m) { m = new Map(); orphanTurns.set(sid, m); }
        m.set(turn, text);
      }
      return;
    }
    if (event.type !== "turn/end") return;
    const turn = event.data?.turn;
    const reason = event.data?.reason;
    if (p) {
      const text = (p.turns.get(turn) ?? "").trim();
      const reply = p.reply;
      pending.delete(sid);
      if (reason?.kind !== "completed") {
        dlog(`turn=${turn} 非正常结束: ${JSON.stringify(reason)}`);
      }
      if (reply) reply(text || "（本次没有生成文字回复）");
      return;
    }
    const m = orphanTurns.get(sid);
    if (!m) return;
    const text = (m.get(turn) ?? "").trim();
    m.delete(turn);
    if (m.size === 0) orphanTurns.delete(sid);
    if (!text) { dlog(`turn=${turn} 无文本，跳过自动转发`); return; }
    const openid = openidForSession(sid);
    if (!openid) return;
    dlog(`自动转发到 QQ（turn=${turn}）: ${text.slice(0, 40)}`);
    sendText(openid, text, undefined);
  });

  // 群会话工具面白名单（2026-10-14）：群里只给联网工具，别的都不给。
  const QQ_TOOL_ALLOW = new Set(["web_search", "web_fetch"]);

  // ---- 会话 id 规则：私聊 qq-main-<openid 前 8 位>（可用 fixedSessionId 覆盖）；群聊 qq-grp2-<group_openid 前 8 位> ----
  // 2026-10-14：群前缀由 qq-grp- 升为 qq-grp2-。旧 qq-grp-* 会话是在 qqgroup 预设尚未注册时创建的，
  // 落成了「没有基线工具」的坏会话（DeepSeek 报 tools: at least one tool must have defer_loading=false，
  // 之后每轮 turn/end blocked）。换前缀让它们自然作废，群消息会在预设已生效的当下重建干净会话。
  const sessionIdFor = (key) => {
    const s = String(key ?? "");
    if (s.startsWith("group:")) return `qq-grp2-${s.slice(6, 14)}`;
    return config.fixedSessionId || `qq-main-${s.slice(0, 8)}`;
  };

  // qqgroup 预设是否已注册。改动 cordis.patch.yml 后需要重启 dsh web 才会注册，
  // 未注册时群会话回退到默认预设，避免 create 直接失败（点「重启」不影响私聊）。
  const hasQqgroupPreset = async () => {
    let ready = false;
    try {
      const roster = await ctx.agentPresets.list();
      ready =
        Array.isArray(roster) &&
        roster.some((p) => String((p && (p.id ?? p)) ?? "") === "qqgroup");
    } catch {
      ready = false;
    }
    dlog(`[preset] qqgroup registered=${ready}`);
    if (!ready) {
      ctx.logger?.info?.(
        "qqgroup 预设尚未注册（改 cordis.patch.yml 后需重启 dsh web）；群会话暂用默认预设",
      );
    }
    return ready;
  };

  // ---- 获取或创建该 key 的 agent（懒加载；重启后 resume 恢复历史）----
  // 2026-08-16 改：会话 id 固定为 qq-main-<openid前8位>，不再随 randomUUID 换来换去；
  // 旧会话 id 首次使用时一次性迁移（旧会话保留为 #prev 存档）。
  const getAgent = async (openid) => {
    const hit = handles.get(openid);
    if (hit) return hit.agent ?? hit;
    // 先查 DSH 全局 live agents：会话可能已被 GUI/其他插件 selectModel 激活，
    // 此时直接复用 live 句柄，避免 resume 报 "cannot prepare session while it is live"
    // 或 create 报 "session already exists"。
    const liveTarget = sessionIdFor(openid);
    for (const agent of (ctx.agents.list?.() ?? [])) {
      if (agent?.id === liveTarget) {
        dlog(`复用 live 会话 ${liveTarget}（已被外部激活）`);
        handles.set(openid, agent);
        return agent;
      }
    }
    const selection = ctx.agentDefaultModel.currentSelection();
    const isGroupSession = String(openid).startsWith("group:");
    // setup 必须返回 undefined（见文件头注释 1、2）
    const setup = async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx);
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
      if (!isGroupSession) return;
      // 群会话工具面守卫：钩子注册在 agent 作用域内（dsh-scope 会把 assembly 限制到本作用域），
      // 只裁本会话的工具面，不会影响私聊/GUI 会话。
      agentCtx.on("system-prompt/assemble", async (assembly, _ctxInfo, next) => {
        const out = await next();
        const all = Array.isArray(out && out.tools) ? out.tools : [];
        const picked = all.filter((tool) => QQ_TOOL_ALLOW.has(tool && tool.name));
        dlog(`[guard] toolsIn=${all.length} picked=${picked.length} names=${all.map((t) => t && t.name).slice(0, 20).join("|")}`);
        if (!picked.length) return out;
        return { ...out, tools: picked };
      });
    };
    const agentOptions = { provider: selection.provider, model: selection.model };
    const fixedId = sessionIdFor(openid);
    const mappedId = openidToSession[openid];
    // 迁移：映射里的旧会话 id 与固定 id 不一致 → 改指向固定 id（旧会话保留为 prev）
    if (mappedId && mappedId !== fixedId) {
      openidToSession[openid] = fixedId;
      openidToSession[`${openid}#prev`] = mappedId;
      saveMap(openidToSession);
      dlog(`会话迁移: ${mappedId} → ${fixedId}（旧会话保留为 prev）`);
      sendText(openid, `[系统提示] QQ 会话已固定为 ${fixedId}，旧会话（${mappedId.slice(0, 8)}…）保留存档。`, undefined);
    }
    let sessionId = fixedId;
    let handle;
    try {
      handle = await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup });
    } catch (e) {
      dlog(`resume 会话 ${sessionId} 失败（按固定 id 新建）: ${e?.stack ?? e}`);
      ctx.logger.warn(`[qq-bot] resume 失败（按固定 id 新建）: ${e?.message ?? e}`);
      handle = undefined;
    }
    if (!handle) {
      const prevSessionId = openidToSession[openid];
      sessionId = fixedId;
      handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: {
          cwd: config.cwd || DEFAULT_CWD,
          // 群会话挂 qqgroup 预设（只聊天、不碰本机）；私聊不指定 → 用默认 dafeiyu
          ...(String(openid).startsWith("group:") && (await hasQqgroupPreset())
            ? { agentPreset: "qqgroup" }
            : {}),
        },
        agentOptions,
        setup,
      });
      openidToSession[openid] = sessionId;
      if (prevSessionId && prevSessionId !== sessionId) openidToSession[`${openid}#prev`] = prevSessionId;
      saveMap(openidToSession);
      if (prevSessionId && prevSessionId !== sessionId) {
        dlog(`已为 ${openid} 新建固定会话 ${sessionId}（旧会话 ${prevSessionId} 保留）`);
        sendText(openid, `[系统提示] 上次会话恢复失败，已开启新会话。旧会话（${prevSessionId.slice(0, 8)}…）的上下文不再自动带出。`, undefined);
      } else {
        dlog(`已为 ${openid} 创建固定会话 ${sessionId}`);
      }
    }
    handles.set(openid, handle);
    return handle.agent;
  };

  // ---- 消息入口（私聊 C2C + 群 @），文本 + 图片附件 ----
  const onIncomingMessage = async (kind, msg) => {
    const isGroup = kind === "group";
    const author = msg?.author ?? {};
    const peerId = isGroup
      ? (msg?.group_openid ?? msg?.group_id)
      : (author.user_openid ?? author.id);
    if (!peerId) return;
    // QQ 群消息不带昵称，只能靠 openid 认人；先把发送者字段记进日志，便于排查
    dlog(`[author] kind=${kind} ${JSON.stringify(author)}`);
    // 群聊：官方只推 @机器人 的消息；content 里可能带 <@!xxx> 提及标记，清掉再喂给模型
    const content = (typeof msg?.content === "string" ? msg.content : "")
      .replace(/<@!?\d+>/g, "")
      .trim();
    const target = isGroup ? `group:${peerId}` : peerId;
    if (isGroup && Array.isArray(config.allowedGroups) && config.allowedGroups.length > 0
        && !config.allowedGroups.includes(String(peerId))) {
      dlog(`群 ${String(peerId).slice(0, 8)}… 不在 allowedGroups 白名单，忽略`);
      return;
    }
    const msgId = msg?.id;
    const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
    if (!content && attachments.length === 0) return;
    const images = await downloadImages(attachments, msgId, isGroup ? "qqg" : "qq");
    // 认主人：群消息靠指纹比对；私聊则视为主人并顺手学习指纹
    let fromOwner = false;
    if (isGroup) {
      fromOwner = isOwnerAuthor(author);
    } else if (config.ownerOpenids.length === 0 || config.ownerOpenids.includes(String(peerId))) {
      rememberOwnerAuthor(author);
      fromOwner = true;
    }
    const speakerTag = isGroup ? (fromOwner ? "【来自主人】\n" : "【来自群友·身份未确认】\n") : "";
    dlog(`收到${isGroup ? "群聊" : "私聊"} ${String(peerId).slice(0, 8)}…${isGroup ? (fromOwner ? " [主人]" : " [群友]") : ""}: ${content ? content.slice(0, 60) : `[图片 x${attachments.length}]`}`);
    const text = [
      speakerTag + content,
      images.saved.length > 0
        ? `\n[附件] 用户发来 ${images.saved.length} 个文件，已保存到本机，请直接读取（图片用 read_image；其他按类型用相应工具），不要问主人要干什么：\n${images.saved.map((f) => `- ${f}`).join("\n")}`
        : "",
      images.failed > 0 ? `\n[附件] 另有 ${images.failed} 个文件下载失败。` : "",
    ].join("");
    if (!text) return;
    try {
      const agent = await getAgent(target);
      const sid = agent.id;
      if (!pending.has(sid)) pending.set(sid, { turns: new Map(), reply: null });
      const p = pending.get(sid);
      p.reply = (t) => sendText(target, t, msgId);
      agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }));
    } catch (e) {
      const stack = e?.stack ?? String(e);
      ctx.logger.error(`[qq-bot] 处理失败: ${stack}`);
      dlog(`处理失败: ${stack}`);
      sendText(target, `出错了：${e?.message ?? e}`, msgId);
    }
  };
  const onC2CMessage = (msg) => onIncomingMessage("c2c", msg);
  const onGroupMessage = (msg) => onIncomingMessage("group", msg);

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
            dlog("QQ 网关 READY（开始接收私聊与群 @）");
          } else if (frame.t === "C2C_MESSAGE_CREATE") {
            onC2CMessage(frame.d);
          } else if (frame.t === "GROUP_AT_MESSAGE_CREATE") {
            onGroupMessage(frame.d);
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

  // ---- 工具：QQ 发图（qq-send-image）----
  ctx.tools.register(defineTool({
    name: "qq-send-image",
    description:
      "把本地图片文件发送到 QQ（QQ 富媒体消息）。" +
      "优先发给当前 QQ 会话对应的用户；主会话（GUI）等没有 QQ 映射的场景，" +
      "自动回退到 qq-bot-sessions.json 里已绑定的 QQ 用户 —— 因此任意会话都能主动发图。" +
      "参数 imagePath 为图片文件的本地绝对路径（png/jpg/jpeg/gif/webp）。",
    parameters: {
      imagePath: {
        type: "string",
        required: true,
        description: "要发送的图片文件本地绝对路径（png/jpg/jpeg/gif/webp）",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否发送成功" },
          message: { type: "string", required: true, description: "结果说明（成功提示或错误信息）" },
        },
      },
      // 纯文本渲染：把结构化结果转成模型/用户可读文字
      render: (_args, value) => {
        const icon = value?.ok ? "✅" : "❌";
        return [{ type: "text", text: `${icon} ${value?.message ?? "未知结果"}` }];
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sid = exec?.agent?.id;
      let openid = sid ? openidForSession(sid) : null;
      // 2026-09-13：主会话（GUI）不在 QQ 映射里 → 回退到映射中的默认用户，
      // 让 agent 在任意会话都能主动把图发到主人手机 QQ（与 qq-send-message 对齐）。
      if (!openid) {
        const keys = Object.keys(openidToSession).filter((k) => k && !k.includes("#") && !k.startsWith("group:"));
        if (keys.length > 0) {
          openid = keys[0];
          dlog(`qq-send-image: 当前会话无 QQ 映射，回退默认用户 ${openid.slice(0, 8)}…`);
        }
      }
      if (!openid) {
        return { ok: false, message: "找不到可用的 QQ 用户（当前会话不是 QQ 私聊，且 qq-bot-sessions.json 里也没有已绑定用户）。" };
      }
      const path = String(args?.imagePath ?? "").trim();
      if (!path) return { ok: false, message: "缺少 imagePath 参数。" };
      try {
        await sendImageTo(openid, path, undefined);
        return { ok: true, message: `图片已发送到 QQ：${path}` };
      } catch (e) {
        dlog(`发图失败: ${e?.stack ?? e}`);
        return { ok: false, message: `QQ 发图失败：${e?.message ?? e}` };
      }
    },
  }));

  // ---- 工具：QQ 发文件（qq-send-file）----
  ctx.tools.register(defineTool({
    name: "qq-send-file",
    description:
      "把本地文件（任意类型：文档、压缩包、音视频等）发送到 QQ，对方会收到可下载的文件卡片。" +
      "≤5MB 走二进制直传，>5MB 自动分片上传；上限 200MB（QQ 官方硬限制）。" +
      "优先发给当前 QQ 会话对应的用户；主会话（GUI）等没有 QQ 映射的场景，" +
      "自动回退到 qq-bot-sessions.json 里已绑定的 QQ 用户 —— 因此任意会话都能主动发文件。" +
      "也可用 toOpenid 指定其他 QQ 用户或群。",
    parameters: {
      filePath: {
        type: "string",
        required: true,
        description: "要发送的文件的本地绝对路径",
      },
      toOpenid: {
        type: "string",
        description: "可选目标用户 openid；缺省发给当前 QQ 会话的用户（或映射里已绑定的用户）。qqbot:{openid} 或 group:{group_openid} 形式也可",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否发送成功" },
          message: { type: "string", required: true, description: "结果说明（成功提示或错误信息）" },
        },
      },
      render: (_args, value) => {
        const icon = value?.ok ? "✅" : "❌";
        return [{ type: "text", text: `${icon} ${value?.message ?? "未知结果"}` }];
      },
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sid = exec?.agent?.id;
      const explicit = String(args?.toOpenid ?? "").trim();
      let openid = explicit || (sid ? openidForSession(sid) : null);
      if (!openid) {
        const keys = Object.keys(openidToSession).filter((k) => k && !k.includes("#") && !k.startsWith("group:"));
        if (keys.length > 0) {
          openid = keys[0];
          dlog(`qq-send-file: 当前会话无 QQ 映射，回退默认用户 ${openid.slice(0, 8)}…`);
        }
      }
      if (!openid) {
        return { ok: false, message: "找不到可用的 QQ 用户（当前会话不是 QQ 私聊，且 qq-bot-sessions.json 里也没有已绑定用户）。" };
      }
      const path = String(args?.filePath ?? "").trim();
      if (!path) return { ok: false, message: "缺少 filePath 参数。" };
      try {
        await sendFileTo(openid, path, undefined);
        return { ok: true, message: `文件已发送到 QQ：${path}` };
      } catch (e) {
        dlog(`发文件失败: ${e?.stack ?? e}`);
        return { ok: false, message: `QQ 发文件失败：${e?.message ?? e}` };
      }
    },
  }));

  // ---- 工具：QQ 主动发文字（qq-send-message）----
  // 与 qq-send-image 的关键差别：不依赖「当前会话来自 QQ」。
  // openid 直接从持久化映射解析，所以主会话（GUI）也能主动给主人发 QQ ——
  // 用途：主人外出（开会/上课/路上）时的主动联系。
  ctx.tools.register(defineTool({
    name: "qq-send-message",
    description:
      "主动给 QQ 私聊用户发送文字消息（不要求当前会话来自 QQ）。" +
      "缺省发给 qq-bot-sessions.json 里已绑定的 QQ 用户；" +
      "仅在需要发给别的用户时才传 toOpenid。",
    parameters: {
      text: { type: "string", required: true, description: "要发送的纯文字内容" },
      toOpenid: { type: "string", description: "可选目标 openid；缺省用映射中的默认用户" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否发送成功" },
          message: { type: "string", required: true, description: "结果说明（成功提示或错误信息）" },
        },
      },
      render: (_args, value) => {
        const icon = value?.ok ? "✅" : "❌";
        return [{ type: "text", text: `${icon} ${value?.message ?? "未知结果"}` }];
      },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args?.text ?? "").trim();
      if (!text) return { ok: false, message: "缺少 text 参数。" };
      let openid = String(args?.toOpenid ?? "").trim() || null;
      if (!openid) {
        // 映射里除 openid 本体，还有 "openid#prev" 这类派生键，只取本体
        const keys = Object.keys(openidToSession).filter((k) => k && !k.includes("#") && !k.startsWith("group:"));
        if (keys.length === 0) {
          return { ok: false, message: "还没有任何 QQ 用户与本机绑定（qq-bot-sessions.json 为空），无法主动发送。" };
        }
        openid = keys[0];
        if (keys.length > 1) dlog(`qq-send-message: 映射里有 ${keys.length} 个用户，默认取第一个 ${openid.slice(0, 8)}…`);
      }
      try {
        await sendText(openid, text, undefined);
        dlog(`qq-send-message: 已主动发送给 ${openid.slice(0, 8)}… (${text.slice(0, 40)})`);
        return { ok: true, message: `文字已发送到 QQ（${openid.slice(0, 8)}…）` };
      } catch (e) {
        dlog(`qq-send-message 失败: ${e?.stack ?? e}`);
        return { ok: false, message: `QQ 发消息失败：${e?.message ?? e}` };
      }
    },
  }));

  // 群会话工具面守卫已移到 getAgent() 的 setup 里（2026-10-14）。
  // 旧写法是顶层 ctx.on("system-prompt/assemble") + context.agent.session 取会话 id，
  // 但 AssembleContext 实际只有 { scope?, signal? }，取到的 sid 恒为空串 → 守卫从未生效。
  // 白名单常量 QQ_TOOL_ALLOW（web_search / web_fetch）声明在本函数末尾。
  // 启动探测：插件（重）加载时确认 qqgroup 预设是否已在 registry 里，写进 qq-bot.log 便于排查
  setTimeout(() => {
    hasQqgroupPreset()
      .then(() => dlog("[preset] 启动探测完成"))
      .catch((e) => dlog(`[preset] 启动探测失败: ${e?.message ?? e}`));
  }, 1500);

  ctx.on("dispose", () => {
    closed = true;
    stopHeartbeat();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch { /* ignore */ }
    offEvents();
  });
}
