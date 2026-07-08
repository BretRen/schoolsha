// ============================================================
// main.ts — WebSocket 服务器入口
// ============================================================

import {
  createGame, handleMessage, getPlayerView, checkTimeout,
  cardLabel, resetPicks, bothPicked, getPicks,
  markDisconnected, markReconnected, checkDisconnectTimeout,
  anyoneDisconnected,
} from "./game.ts";
import { getAllCharacters } from "./skills.ts";
import type { GameState, ServerMsg, ClientMsg, CharacterInfo } from "./types.ts";

// ---------- 常量 ----------

const CHAR_SELECT_TIMEOUT_SEC = 30;
const RECONNECT_WINDOW_SEC = 30;
const MAX_DISCONNECTS = 3;

// ---------- 简易匹配 ----------

interface Client {
  socket: WebSocket;
  index: number;
}

let game: GameState | null = null;
const clients: (Client | null)[] = [null, null];
let selectStartedAt = 0;
let selectTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast() {
  if (!game) return;

  for (let i = 0; i < 2; i++) {
    const client = clients[i];
    if (!client || client.socket.readyState !== WebSocket.OPEN) continue;

    const view = getPlayerView(game, i);
    send(client.socket, { type: "game_state", state: view, yourIndex: i });
  }
}

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function error(ws: WebSocket, message: string) {
  send(ws, { type: "error", message });
}

// ---------- 超时轮询（2秒间隔） ----------

const TIMEOUT_CHECK_MS = 2_000;
let timeoutInterval: ReturnType<typeof setInterval> | null = null;

function startTimeoutCheck() {
  if (timeoutInterval) clearInterval(timeoutInterval);
  timeoutInterval = setInterval(() => {
    if (!game) return;

    // 检查 pending + 回合超时
    if (checkTimeout(game)) {
      broadcast();
    }

    // 检查断线超时
    for (let i = 0; i < 2; i++) {
      if (game.disconnectedAt[i] !== null) {
        if (checkDisconnectTimeout(game, i)) {
          broadcast();
        }
      }
    }
  }, TIMEOUT_CHECK_MS);
}

// ---------- 选角超时 ----------

function startSelectTimer() {
  if (selectTimer) clearTimeout(selectTimer);
  selectStartedAt = Date.now();
  selectTimer = setTimeout(() => {
    const picks = getPicks();
    const chars = getAllCharacters();
    let changed = false;

    for (let i = 0; i < 2; i++) {
      if (picks[i] === null) {
        picks[i] = chars[0].id; // 默认选第一个角色
        console.log(`P${i} select timeout, auto-picked ${chars[0].name}`);
        changed = true;
      }
    }

    if (bothPicked()) {
      console.log("Character select timeout, starting game with auto-picks");
      game = createGame();
      startTimeoutCheck();
      broadcast();
    }
  }, CHAR_SELECT_TIMEOUT_SEC * 1000);
}

// ---------- 启动 ----------

const PORT = parseInt(Deno.env.get("PORT") || "8099");

Deno.serve({ port: PORT }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    const url = new URL(req.url);
    if (url.pathname === "/info") {
      return new Response(JSON.stringify({
        version: "0.3.0",
        auth: { mode: "none" },
        ws: `ws://localhost:${PORT}`,
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("Sanguosha server — WebSocket only", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    console.log("Client connected");

    let seat: number;

    // ---- 断线重连：检查是否有空座位在等待重连 ----
    if (game && !game.gameOver && anyoneDisconnected(game)) {
      for (let i = 0; i < 2; i++) {
        if (game.disconnectedAt[i] !== null && !clients[i]) {
          seat = i;
          clients[seat] = { socket, index: seat };
          markReconnected(game, seat);
          send(socket, { type: "reconnected", message: "已重新连接" });
          broadcast();
          console.log(`P${seat} reconnected`);
          return;
        }
      }
    }

    // ---- 普通连接 ----
    if (!clients[0]) {
      seat = 0;
    } else if (!clients[1]) {
      seat = 1;
    } else {
      error(socket, "房间已满");
      socket.close();
      return;
    }

    const client: Client = { socket, index: seat };
    clients[seat] = client;

    if (clients[0] && clients[1]) {
      // 如果还有旧游戏状态（上一局结束了），清掉
      if (game?.gameOver) {
        game = null;
        if (timeoutInterval) { clearInterval(timeoutInterval); timeoutInterval = null; }
      }
      resetPicks();
      const chars: CharacterInfo[] = getAllCharacters().map((c) => ({
        id: c.id,
        name: c.name,
        maxHp: c.maxHp,
        skills: c.skills,
      }));
      for (const c of clients) {
        if (c) send(c.socket, {
          type: "character_select",
          characters: chars,
          timeoutSec: CHAR_SELECT_TIMEOUT_SEC,
        });
      }
      startSelectTimer();
      console.log("Lobby full, character select sent");
    } else {
      send(socket, { type: "waiting", message: "等待另一位玩家..." });
    }
  });

  socket.addEventListener("message", (event) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(event.data) as ClientMsg;
    } catch {
      error(socket, "无效 JSON");
      return;
    }

    const clientEntry = clients.find((c) => c?.socket === socket);
    if (!clientEntry) return;
    const playerIdx = clientEntry.index;

    // ---- 角色选择阶段 ----
    if (!game && msg.action === "pick_character") {
      const picks = getPicks();
      picks[playerIdx] = msg.id;
      console.log(`P${playerIdx} picked: ${msg.id}`);

      if (bothPicked()) {
        if (selectTimer) clearTimeout(selectTimer);
        console.log("Both players picked, starting game...");
        game = createGame();
        startTimeoutCheck();
        broadcast();
      }
      return;
    }

    if (!game) {
      error(socket, "游戏尚未开始（请先选择角色）");
      return;
    }

    // ---- 游戏中 ----
    const err = handleMessage(game, playerIdx, msg);
    if (err) {
      console.log(`P${playerIdx} error: ${err}`);
      error(socket, err);
    }

    broadcast();
  });

  socket.addEventListener("close", () => {
    console.log("Client disconnected");
    const idx = clients.findIndex((c) => c?.socket === socket);
    if (idx === -1) return;

    console.log(`Player ${idx} left`);

    // 游戏进行中 → 断线处理
    if (game && !game.gameOver) {
      const overLimit = markDisconnected(game, idx);
      // 通知对方
      const opponent = clients[1 - idx];
      if (opponent) {
        const left = MAX_DISCONNECTS - game.disconnectCount[idx];
        send(opponent.socket, {
          type: "disconnected",
          message: `对手已断线，${RECONNECT_WINDOW_SEC}秒内可重连（剩余次数: ${left}）`,
          attemptsLeft: left,
        });
      }
      if (overLimit) {
        broadcast();
      }
    }

    clients[idx] = null;
  });

  return response;
});

console.log(`🔪 Sanguosha server running on ws://0.0.0.0:${PORT}`);
