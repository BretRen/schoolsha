// ============================================================
// room.ts — 房间管理（多房间 + 自动房间码）
// ============================================================

import {
  createGame, handleMessage, getPlayerView, checkTimeout,
  cardLabel, markDisconnected, markReconnected, checkDisconnectTimeout,
  anyoneDisconnected, advancePhase, getHandLimit,
} from "./game.ts";
import { getAllCharacters } from "./skills.ts";
import { updateElo } from "./elo.ts";
import type { GameState, ServerMsg, ClientMsg, CharacterInfo } from "./types.ts";

// ---------- 常量 ----------

const CHAR_SELECT_TIMEOUT_SEC = 30;
const RECONNECT_WINDOW_SEC = 30;
const MAX_DISCONNECTS = 3;
const TURN_TIMEOUT_CHECK_MS = 5_000;
/** 空闲房间清理时间（1 小时） */
const ROOM_TTL_MS = 60 * 60_000;
/** 已结束游戏清理时间（10 分钟） */
const GAME_OVER_TTL_MS = 10 * 60_000;

// ---------- 客户端连接 ----------

export interface Client {
  socket: WebSocket;
  index: number;
  userId: string;
  displayName: string;
}

// ---------- 房间类 ----------

export class Room {
  code: string;
  game: GameState | null = null;
  clients: (Client | null)[] = [null, null];
  /** 断线玩家的 userId（用于重连验证） */
  disconnectedUserId: (string | null)[] = [null, null];
  /** 角色选择暂存：每名玩家选的角色 ID */
  picks: (string | null)[] = [null, null];
  createdAt: number;
  /** 最后有活跃连接的时间 */
  lastActiveAt: number;
  /** 游戏是否已经开始（选角完成） */
  gameStarted = false;
  /** 防止同一局游戏重复记录 ELO */
  private _eloRecorded = false;

  private selectTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutInterval: ReturnType<typeof setInterval> | null = null;

  constructor(code: string) {
    this.code = code;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
  }

  // ---- 工具 ----

  private send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private error(ws: WebSocket, message: string) {
    this.send(ws, { type: "error", message });
  }

  /** 广播 game_state 给双方 */
  broadcast(): void {
    if (!this.game) return;

    for (let i = 0; i < 2; i++) {
      const client = this.clients[i];
      if (!client || client.socket.readyState !== WebSocket.OPEN) continue;

      const view = getPlayerView(this.game, i);
      const opp = this.clients[1 - i];

      view.playerName = client.displayName;
      view.playerId = client.userId;
      view.opponentName = opp?.displayName || "?";
      view.opponentId = opp?.userId || "";

      this.send(client.socket, { type: "game_state", state: view, yourIndex: i });
    }

    // 游戏结束 → 记录 ELO
    if (this.game.gameOver && !this._eloRecorded) {
      this._eloRecorded = true;
      const wIdx = this.game.winner!;
      const lIdx = 1 - wIdx;
      const w = this.clients[wIdx];
      const l = this.clients[lIdx];
      if (w && l) {
        updateElo(w.userId, l.userId, w.displayName, l.displayName);
      }
    }
  }

  // ---- 选角超时 ----

  private startSelectTimer(): void {
    if (this.selectTimer) clearTimeout(this.selectTimer);
    this.selectTimer = setTimeout(() => {
      const chars = getAllCharacters();

      // 未选的自动选第一个角色
      if (this.picks[0] === null) {
        this.picks[0] = chars[0].id;
        console.log(`[${this.code}] P0 select timeout, auto-picked ${chars[0].name}`);
      }
      if (this.picks[1] === null) {
        this.picks[1] = chars[0].id;
        console.log(`[${this.code}] P1 select timeout, auto-picked ${chars[0].name}`);
      }

      this.startGame();
    }, CHAR_SELECT_TIMEOUT_SEC * 1000);
  }

