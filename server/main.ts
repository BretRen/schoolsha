// ============================================================
// main.ts — WebSocket 服务器入口
// ============================================================

import { createGame, handleMessage, getPlayerView, checkTimeout, cardLabel } from "./game.ts";
import type { GameState, ServerMsg, ClientMsg } from "./types.ts";

// ---------- 简易匹配 ----------

interface Client {
  socket: WebSocket;
  index: number; // 0 or 1
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
    return new Response("Sanguosha server — WebSocket only", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    console.log("Client connected");

    // 分配座位
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

    // 人齐了 → 开局
    if (clients[0] && clients[1]) {
      game = createGame();
      startTimeoutCheck();
      broadcast();
      console.log("Game started!");
    } else {
      send(socket, {
        type: "error",
        message: "等待另一位玩家...",
      } as ServerMsg);
    }
  });

  socket.addEventListener("message", (event) => {
    if (!game) {
      error(socket, "游戏尚未开始");
      return;
    }

    let msg: ClientMsg;
    try {
      msg = JSON.parse(event.data) as ClientMsg;
    } catch {
      error(socket, "无效 JSON");
      return;
    }

    // 找到发送方
    const clientEntry = clients.find((c) => c?.socket === socket);
    if (!clientEntry) return;
    const playerIdx = clientEntry.index;

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
