// ============================================================
// main.ts — WebSocket 服务器入口 (多房间 + Zitadel OIDC)
// ============================================================

import { handleMessage, anyoneDisconnected, markReconnected } from "./game.ts";
import { validateToken, extractToken, fetchUserInfo } from "./auth.ts";
import { roomManager, type Client } from "./room.ts";
import { matchmaking } from "./matchmaking.ts";
import { getLeaderboard, getElo } from "./elo.ts";
import type { ClientMsg, RoomInfo } from "./types.ts";

// ---------- 常量 ----------

const PORT = parseInt(Deno.env.get("PORT") || "8099");
const AUTH_ENABLED = !!Deno.env.get("ZITADEL_CLIENT_ID");
const PUBLIC_URL = Deno.env.get("PUBLIC_URL") || `http://localhost:${PORT}`;

// ---------- 辅助 ----------

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function inviteUrl(code: string): string {
  return `${PUBLIC_URL}/invite/${code}`;
}

function wsUrl(code: string): string {
  // WebSocket URL: 从 HTTP public URL 推导
  const u = new URL(PUBLIC_URL);
  const proto = u.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${u.host}/ws?room=${code}`;
}

function deepLink(code: string): string {
  return `pdnode://schoolsha/invite/${code}`;
}

// ---------- 邀请落地页 ----------

