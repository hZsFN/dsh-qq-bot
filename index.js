// dsh-qq-bot: 把 QQ 桥接进 DSH agent 会话（双后端）。
// 每个 QQ 用户/群对应一个持久化 DSH 会话（默认 preset），会话历史即上下文；
// dsh 重启后通过 resume 恢复历史。agent 回复经当前后端发回。
//
// [2026-10-26 by 大肥鱼] 新增 backend 配置，一套插件两种后端：
//   backend=official（默认）：QQ 官方机器人（api.bot.qq.com），要 appId/clientSecret
//   backend=onebot          ：NapCat / SnowLuma / LLOneBot 等 OneBot v11 实现，用 QQ 号登录，
//                             走 OneBot HTTP API 发送 + HTTP 上报（或正向 WS）接收
// 两种后端共用同一套下游：会话映射、主人识别、附件下载、agent 懒加载、回发分派。
// 分派点是同名的 sendText / sendImageTo / sendFileTo；收消息侧由 OneBot 事件归一成
// 「伪官方事件」再交给 onIncomingMessage，所以下游一行都不用改。
//
// QQ 凭证流程（官方 api-v2，与 OpenClaw 的 qqbot 通道同源）：
//   POST https://api.bot.qq.com/app/getAppAccessToken {appId, clientSecret} → access_token（约 2 小时有效，自动刷新）
//   GET  https://api.bot.qq.com/gateway/bot  (Authorization: QQBot <token>) → wss 地址
//   WSS  Identify: { token: "QQBot <access_token>", intents: 1<<25, shard: [0,1], properties }
//   发消息: POST https://api.bot.qq.com/v2/users/<openid>/messages (QQBot <token>)
//   群聊:   POST https://api.bot.qq.com/v2/groups/<group_openid>/messages（事件 GROUP_AT_MESSAGE_CREATE）
//   群会话单独绑定：qq-grp-<group_openid 前 8 位>（挂 qqgroup 预设：只聊天、无本机工具），与私聊 qq-main-<openid 前 8 位> 互不影响
//
// OneBot 流程（backend=onebot，NapCat/SnowLuma 本机跑）：
//   发送: POST {onebot.apiBase}/send_private_msg | send_group_msg | upload_group_file | upload_private_file
//         Authorization: Bearer <onebot.accessToken>
//   接收: OneBot 配「HTTP 上报」→ http://{listenHost}:{listenPort}/{listenPath}（可带 secret 校验）
//         或 onebot.events=ws 时主动连正向 WebSocket（token 走 ?access_token=）
//   身份: 私聊 target = "<QQ号>"，群 target = "group:<群号>"；群消息默认只有 @ 机器人才响应（atOnly）
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
import { fileURLToPath } from "node:url";

export const name = "qq-bot";
export const inject = ["agents", "agentPresets", "agentDefaultModel", "tools", "systemPrompt"];