  /** 双方都选了角色 → 开始游戏 */
  startGame(): void {
    if (this.selectTimer) clearTimeout(this.selectTimer);
    const chars = getAllCharacters();

    // 确保双方都有选择
    if (this.picks[0] === null || this.picks[1] === null) return;

    console.log(`[${this.code}] Starting game: ${chars.find(c => c.id === this.picks[0])?.name} vs ${chars.find(c => c.id === this.picks[1])?.name}`);
    this._eloRecorded = false;
    this.game = createGame([this.picks[0], this.picks[1]]);
    this.gameStarted = true;
    this.startTimeoutCheck();
    this.broadcast();
  }

  // ---- 超时轮询 ----

  private startTimeoutCheck(): void {
    if (this.timeoutInterval) clearInterval(this.timeoutInterval);
    this.timeoutInterval = setInterval(() => {
      if (!this.game || this.game.gameOver) return;

      checkTimeout(this.game);
      for (let i = 0; i < 2; i++) {
        if (this.game.disconnectedAt[i] !== null) {
          checkDisconnectTimeout(this.game, i);
        }
      }

      // 无条件广播，客户端用服务端倒计时为准
      this.broadcast();
    }, TURN_TIMEOUT_CHECK_MS);
  }

  // ---- 断线处理 ----

  /** 处理断线：返回是否超过次数限制 */
  handleDisconnect(idx: number): boolean {
    if (!this.game || this.game.gameOver) return false;

    // 保存断线者 userId
    if (this.clients[idx]) {
      this.disconnectedUserId[idx] = this.clients[idx]!.userId;
    }

    const overLimit = markDisconnected(this.game, idx);
    const opponent = this.clients[1 - idx];

    // 如果断线的是当前回合玩家，自动跳过他的回合
    if (this.game.turnPlayer === idx && !this.game.pendingResponse) {
      if (this.game.phase === "play") {
        advancePhase(this.game);
      } else if (this.game.phase === "discard") {
        // 自动弃牌（弃超过手牌上限的部分）
        const player = this.game.players[idx];
        const limit = getHandLimit(this.game, idx, player.characterId ?? "");
        const need = player.hand.length - limit;
        if (need > 0) {
          const discarded = player.hand.splice(0, need);
          this.game.discard.push(...discarded);
        }
        advancePhase(this.game);
      } else {
        advancePhase(this.game);
      }
    }

    if (opponent) {
      const left = MAX_DISCONNECTS - this.game.disconnectCount[idx];
      this.send(opponent.socket, {
        type: "disconnected",
        message: `对手已断线，${RECONNECT_WINDOW_SEC}秒内可重连（剩余次数: ${left}）`,
        attemptsLeft: left,
      });
    }

    if (overLimit) {
      this.broadcast();
    }
    return overLimit;
  }

  /** 尝试重连：返回 null=成功, string=错误信息 */
  tryReconnect(socket: WebSocket, userId: string): number | null {
    if (!this.game || this.game.gameOver || !anyoneDisconnected(this.game)) {
      return null;
    }

    for (let i = 0; i < 2; i++) {
      if (this.game.disconnectedAt[i] !== null && !this.clients[i]) {
        // 验证重连者身份
        if (this.disconnectedUserId[i] && this.disconnectedUserId[i] !== userId) {
          return i; // 返回座位号用于提示
        }

        this.clients[i] = { socket, index: i, userId, displayName: "" };
        this.disconnectedUserId[i] = null;
        markReconnected(this.game, i);
        this.send(socket, { type: "reconnected", message: "已重新连接" });
        this.broadcast();
        this.lastActiveAt = Date.now();
        console.log(`[${this.code}] P${i} reconnected`);
        return i;
      }
    }
    return null;
  }

  /** 检查是否有空座位。返回 0/1/null */
  findSeat(): number | null {
    if (!this.clients[0]) return 0;
    if (!this.clients[1]) return 1;
    return null;
  }