function inviteHTML(code: string): string {
  const link = deepLink(code);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>学校杀 - 加入房间 ${code}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body {
    background:#0f0f0f; color:#e0e0e0;
    font-family:system-ui,-apple-system,sans-serif;
    display:flex; align-items:center; justify-content:center;
    min-height:100vh; text-align:center;
    flex-direction:column; gap:20px;
  }
  .card {
    background:#1a1a1a; border-radius:12px;
    padding:40px; max-width:400px; width:90%;
    border:1px solid #2a2a2a;
  }
  .code {
    font-size:48px; font-weight:bold;
    letter-spacing:8px; color:#c4b5fd;
    font-family:monospace;
    margin:16px 0;
  }
  .hint { color:#888; font-size:14px; margin-top:16px }
  .btn {
    display:inline-block; background:#7c3aed;
    color:#fff; padding:12px 32px; border-radius:8px;
    text-decoration:none; font-size:16px; margin-top:12px;
  }
  a { color:#a78bfa }
</style>
</head>
<body>
<div class="card">
  <h1>🏫 学校杀</h1>
  <p>好友邀请你加入对战</p>
  <div class="code">${code}</div>
  <a class="btn" href="${link}">打开游戏</a>
  <p class="hint">
    如未自动跳转，请确保已安装游戏客户端<br>
    或复制上方房间码手动加入
  </p>
</div>
<script>
  window.location.href = "${link}";
</script>
</body>
</html>`;
}

// ---------- 启动 ----------

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // ---- HTTP 端点 ----
  if (req.headers.get("upgrade") !== "websocket") {
    // 邀请落地页
    const inviteMatch = url.pathname.match(/^\/invite\/([A-Za-z0-9]+)$/);
    if (inviteMatch) {
      return new Response(inviteHTML(inviteMatch[1].toUpperCase()), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // 创建房间
    if (url.pathname === "/room/create") {
      const room = roomManager.createRoom();
      const info: RoomInfo = {
        code: room.code,
        wsUrl: wsUrl(room.code),
        inviteUrl: inviteUrl(room.code),
        deepLink: deepLink(room.code),
      };
      return new Response(JSON.stringify(info), {
        headers: { "content-type": "application/json" },
      });
    }

    // 服务器信息
    if (url.pathname === "/info") {
      return new Response(JSON.stringify({
        version: "0.6.0",
        auth: {
          mode: AUTH_ENABLED ? "zitadel_oidc" : "none",
          provider: AUTH_ENABLED ? Deno.env.get("ZITADEL_ISSUER") : null,
          pkce: AUTH_ENABLED ? true : false,
        },
        rooms: roomManager.count,
        queue: matchmaking.length,
        ws: `ws://localhost:${PORT}/ws`,
        publicUrl: PUBLIC_URL,
      }), { headers: { "content-type": "application/json" } });
    }

    // 排行榜
    if (url.pathname === "/leaderboard") {
      const pid = url.searchParams.get("userId") || undefined;
      const data = getLeaderboard(10, pid);
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Sanguosha server — WebSocket only", { status: 426 });
  }

  // ---- 认证：在升级前验证 token ----
  let userId = "";
  let displayName = "";

  if (AUTH_ENABLED) {
    const token = extractToken(req);
    if (!token) {
      return new Response(JSON.stringify({
        error: "unauthorized",
        message: "缺少认证 token",
        hint: "请在 WebSocket 连接时传 Authorization: Bearer <token>",
        alternatives: [
          "Sec-WebSocket-Protocol: <token>（浏览器：new WebSocket(url, [token])）",
          "?token=<token> URL 参数",
        ],
      }), { status: 401, headers: { "content-type": "application/json" } });
    }

    const user = await validateToken(token);
    if (!user) {
      return new Response(JSON.stringify({
        error: "invalid_token",
        message: "token 无效或已过期",
      }), { status: 401, headers: { "content-type": "application/json" } });
    }

    userId = user.sub;
    displayName = user.displayName;

    // 尝试从 userinfo 拉取更准确的显示名
    const info = await fetchUserInfo(token);
    if (info) displayName = info.name;

    console.log(`[auth] user=${displayName} (${userId})`);
  } else {
    userId = `anon_${Date.now()}`;
    displayName = "";
  }

  // ---- 解析模式 ----
  const mode = url.searchParams.get("mode") || "";
  const roomCode = (url.searchParams.get("room") || "").toUpperCase();

  // ---- 匹配模式 WebSocket ----
  if (mode === "matching") {
    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.addEventListener("open", () => {
      matchmaking.join(userId, displayName, socket);
      console.log(`[matchmaking] ${displayName || userId} connected (elo=${getElo(userId)})`);
    });

    socket.addEventListener("close", () => {
      matchmaking.leave(userId);
    });

    return response;
  }

  // ---- 房间模式 WebSocket ----
  const { socket, response } = Deno.upgradeWebSocket(req);

  let room = roomCode ? roomManager.getOrCreateRoom(roomCode) : roomManager.createRoom();
  let seat = -1;

  socket.addEventListener("open", () => {
    room.touch();
    const nameTag = displayName || "?";

    // 如果房间是自动创建的（没提供 room 参数），告诉客户端
    if (!roomCode) {
      send(socket, {
        type: "room_created",
        code: room.code,
        inviteUrl: inviteUrl(room.code),
        wsUrl: wsUrl(room.code),
      });
    }

    // ---- 断线重连 ----
    if (room.game && !room.game.gameOver && anyoneDisconnected(room.game)) {
      for (let i = 0; i < 2; i++) {
        if (room.game.disconnectedAt[i] !== null && !room.clients[i]) {
          // 验证身份
          const savedId = room.disconnectedUserId[i];
          if (AUTH_ENABLED && savedId && savedId !== userId) {
            console.log(`[${room.code}] reconnect denied: userId mismatch for P${i}`);
            send(socket, {
              type: "error",
              message: "重连失败：身份不匹配（不是同一位玩家）",
            });
            socket.close();
            return;
          }

          seat = i;
          room.clients[seat] = {
            socket,
            index: seat,
            userId,
            displayName,
          };
          room.disconnectedUserId[seat] = null;
          markReconnected(room.game, seat);
          send(socket, { type: "reconnected", message: "已重新连接" });
          room.broadcast();
          console.log(`[${room.code}] P${seat} reconnected (${nameTag})`);
          return;
        }
      }
    }

    // ---- 普通连接 ----
    seat = room.findSeat() ?? -1;
    if (seat === -1) {
      send(socket, {
        type: "error",
        message: "房间已满（最多 2 人）",
      });
      socket.close();
      return;
    }

    const client: Client = { socket, index: seat, userId, displayName };
    room.clients[seat] = client;

    if (room.clients[0] && room.clients[1]) {
      // 如果之前有过已结束的游戏，重置
      if (room.game?.gameOver) {
        room.game = null;
        room.gameStarted = false;
      }
      room.picks = [null, null];
      room.sendCharacterSelect();
    } else {
      send(socket, { type: "waiting", message: "等待另一位玩家..." });
    }
    console.log(`[${room.code}] P${seat} connected (${nameTag})`);
  });

  socket.addEventListener("message", (event) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(event.data) as ClientMsg;
    } catch {
      send(socket, { type: "error", message: "无效 JSON" });
      return;
    }

    // 找到当前 socket 在房间中的座位
    const idx = room.clients.findIndex((c) => c?.socket === socket);
    if (idx === -1) return;
    seat = idx;

    // ---- 角色选择阶段 ----
    if (!room.game && msg.action === "pick_character") {
      room.picks[idx] = msg.id;
      const nameTag = room.clients[idx]?.displayName || "?";
      console.log(`[${room.code}] P${idx} (${nameTag}) picked: ${msg.id}`);

      // 双方都选好了
      if (room.picks[0] && room.picks[1]) {
        room.startGame();
      }
      return;
    }

    if (!room.game) {
      send(socket, { type: "error", message: "游戏尚未开始（请先选择角色）" });
      return;
    }

    // ---- 游戏中 ----
    const err = handleMessage(room.game, idx, msg);
    if (err) {
      console.log(`[${room.code}] P${idx} error: ${err}`);
      send(socket, { type: "error", message: err });
    }

    room.broadcast();
  });

  socket.addEventListener("close", () => {
    const idx = room.clients.findIndex((c) => c?.socket === socket);
    if (idx === -1) return;

    const nameTag = room.clients[idx]?.displayName || "?";
    console.log(`[${room.code}] P${idx} (${nameTag}) left`);

    // 游戏进行中 → 断线处理
    if (room.game && !room.game.gameOver) {
      room.handleDisconnect(idx);
    } else if (!room.game) {
      // 选角阶段有人离开 → 通知另一位重新等待
      room.picks = [null, null];
      const other = room.clients[1 - idx];
      if (other) {
        send(other.socket, { type: "error", message: "对手已离开，等待新玩家..." });
        send(other.socket, { type: "waiting", message: "等待另一位玩家..." });
      }
    }

    room.clients[idx] = null;
  });

  return response;
});

const authStatus = AUTH_ENABLED
  ? `auth=zitadel (${Deno.env.get("ZITADEL_ISSUER")})`
  : "auth=none";
console.log(`🔪 Sanguosha v0.6.0 (multi-room + elo) running on ws://0.0.0.0:${PORT} (${authStatus})`);
console.log(`   Room API:    ${PUBLIC_URL}/room/create`);
console.log(`   Matchmaking: ws://localhost:${PORT}/ws?mode=matching`);
console.log(`   Leaderboard: ${PUBLIC_URL}/leaderboard`);
console.log(`   Info:        ${PUBLIC_URL}/info`);