export const Config = z.object({
  // 后端选择：official = QQ 官方机器人（api.bot.qq.com）；onebot = NapCat / SnowLuma 等 OneBot v11 实现
  backend: z.enum(["official", "onebot"]).default("official"),
  // 官方机器人凭证（backend=official 时必填；onebot 模式可留空）
  appId: z.string().optional(),
  clientSecret: z.string().optional(),
  enabled: z.boolean().default(true),
  cwd: z.string().default(""),
  // [2026-10-26] QQ 会话挂哪个 agent preset：留空 = 群用 qqgroup、私聊用默认 dafeiyu；填 qqgroup 则私聊也用群聊预设
  preset: z.string().default(""),
  // 运行时配置文件路径；留空 = 插件目录下的 runtime-config.json
  runtimeConfig: z.string().default(""),
  // 可选：把 QQ 会话固定绑到指定 sessionId（默认回落 qq-main-<openid前8位>）
  fixedSessionId: z.string().optional(),
  // 可选：只响应这些群（group_openid 列表）；留空 = 所有群都响应
  allowedGroups: z.array(z.string()).default([]),
  // 谁的私聊 openid 算主人（留空 = 任何私聊机器人的都算主人）；用于学习 union_openid
  ownerOpenids: z.array(z.string()).default([]),
  // 手动指定群成员 openid 白名单（可选：QQ 群消息只给匿名的 member_openid，不给昵称）
  ownerGroupMembers: z.array(z.string()).default([]),
  // ---- OneBot v11 后端（backend=onebot 时生效）----
  // [2026-10-26 by 大肥鱼] 新增：让本插件同时支持 NapCat / SnowLuma 这类 OneBot 实现，
  // 用 QQ 小号登录收消息，不再受官方机器人「群里只推 @消息」「openid 与 QQ 号无关」的限制。
  onebot: z.object({
    // OneBot HTTP API 地址（发送消息走这里）
    apiBase: z.string().default("http://127.0.0.1:3000"),
    // OneBot 的 access_token（Authorization: Bearer）；后端没设就留空
    accessToken: z.string().default(""),
    // 机器人自己的 QQ 号：用于识别群里是否 @ 了自己、以及过滤自发消息（防回环）
    selfId: z.string().default(""),
    // 事件来源：http = 我们起服务端收 OneBot 的 HTTP 上报（最稳）；ws = 主动连 OneBot 的正向 WebSocket
    events: z.enum(["http", "ws"]).default("http"),
    // events=http 时监听的地址/端口/路径（只绑本机；把 OneBot 的「HTTP 上报」指到这里）
    listenHost: z.string().default("127.0.0.1"),
    listenPort: z.number().int().min(1).max(65535).default(3200),
    listenPath: z.string().default("/onebot"),
    // 上报签名密钥（OneBot 的 secret；留空 = 不校验）
    secret: z.string().default(""),
    // events=ws 时的 WebSocket 地址；留空则由 apiBase 推算（http://127.0.0.1:3000 → ws://127.0.0.1:3001）
    wsUrl: z.string().default(""),
    // [2026-10-26] events=ws 专用 token：协议端 HTTP 与 WS 两套 token 不同时用这个，留空则回退 accessToken
    wsToken: z.string().default(""),
    // 群里是否只有 @ 机器人才回（官方机器人就是这个语义；想全量收群消息就设 false）
    atOnly: z.boolean().default(true),
    // 群里没 @ 我时的接话冷却（秒）：0 = 不冷却。@ 我或引用我的消息不受此限制
    groupCooldownSec: z.number().default(0),
    // 群里没 @ 我时，只有文本里出现这些词才接（区分大小写不敏感）；留空数组 = 不按关键词过滤
    groupKeywords: z.array(z.string()).default(["肥鱼"]),
    // 主人 QQ 号白名单（OneBot 给的是真实 QQ 号，比 openid 指纹可靠）
    ownerUsers: z.array(z.string()).default([]),
  }).default({}),
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
  // 后端分派：official（官方机器人）/ onebot（NapCat、SnowLuma 等 OneBot v11 实现）
  let backend = config.backend === "onebot" ? "onebot" : "official";
  let obCfg = {
    apiBase: "http://127.0.0.1:3000",
    accessToken: "",
    selfId: "",
    events: "http",
    listenHost: "127.0.0.1",
    listenPort: 3200,
    listenPath: "/onebot",
    secret: "",
    wsUrl: "",
    wsToken: "",
    atOnly: true,
    groupCooldownSec: 0,
    groupKeywords: ["肥鱼"],
    ownerUsers: [],
    ...(config.onebot || {}),
  };
  if (backend === "official" && (!config.appId || !config.clientSecret)) {
    ctx.logger.warn("[qq-bot] backend=official 但未配置 appId/clientSecret，插件不启用");
    return;
  }
  if (backend === "onebot" && !obCfg.selfId) {
    ctx.logger.warn("[qq-bot] backend=onebot 但未配置 onebot.selfId（机器人自己的 QQ 号）：@ 识别与防回环会失效");
  }
  dlog(`插件启动: backend=${backend}${backend === "onebot" ? ` events=${obCfg.events} api=${obCfg.apiBase} self=${obCfg.selfId || "?"}` : ""}`);

  // ---- 运行时配置（独立文件 + 定时热读）----
  // [2026-10-26 by 大肥鱼] 起因：本 profile 改 cordis.patch.yml 必须重启 DSH 才生效
  // （实测：改 backend 后 26 秒零重载）。做法：常用项挪到独立 JSON，插件每 3 秒 stat 一次，
  // 变了就热应用；patch 里只留最小启动配置。
  // 支持热改：backend / preset / onebot.{apiBase,accessToken,wsToken,wsUrl,selfId,events,
  //           listenHost,listenPort,listenPath,secret,atOnly,groupKeywords,groupCooldownSec,ownerUsers}
  let presetValue = String(config.preset || "").trim();
  const runtimeFile = (() => {
    try {
      if (config.runtimeConfig) return String(config.runtimeConfig);
      return join(fileURLToPath(new URL(".", import.meta.url)), "runtime-config.json");
    } catch (e) {
      dlog(`运行时配置路径解析失败: ${e?.message ?? e}`);
      return "";
    }
  })();
  let runtimeStamp = "";
  let runtimeTimer = null;
  let runtimeMissingWarned = false;

  // ---- access_token 管理（提前 5 分钟刷新）----
  let tokenCache = { token: "", expiresAt: 0 };
  async function getAccessToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
      return tokenCache.token;
    }
    const res = await fetch(`${API_BASE}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
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
    // [2026-10-26] OneBot 后端专用判据：只认 onebot.ownerUsers 里列出的真实 QQ 号。
    // 关键差异：OneBot 的 member_role="owner" 意思是「群主」，不是「主人」——沿用官方那套
    // 会让任何一个群主白拿本机工具权限，所以这里必须换判据，且白名单为空就谁都不算。
    if (backend === "onebot") {
      const uid = String(a.member_openid ?? a.user_openid ?? a.union_openid ?? "");
      return uid !== "" && obCfg.ownerUsers.includes(uid);
    }
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

  // 官方后端：发文字（msg_id 用于被动回复，QQ 要求带上被回复消息 id）
  // [patch 2026-10-27 by 大肥鱼] 原来非 2xx 只 warn 不抛，qq-send-message 永远报「已发送」；
  // 实测把 QQ 号当 openid 时接口返回 400 {"code":11255,"err_code":40011028,"message":"请求的资源不存在(用户/群已注销)"}，主人一条也没收到。
  // 现在如实抛错——所有调用点（811/841/931/941/1581 等）本来就有 catch。
  const officialSendText = async (target, text, msgId) => {
    const t = parseTarget(target);
    let token;
    try {
      token = await getAccessToken();
    } catch (e) {
      ctx.logger.warn(`[qq-bot] 取 access_token 异常: ${e?.message ?? e}`);
      throw new Error(`取 access_token 失败: ${e?.message ?? e}`);
    }
    let res;
    try {
      res = await fetch(apiPath(t, "messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify({ content: text, msg_type: 0, msg_id: msgId || "", msg_seq: 1 }),
      });
    } catch (e) {
      ctx.logger.warn(`[qq-bot] 发送请求异常: ${e?.message ?? e}`);
      throw new Error(`发送请求异常: ${e?.message ?? e}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = `发送失败 ${res.status}: ${body.slice(0, 200)}`;
      ctx.logger.warn(`[qq-bot] ${msg}`);
      throw new Error(msg);
    }
  };

  // ---- 发送图片到 QQ 私聊（富媒体消息：上传 → msg_type=7）----
  // 官方后端：发图片（上传 → msg_type=7 富媒体）
  const officialSendImageTo = async (target, imagePath, msgId) => {
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
  // 官方后端：发任意文件（≤5MB base64 直传，>5MB 分片四步）
  const officialSendFileTo = async (target, filePath, msgId) => {
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

  // ================= OneBot v11 后端（NapCat / SnowLuma / LLOneBot 等）=================
  // [2026-10-26 by 大肥鱼] 新增第二个后端，与官方机器人后端并存，靠下面的同名分派器切换。
  // 设计要点：
  //   1. 只依赖 OneBot v11 标准（HTTP API + HTTP 上报，可选正向 WS），不绑定任何具体实现；
  //   2. 收消息侧：OneBot 事件先归一成「伪官方事件」，再交给 onIncomingMessage ——
  //      会话映射、主人识别、附件下载、agent 懒加载、分派回复全部沿用官方那套，不重写；
  //   3. 发送侧：target 语义与官方一致（私聊 "<QQ号>"、群 "group:<群号>"），调用点无需感知后端。
  // OneBot 端需要开启的 HTTP API：send_private_msg / send_group_msg /
  //   upload_group_file / upload_private_file / get_login_info。
  let obBase = String(obCfg.apiBase || "").replace(/\/+$/, "");

  // 调 OneBot HTTP API（统一超时与错误；个别实现把错误塞在 body.retcode 里）
  const obApi = async (action, payload = {}, timeoutMs = 30000) => {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${obBase}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(obCfg.accessToken ? { Authorization: `Bearer ${obCfg.accessToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`${action} HTTP ${res.status}: ${txt.slice(0, 300)}`);
      let j = null;
      try { j = txt ? JSON.parse(txt) : null; } catch { j = null; }
      if (j && typeof j.retcode === "number" && j.retcode !== 0 && j.status !== "ok") {
        throw new Error(`${action} retcode=${j.retcode} ${String(j.message ?? j.wording ?? "").slice(0, 200)}`);
      }
      return j ?? {};
    } finally { clearTimeout(tm); }
  };

  // 自己发出去的消息 id 集合：用来识别「别人引用我的话」——群里不带 @ 也算在跟我说话，
  // 否则 atOnly=true 时只要对方点了「回复」而不是 @，消息就被无视了。
  const obSentIds = new Set();
  const obRememberSent = (r) => {
    const id = r?.data?.message_id;
    if (id == null) return;
    obSentIds.add(String(id));
    if (obSentIds.size > 300) obSentIds.delete(obSentIds.values().next().value);
  };

  const obTarget = (target) => {
    const t = parseTarget(target);
    return t.kind === "group"
      ? { kind: "group", id: t.id, action: "send_group_msg", key: "group_id" }
      : { kind: "user", id: t.id, action: "send_private_msg", key: "user_id" };
  };
  // OneBot 的数字 id 用 number 更兼容（字符串也行，但部分是强类型实现）
  const obId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : v);

  // 文本：有 msgId（原消息 message_id）就带 reply 段做引用回复——群里看起来就像在回那个人，
  // 不需要知道对方的 QQ 号，也不会像纯文字那样插进一堆消息中间找不着上下文。
  const obSendText = async (target, text, msgId) => {
    const t = obTarget(target);
    const rid = msgId == null ? "" : String(msgId).trim();
    const quoted = /^-?\d+$/.test(rid);
    const segs = [];
    if (quoted) segs.push({ type: "reply", data: { id: rid } });
    segs.push({ type: "text", data: { text: String(text ?? "") } });
    await obApi(t.action, { [t.key]: obId(t.id), message: segs }).then(obRememberSent);
    dlog(`onebot 文本已发送(${t.kind} ${t.id})${quoted ? ` 引用#${rid}` : ""}`);
  };

  // 图片走 base64 直传：不依赖 OneBot 端能否读到本机路径
  const obSendImageTo = async (target, imagePath) => {
    if (!existsSync(imagePath)) throw new Error(`图片不存在: ${imagePath}`);
    const t = obTarget(target);
    const buf = readFileSync(imagePath);
    await obApi(t.action, {
      [t.key]: obId(t.id),
      message: [{ type: "image", data: { file: `base64://${buf.toString("base64")}` } }],
    }).then(obRememberSent);
    dlog(`onebot 图片已发送(${t.kind} ${t.id}): ${imagePath} (${buf.length} B)`);
  };

  // 文件：群 upload_group_file / 私聊 upload_private_file，传绝对路径由 OneBot 端自己读
  const obSendFileTo = async (target, filePath) => {
    if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
    const st = statSync(filePath);
    if (!st.isFile()) throw new Error(`不是普通文件: ${filePath}`);
    const t = obTarget(target);
    const name = basename(filePath);
    if (t.kind === "group") {
      await obApi("upload_group_file", { group_id: obId(t.id), file: filePath, name }, 300000);
    } else {
      await obApi("upload_private_file", { user_id: obId(t.id), file: filePath, name }, 300000);
    }
    dlog(`onebot 文件已发送(${t.kind} ${t.id}): ${filePath} (${st.size} B)`);
  };

  // ---- 发送统一入口：三个调用名与官方完全一致，调用点不用改 ----
  const sendText = async (target, text, msgId) =>
    backend === "onebot" ? obSendText(target, text, msgId) : officialSendText(target, text, msgId);
  const sendImageTo = async (target, imagePath, msgId) =>
    backend === "onebot" ? obSendImageTo(target, imagePath) : officialSendImageTo(target, imagePath, msgId);
  const sendFileTo = async (target, filePath, msgId) =>
    backend === "onebot" ? obSendFileTo(target, filePath) : officialSendFileTo(target, filePath, msgId);

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
    const cwd = config.cwd || join(homedir(), ".deepseek harness");
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
              // [2026-10-26] onebot 后端：图片是普通公网 URL，不带 QQBot 头，也不碰官方 token。
              let r;
              if (backend === "onebot") {
                r = await fetchOnce(u, null, 30_000);
              } else {
                const token = await getAccessToken();
                r = await fetchOnce(u, { Authorization: `QQBot ${token}` }, 30_000);
                if (!r.ok) {
                  // 兜底：少数 URL 是公开的，带 token 被拒就裸试一次（最坏与旧逻辑等价）
                  r = await fetchOnce(u, null, 30_000);
                }
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
        p.turns.set(turn, (p.turns.get(turn) ?? "") + text); // [fix 2026-10-26] 累加而非覆盖：同轮多段输出不再互相盖掉
      } else {
        let m = orphanTurns.get(sid);
        if (!m) { m = new Map(); orphanTurns.set(sid, m); }
        m.set(turn, (m.get(turn) ?? "") + text); // [fix 2026-10-26] 同上
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
    sendText(openid, text, undefined).catch((e) => dlog(`自动转发失败: ${e?.message ?? e}`));
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

  // [2026-10-26] 会话预设解析：config.preset 指定则所有 QQ 会话统一用它；否则沿用「群 qqgroup、私聊默认」
  const presetFor = async (key) => {
    const want = presetValue;
    if (want) {
      if (want === "qqgroup" && !(await hasQqgroupPreset())) return {};
      dlog(`[preset] 按配置使用 ${want}（key=${String(key).slice(0, 16)}）`);
      return { agentPreset: want };
    }
    return String(key).startsWith("group:") && (await hasQqgroupPreset())
      ? { agentPreset: "qqgroup" }
      : {};
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
      sendText(openid, `[系统提示] QQ 会话已固定为 ${fixedId}，旧会话（${mappedId.slice(0, 8)}…）保留存档。`, undefined)
        .catch((e) => dlog(`系统提示发送失败: ${e?.message ?? e}`));
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
          cwd: config.cwd || join(homedir(), ".deepseek harness"),
          // 预设：config.preset 指定则统一用它；否则群 qqgroup、私聊默认 dafeiyu
          ...(await presetFor(openid)),
        },
        agentOptions,
        setup,
      });
      openidToSession[openid] = sessionId;
      if (prevSessionId && prevSessionId !== sessionId) openidToSession[`${openid}#prev`] = prevSessionId;
      saveMap(openidToSession);
      if (prevSessionId && prevSessionId !== sessionId) {
        dlog(`已为 ${openid} 新建固定会话 ${sessionId}（旧会话 ${prevSessionId} 保留）`);
        sendText(openid, `[系统提示] 上次会话恢复失败，已开启新会话。旧会话（${prevSessionId.slice(0, 8)}…）的上下文不再自动带出。`, undefined)
          .catch((e) => dlog(`系统提示发送失败: ${e?.message ?? e}`));
      } else {
        dlog(`已为 ${openid} 创建固定会话 ${sessionId}`);
      }
    }
    handles.set(openid, handle);
    return handle.agent;
  };

  // ---- 消息入口（私聊 C2C + 群 @），文本 + 图片附件 ----
  // [2026-10-26 去重修复] 同一事件可能被多条并存连接重复投递（实测同一条 2–60ms 内到 3 次）：
  // 有消息 id 按 id 去重，没有 id 才退化成「内容+附件数」窗口兜底。
  const seenEventKeys = new Map();
  const isDuplicateEvent = (kind, msg) => {
    const now = Date.now();
    for (const [k, t] of seenEventKeys) if (now - t > 60_000) seenEventKeys.delete(k);
    const author = msg?.author ?? {};
    const peer = kind === "group"
      ? (msg?.group_openid ?? msg?.group_id)
      : (author.user_openid ?? author.id);
    const id = msg?.id ?? msg?.message_id;
    const key = id
      ? kind + "|" + peer + "|id:" + id
      : kind + "|" + peer + "|c:" + String(msg?.content ?? "").slice(0, 200) + "|n:" + (Array.isArray(msg?.attachments) ? msg.attachments.length : 0);
    if (seenEventKeys.has(key)) return true;
    seenEventKeys.set(key, now);
    return false;
  };

  const onIncomingMessage = async (kind, msg) => {
    if (isDuplicateEvent(kind, msg)) {
      dlog("[dedup] " + kind + " 重复事件已丢弃 id=" + (msg?.id ?? msg?.message_id ?? "none"));
      return;
    }
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
    // [2026-10-26] OneBot 的图片可能已经落在本机（localPath），不必再下载；只下 URL 那部分
    const localOnes = attachments.filter((a) => a && a.localPath);
    const remoteOnes = attachments.filter((a) => a && !a.localPath);
    const images = await downloadImages(remoteOnes, msgId, isGroup ? "qqg" : "qq");
    for (const a of localOnes) images.saved.push(a.localPath);
    // 认主人：群消息靠指纹比对；私聊则视为主人并顺手学习指纹
    let fromOwner = false;
    if (isGroup) {
      fromOwner = isOwnerAuthor(author);
    } else if (
      backend === "onebot"
        // [2026-10-26] OneBot 私聊：谁都能聊，但只有白名单里的真 QQ 号算主人。
        // openid 那套在 OneBot 下不存在，硬套等于把每个私聊的人都当主人。
        ? (obCfg.ownerUsers.includes(String(peerId)) || config.ownerOpenids.includes(String(peerId)))
        : config.ownerOpenids.length === 0 || config.ownerOpenids.includes(String(peerId))
    ) {
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
      p.reply = (t) => sendText(target, t, msgId).catch((e) => dlog(`回复发送失败: ${e?.message ?? e}`));
      agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }));
    } catch (e) {
      const stack = e?.stack ?? String(e);
      ctx.logger.error(`[qq-bot] 处理失败: ${stack}`);
      dlog(`处理失败: ${stack}`);
      // 不把内部错误原文丢进群里（会泄露栈/服务名），只给一句轻的提示
      sendText(target, "我这边卡了一下，等下再试", msgId).catch(() => { /* 连报错都发不出去就算了 */ });
    }
  };
  // 2026-10-26: fire-and-forget 入口必须兜住 —— 13:29 就是因为一次未处理的
  // unhandledRejection 把整个 dsh 进程带走（sendText is not defined）。
  const onC2CMessage = (msg) =>
    onIncomingMessage("c2c", msg).catch((e) => dlog(`c2c 消息处理异常（已兜住）: ${e?.stack ?? e}`));
  const onGroupMessage = (msg) =>
    onIncomingMessage("group", msg).catch((e) => dlog(`群消息处理异常（已兜住）: ${e?.stack ?? e}`));

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

      // [2026-10-26 去重修复] 重连前先彻底关掉旧连接：旧 ws 的 onmessage 不置空就会继续投递，
      // 一次 4009 断线重连就留下两条并存的连接，同一条消息被处理 N 次（实测 3 次）。
      if (ws) {
        try { ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); } catch {}
        ws = null;
      }
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

  // ================= OneBot 事件来源（归一成伪官方事件后交给 onIncomingMessage）=================
  // 需要过滤：①自己发的消息（防回环）②meta_event/心跳 ③群里没 @ 机器人（atOnly）
  const obSelfId = String(obCfg.selfId || "");
  const obLastReplyAt = new Map(); // 群号 -> 上次接话时间戳（没 @ 时的冷却用）
  const obIsSelf = (ev) => !!obSelfId && String(ev?.user_id ?? ev?.sender?.user_id ?? "") === obSelfId;

  // OneBot 的 file 字段 → 本机可读路径（只认确实存在的文件）
  const obResolveLocal = (file) => {
    if (!file) return null;
    try {
      let p = String(file);
      if (p.startsWith("base64://")) return null;
      if (p.startsWith("file://")) p = decodeURIComponent(p.slice(7).replace(/^\/+/, ""));
      if (/^[a-zA-Z]:[\\/]/.test(p) && existsSync(p)) return p;
      return null;
    } catch { return null; }
  };

  // 解析 OneBot 的 message 段数组：纯文本 / 图片附件 / 是否 @ 了自己
  const obParseMessage = (raw, message) => {
    const segs = Array.isArray(message) ? message : [];
    const texts = [];
    const attachments = [];
    let atSelf = false;
    for (const s of segs) {
      const type = s?.type;
      const data = s?.data ?? {};
      if (type === "text") {
        texts.push(String(data.text ?? ""));
      } else if (type === "at") {
        if (obSelfId && String(data.qq) === obSelfId) atSelf = true;
        else if (data.qq && String(data.qq) !== "all") texts.push(`@${data.qq} `);
      } else if (type === "image") {
        const url = String(data.url ?? "").trim();
        const local = obResolveLocal(data.file);
        if (local) attachments.push({ localPath: local, content_type: "image/*" });
        else if (url) attachments.push({ url, content_type: "image/*" });
      } else if (type === "file") {
        const url = String(data.url ?? "").trim();
        if (url) attachments.push({ url, filename: String(data.name ?? data.file ?? ""), content_type: "" });
      } else if (type === "reply") {
        // 有人点「回复」引用我的消息：即使没 @ 也算在跟我说话（atOnly 时尤其重要）
        if (obSentIds.has(String(data.id ?? ""))) atSelf = true;
      }
      // face / mface / record / video / forward 等段忽略：不影响文本语义
    }
    if (texts.length === 0 && typeof raw === "string" && raw) {
      const plain = raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
      if (plain) texts.push(plain);
    }
    return { text: texts.join("").replace(/<@!?\d+>/g, "").trim(), attachments, atSelf };
  };

  // 归一成「伪官方事件」，直接复用 onIncomingMessage 的下游逻辑（会话映射/主人识别/回发…）
  const obDispatch = (ev) => {
    try {
      if (!ev || typeof ev !== "object") return;
      if (ev.post_type !== "message" && ev.post_type !== "message_sent") return;
      if (obIsSelf(ev)) return;
      // 同一 message_id 只处理一次（跨实例共享表：既防协议端重复投递，也防热重载后新旧实例各回一次）
      {
        const key = String(ev.message_id ?? "");
        if (key) {
          const seen = (globalThis.__dshQqbotSeen ||= new Map());
          const now = Date.now();
          for (const [k, t] of seen) if (now - t > 60_000) seen.delete(k);
          if (seen.has(key)) {
            dlog(`onebot 重复事件已忽略 id=${key}`);
            return;
          }
          seen.set(key, now);
        }
      }
      const isGroup = ev.message_type === "group";
      const parsed = obParseMessage(ev.raw_message, ev.message);
      const senderId = String(ev.user_id ?? ev.sender?.user_id ?? "");
      if (!senderId) return;
      // 群门槛：@ 我、或引用我的消息 → 必接
      // 没 @ 我时：只在文本命中关键词（默认「肥鱼」）时才接；groupCooldownSec 仅是防连发的兜底（0 = 不冷却）
      if (isGroup && !parsed.atSelf) {
        if (obCfg.atOnly) return;
        const kws = Array.isArray(obCfg.groupKeywords) ? obCfg.groupKeywords.filter(Boolean) : [];
        const plain = (parsed.text || "").toLowerCase();
        const hit = kws.length > 0 ? kws.some((k) => plain.includes(String(k).toLowerCase())) : !!parsed.text;
        if (!hit) {
          dlog(`onebot 群${ev.group_id} 未命中关键词，跳过: ${(parsed.text || "").slice(0, 30)}`);
          return;
        }
        const cd = Math.max(0, Number(obCfg.groupCooldownSec ?? 0));
        if (cd > 0) {
          const gk = String(ev.group_id ?? "");
          const left = cd * 1000 - (Date.now() - (obLastReplyAt.get(gk) ?? 0));
          if (left > 0) {
            dlog(`onebot 群${gk} 冷却中，跳过（还剩 ${Math.ceil(left / 1000)}s）`);
            return;
          }
        }
      }
      const senderName = String(ev.sender?.card || ev.sender?.nickname || "");
      const pseudo = isGroup
        ? {
            group_openid: String(ev.group_id ?? ""),
            author: {
              member_openid: senderId,
              username: senderName,
              member_role: ev.sender?.role === "owner" ? "owner" : (ev.sender?.role ?? ""),
            },
            content: parsed.text,
            attachments: parsed.attachments,
            id: String(ev.message_id ?? ""),
          }
        : {
            author: { user_openid: senderId, union_openid: senderId, username: senderName },
            content: parsed.text,
            attachments: parsed.attachments,
            id: String(ev.message_id ?? ""),
          };
      dlog(
        `onebot 收到${isGroup ? "群聊" : "私聊"} ${isGroup ? `群${ev.group_id}` : senderId}` +
        `${senderName ? `(${senderName})` : ""}: ${parsed.text.slice(0, 60)}` +
        `${parsed.attachments.length ? ` [附件x${parsed.attachments.length}]` : ""}`,
      );
      // 空文本时打一份原始事件，便于查协议端到底推了什么
      if (!parsed.text) {
        dlog(`onebot 空正文 type=${ev.message_type} msgType=${typeof ev.message} len=${Array.isArray(ev.message) ? ev.message.length : -1}: ${JSON.stringify(ev).slice(0, 500)}`);
      }
      if (isGroup) obLastReplyAt.set(String(ev.group_id ?? ""), Date.now());
      onIncomingMessage(isGroup ? "group" : "c2c", pseudo);
    } catch (e) {
      dlog(`onebot 事件处理失败: ${e?.stack ?? e}`);
    }
  };

  // ---- 事件来源 A：本地 HTTP 上报服务（把 OneBot 的「HTTP 上报」指到这里）----
  let obServer = null;
  const obStartHttp = async () => {
    const { createServer } = await import("node:http");
    const { createHmac, timingSafeEqual } = await import("node:crypto");
    const wantPath = String(obCfg.listenPath || "/onebot");
    obServer = createServer((req, res) => {
      if (req.method !== "POST" || String(req.url || "").split("?")[0] !== wantPath) {
        res.writeHead(404).end("not found");
        return;
      }
      const chunks = [];
      req.on("data", (c) => { if (c) chunks.push(c); });
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        // 签名校验（OneBot 标准头：X-Signature: sha1=<hmac_sha1(secret, rawBody)>）
        if (obCfg.secret) {
          const got = String(req.headers["x-signature"] ?? "");
          const want = "sha1=" + createHmac("sha1", obCfg.secret).update(body).digest("hex");
          let ok = false;
          try {
            const a = Buffer.from(got);
            const b = Buffer.from(want);
            ok = a.length === b.length && timingSafeEqual(a, b);
          } catch { ok = false; }
          if (!ok) {
            dlog("onebot 上报签名校验失败，已丢弃");
            res.writeHead(401).end("bad signature");
            return;
          }
        }
        let ev = null;
        try { ev = JSON.parse(body.toString("utf8")); } catch { ev = null; }
        res.writeHead(204).end(); // 先回 204，OneBot 不等处理结果
        if (ev) obDispatch(ev);
      });
    });
    obServer.on("error", (e) => dlog(`onebot 上报服务出错: ${e?.message ?? e}`));
    await new Promise((resolve, reject) => {
      obServer.once("error", reject);
      obServer.listen(Number(obCfg.listenPort), String(obCfg.listenHost), () => resolve());
    });
    dlog(`onebot 事件服务已监听 http://${obCfg.listenHost}:${obCfg.listenPort}${wantPath}（把 OneBot 的 HTTP 上报指到这里）`);
  };

  // ---- 事件来源 B：主动连 OneBot 的正向 WebSocket（events=ws）----
  let obWs = null;
  let obWsTimer = null;
  const obWsUrl = () => {
    if (obCfg.wsUrl) return String(obCfg.wsUrl);
    try {
      const u = new URL(obBase);
      const port = Number(u.port || 3000) + 1; // 常见约定：API 3000 / 事件 3001
      return `${u.protocol === "https:" ? "wss" : "ws"}://${u.hostname}:${port}`;
    } catch { return "ws://127.0.0.1:3001"; }
  };
  const obConnectWs = () => {
    if (closed) return;
    // Node 内置 WebSocket 不支持自定义头，token 走 query（OneBot 标准支持 ?access_token=）
    const base = obWsUrl();
    const wsTok = obCfg.wsToken || obCfg.accessToken;
    const url = wsTok
      ? `${base}${base.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(wsTok)}`
      : base;
    // 防多实例：热重载后旧实例的 WS 可能还连着，SnowLuma 会向所有连接广播同一事件（导致一条消息回两次）
    try {
      const prev = globalThis.__dshQqbotObWs;
      if (prev && prev !== obWs && typeof prev.close === "function") {
        prev.close();
        dlog("onebot 已关闭上一个实例遗留的 WS");
      }
    } catch { /* ignore */ }
    try {
      obWs = new WebSocket(url);
    } catch (e) {
      dlog(`onebot WS 构造失败: ${e?.message ?? e}`);
      obWsTimer = setTimeout(obConnectWs, 15_000);
      return;
    }
    obWs.onopen = () => {
      globalThis.__dshQqbotObWs = obWs;
      dlog(`onebot WS 已连接 ${base}`);
    };
    obWs.onmessage = (m) => {
      let ev = null;
      try { ev = JSON.parse(String(m.data)); } catch { return; }
      obDispatch(ev);
    };
    obWs.onclose = (e) => {
      dlog(`onebot WS 断开 (code=${e?.code})，15 秒后重连`);
      if (!closed) obWsTimer = setTimeout(obConnectWs, 15_000);
    };
    obWs.onerror = (e) => dlog(`onebot WS 错误: ${e?.message ?? String(e)}`);
  };

  // ---- 后端启动/停止（抽成函数，供热切换复用）----
  const stopBackend = () => {
    if (obWsTimer) { clearTimeout(obWsTimer); obWsTimer = null; }
    try { if (obWs) obWs.close(); } catch { /* ignore */ }
    if (globalThis.__dshQqbotObWs === obWs) delete globalThis.__dshQqbotObWs;
    obWs = null;
    try { if (obServer) obServer.close(); } catch { /* ignore */ }
    obServer = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { if (ws) ws.close(); } catch { /* ignore */ }
    ws = null;
  };
  const startBackend = () => {
    if (closed) return;
    if (backend === "onebot") {
      if (obCfg.events === "ws") obConnectWs();
      else obStartHttp().catch((e) => dlog(`onebot 事件服务启动失败: ${e?.stack ?? e}`));
      // 探一次登录态，日志里留个记录，便于判断后端是否真的活着
      setTimeout(async () => {
        try {
          const info = await obApi("get_login_info", {}, 8000);
          dlog(`onebot get_login_info: ${JSON.stringify(info?.data ?? info).slice(0, 200)}`);
        } catch (e) {
          dlog(`onebot get_login_info 失败（后端没起 / 没配 accessToken）: ${e?.message ?? e}`);
        }
      }, 1500);
    } else {
      connectGateway();
    }
  };

  // ---- 运行时配置热读：每 3 秒 stat 一次，变了就热应用 ----
  const connSig = () => JSON.stringify([
    backend, obCfg.apiBase, obCfg.accessToken, obCfg.wsToken, obCfg.wsUrl, obCfg.selfId,
    obCfg.events, obCfg.listenHost, obCfg.listenPort, obCfg.listenPath, obCfg.secret,
  ]);
  const applyRuntime = (raw) => {
    if (!raw || typeof raw !== "object") return;
    const before = connSig();
    if (raw.backend === "official" || raw.backend === "onebot") backend = raw.backend;
    if (raw.preset !== undefined) presetValue = String(raw.preset ?? "").trim();
    if (raw.onebot && typeof raw.onebot === "object") obCfg = { ...obCfg, ...raw.onebot };
    obBase = String(obCfg.apiBase || "").replace(/\/+$/, "");
    const after = connSig();
    if (after !== before) {
      dlog(`运行时配置: 后端参数变化 -> 重连 (backend=${backend} events=${obCfg.events})`);
      stopBackend();
      setTimeout(startBackend, 400);
    } else {
      dlog(`运行时配置已应用 (backend=${backend} atOnly=${obCfg.atOnly} kw=${(obCfg.groupKeywords || []).join("/")} cd=${obCfg.groupCooldownSec} preset=${presetValue || "-"})`);
    }
  };
  const checkRuntime = () => {
    if (closed || !runtimeFile) return;
    try {
      if (!existsSync(runtimeFile)) {
        if (!runtimeMissingWarned) {
          dlog(`运行时配置未创建（可选，改它免重启）: ${runtimeFile}`);
          runtimeMissingWarned = true;
        }
        return;
      }
      const st = statSync(runtimeFile);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp === runtimeStamp) return;
      runtimeStamp = stamp;
      let obj = null;
      try {
        obj = JSON.parse(readFileSync(runtimeFile, "utf8"));
      } catch (e) {
        dlog(`运行时配置 JSON 解析失败，本次忽略: ${e?.message ?? e}`);
        return;
      }
      dlog(`检测到运行时配置变更: ${runtimeFile}`);
      applyRuntime(obj);
    } catch (e) {
      dlog(`运行时配置读取失败: ${e?.message ?? e}`);
    }
  };

  // ---- 设置页（本机 HTTP，给 DSH 设置页里的 iframe 用）----
  // [2026-10-26 by 大肥鱼] 只读写 runtime-config.json，不碰 patch；写盘后由 3 秒热读生效。
  let settingsServer = null;
  const settingsPort = 3211;
  const startSettingsServer = async () => {
    if (settingsServer) return;
    try {
      const { createServer } = await import("node:http");
      const pageFile = join(fileURLToPath(new URL(".", import.meta.url)), "settings-page.html");
      settingsServer = createServer((req, res) => {
        const cors = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Cache-Control": "no-store",
        };
        const send = (code, type, body) => {
          res.writeHead(code, { "Content-Type": type, ...cors });
          res.end(body);
        };
        let pathname = "/";
        try { pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname; } catch { /* ignore */ }
        if (req.method === "OPTIONS") return send(204, "text/plain", "");
        if (pathname === "/" || pathname === "/settings") {
          try {
            return send(200, "text/html; charset=utf-8", readFileSync(pageFile));
          } catch (e) {
            return send(500, "text/plain; charset=utf-8", "settings-page.html 读不到: " + (e?.message ?? e));
          }
        }
        if (pathname === "/api/config" && req.method === "GET") {
          try {
            const st = statSync(runtimeFile);
            const j = JSON.parse(readFileSync(runtimeFile, "utf8"));
            j.__mtime = new Date(st.mtimeMs).toLocaleString("zh-CN");
            j.__file = runtimeFile;
            return send(200, "application/json; charset=utf-8", JSON.stringify(j));
          } catch (e) {
            return send(500, "application/json; charset=utf-8", JSON.stringify({ error: e?.message ?? String(e) }));
          }
        }
        if (pathname === "/api/config" && req.method === "PUT") {
          let buf = "";
          req.on("data", (c) => { buf += c; if (buf.length > 262144) req.destroy(); });
          req.on("end", () => {
            try {
              const j = JSON.parse(buf);
              delete j.__mtime;
              delete j.__file;
              if (j.backend !== "official" && j.backend !== "onebot") throw new Error("backend 只能是 official 或 onebot");
              if (j.preset != null && typeof j.preset !== "string") throw new Error("preset 必须是字符串");
              if (j.onebot != null && (typeof j.onebot !== "object" || Array.isArray(j.onebot))) throw new Error("onebot 必须是对象");
              writeFileSync(runtimeFile, JSON.stringify(j, null, 2) + "\n", "utf8");
              dlog("设置页写入 runtime-config.json，等 3 秒热应用");
              send(200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
            } catch (e) {
              send(400, "application/json; charset=utf-8", JSON.stringify({ error: e?.message ?? String(e) }));
            }
          });
          return;
        }
        return send(404, "text/plain; charset=utf-8", "not found");
      });
      settingsServer.on("error", (e) => {
        dlog("设置页服务出错: " + (e?.message ?? e));
        settingsServer = null;
      });
      settingsServer.listen(settingsPort, "127.0.0.1", () => dlog("设置页已启动 http://127.0.0.1:" + settingsPort));
    } catch (e) {
      dlog("设置页服务启动失败: " + (e?.message ?? e));
    }
  };
  startBackend();
  checkRuntime();
  runtimeTimer = setInterval(checkRuntime, 3000);
  startSettingsServer();

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
        // [patch 2026-10-27 by 大肥鱼] 官方后端的 C2C 发送只认 openid；映射里可能同时躺着
        // 历史遗留的纯数字 QQ 号键（发过去必然 400 code=11255），所以优先挑非纯数字的 openid。
        const isQqNumber = (k) => /^\d+$/.test(k);
        const picked = keys.find((k) => !isQqNumber(k)) ?? keys[0];
        if (keys.length > 1) dlog(`qq-send-message: 映射里有 ${keys.length} 个用户（${keys.map((k) => (isQqNumber(k) ? `QQ号:${k}` : `openid:${k.slice(0, 8)}…`)).join(", ")}），选用 ${picked.slice(0, 8)}…`);
        openid = picked;
        if (isQqNumber(openid) && backend === "official") {
          return { ok: false, message: `映射里只有 QQ 号（${openid}），官方机器人后端不认 QQ 号，请先用真 openid 绑定（让主人私聊一条即可）。` };
        }
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
    if (runtimeTimer) clearInterval(runtimeTimer);
    closed = true;
    stopHeartbeat();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch { /* ignore */ }
    // OneBot 侧清理：上报服务与正向 WS
    if (obWsTimer) clearTimeout(obWsTimer);
    try { obWs?.close(); } catch { /* ignore */ }
    if (globalThis.__dshQqbotObWs === obWs) delete globalThis.__dshQqbotObWs;
    try { obServer?.close(); } catch { /* ignore */ }
    try { settingsServer?.close(); } catch { /* ignore */ }    offEvents();
  });
}
