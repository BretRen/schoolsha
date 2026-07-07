// ============================================================
// main.ts — WebSocket 服务器入口
// ============================================================

import { createGame, handleMessage, getPlayerView, checkTimeout, cardLabel, resetPicks, bothPicked, getPicks } from "./game.ts";
import { getAllCharacters } from "./skills.ts";
import type { GameState, ServerMsg, ClientMsg, CharacterInfo } from "./types.ts";

// ---------- 简易匹配 ----------

interface Client {
  socket: WebSocket;
  index: number;
}

let game: GameState | null = null;
const clients: (Client | null)[] = [null, null];

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
  ws.send(JSON.stringify(msg));
}

function error(ws: WebSocket, message: string) {
  send(ws, { type: "error", message });
}

// ---------- 超时轮询 ----------

const TIMEOUT_CHECK_MS = 2_000;

function startTimeoutCheck() {
  setInterval(() => {
    if (!game) return;
    if (checkTimeout(game)) {
      broadcast();
    }
  }, TIMEOUT_CHECK_MS);
}

// ---------- 启动 ----------

const PORT = parseInt(Deno.env.get("PORT") || "8099");

Deno.serve({ port: PORT }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    // HTTP 端点
    const url = new URL(req.url);
    if (url.pathname === "/info") {
      return new Response(JSON.stringify({
        version: "0.2.0",
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

    // 人齐 → 发送角色选择
    if (clients[0] && clients[1]) {
      resetPicks();
      const chars: CharacterInfo[] = getAllCharacters().map((c) => ({
        id: c.id,
        name: c.name,
        maxHp: c.maxHp,
        skills: c.skills,
      }));
      for (const c of clients) {
        if (c) send(c.socket, { type: "character_select", characters: chars });
      }
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
    if (idx !== -1) {
      console.log(`Player ${idx} left the game`);
      clients[idx] = null;
    }
  });

  return response;
});

console.log(`🔪 Sanguosha server running on ws://0.0.0.0:${PORT}`);