  /** 发送选角消息给双方 */
  sendCharacterSelect(): void {
    const chars: CharacterInfo[] = getAllCharacters().map((c) => ({
      id: c.id,
      name: c.name,
      maxHp: c.maxHp,
      skills: c.skills,
    }));
    for (const c of this.clients) {
      if (c) this.send(c.socket, {
        type: "character_select",
        characters: chars,
        timeoutSec: CHAR_SELECT_TIMEOUT_SEC,
      });
    }
    this.startSelectTimer();
    const names = this.clients.map(c => c?.displayName || "?").join(" vs ");
    console.log(`[${this.code}] Lobby full (${names}), character select sent`);
  }

  // ---- 生命周期 ----

  /** 检查房间是否没有任何连接 */
  isEmpty(): boolean {
    return !this.clients[0] && !this.clients[1];
  }

  /** 检查是否应该被清理 */
  shouldCleanup(): boolean {
    if (this.isEmpty()) {
      const idle = Date.now() - this.lastActiveAt;
      if (this.gameStarted && this.game?.gameOver) {
        return idle > GAME_OVER_TTL_MS;
      }
      return idle > ROOM_TTL_MS;
    }
    return false;
  }

  /** 清理房间资源 */
  destroy(): void {
    if (this.selectTimer) clearTimeout(this.selectTimer);
    if (this.timeoutInterval) clearInterval(this.timeoutInterval);
    // 关闭剩余连接
    for (const c of this.clients) {
      if (c) c.socket.close();
    }
    console.log(`[${this.code}] Room destroyed`);
  }

  /** 获取断线玩家所在座位（用于身份校验提示） */
  getDisconnectedSeatFor(userId: string): number | null {
    for (let i = 0; i < 2; i++) {
      if (this.game?.disconnectedAt[i] !== null &&
          this.disconnectedUserId[i] === userId) {
        return i;
      }
    }
    return null;
  }

  /** 断线座位上的 userId */
  getDisconnectedUserId(seat: number): string | null {
    return this.disconnectedUserId[seat];
  }

  /** 有新连接时标记活跃 */
  touch(): void {
    this.lastActiveAt = Date.now();
  }
}

// ---------- 房间管理器 ----------

const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 排除易混淆字符 0/O/1/I/L
const ROOM_CODE_LEN = 6;

function generateRoomCode(): string {
  // 用 Web Crypto API 生成高质量随机数
  const bytes = new Uint8Array(ROOM_CODE_LEN);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
  }
  return code;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // 每 5 分钟清理一次过期房间
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60_000);
  }

  /** 创建新房间，返回房间码 */
  createRoom(): Room {
    let code: string;
    // 防碰撞循环（极低概率，但保险起见）
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code));

    const room = new Room(code);
    this.rooms.set(code, room);
    console.log(`Room ${code} created (total: ${this.rooms.size})`);
    return room;
  }

  /** 获取或创建房间 */
  getOrCreateRoom(code: string): Room {
    let room = this.rooms.get(code);
    if (!room) {
      room = new Room(code);
      this.rooms.set(code, room);
      console.log(`Room ${code} created via join (total: ${this.rooms.size})`);
    }
    return room;
  }

  /** 获取房间（不创建） */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** 移除房间 */
  removeRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room) {
      room.destroy();
      this.rooms.delete(code);
    }
  }

  /** 获取房间数 */
  get count(): number {
    return this.rooms.size;
  }

  /** 清理过期房间 */
  private cleanup(): void {
    const toRemove: string[] = [];
    for (const [code, room] of this.rooms) {
      if (room.shouldCleanup()) {
        toRemove.push(code);
      }
    }
    for (const code of toRemove) {
      this.removeRoom(code);
    }
    if (toRemove.length > 0) {
      console.log(`Cleaned up ${toRemove.length} rooms (remaining: ${this.rooms.size})`);
    }
  }
}

// ---------- 单例 ----------

export const roomManager = new RoomManager();
