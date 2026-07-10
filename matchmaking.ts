// ============================================================
// matchmaking.ts — ELO 匹配队列
// ============================================================

import { getElo } from "./elo.ts";
import { roomManager } from "./room.ts";

const MATCH_JOIN_TIMEOUT_MS = 30_000; // 30秒内双方必须连接

// ---------- 匹配玩家 ----------

interface QueuedPlayer {
  userId: string;
  displayName: string;
  elo: number;
  socket: WebSocket;
  joinedAt: number;
}

// ---------- 队列 ----------

const MAX_ELO_DIFF = 300; // ELO 差距超过 300 不匹配
const QUEUE_TIMEOUT_MS = 5 * 60_000; // 5 分钟超时
const MATCH_RETRY_MS = 10_000; // 每 10 秒重试匹配

class MatchmakingQueue {
  private queue: QueuedPlayer[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  /** 加入队列 */
  join(userId: string, displayName: string, socket: WebSocket): void {
    // 防止重复加入
    if (this.queue.find((p) => p.userId === userId)) {
      this.send(socket, { type: "error", message: "已在匹配队列中" });
      return;
    }

    const elo = getElo(userId);
    const player: QueuedPlayer = {
      userId,
      displayName,
      elo,
      socket,
      joinedAt: Date.now(),
    };

    this.queue.push(player);
    console.log(`[matchmaking] ${displayName || userId} joined queue (elo=${elo})`);

    this.send(socket, {
      type: "queue_status",
      status: "waiting",
      position: this.queue.length,
      estimatedWait: `${this.queue.length * 5}s`,
    });

    // 尝试立即匹配
    this.tryMatch(player);

    // 启动重试定时器
    this.startRetry();
  }

  /** 离开队列 */
  leave(userId: string): void {
    const idx = this.queue.findIndex((p) => p.userId === userId);
    if (idx === -1) return;
    const p = this.queue[idx];
    this.queue.splice(idx, 1);
    console.log(`[matchmaking] ${p.displayName || userId} left queue`);
    // 通知队列中剩余玩家
    for (const other of this.queue) {
      this.send(other.socket, {
        type: "queue_status",
        status: "waiting",
        position: this.queue.indexOf(other) + 1,
        estimatedWait: `${this.queue.length * 5}s`,
      });
    }
    if (this.queue.length === 0) this.stopRetry();
  }

  /** 获取队列长度 */
  get length(): number {
    return this.queue.length;
  }

  // ---- 私有方法 ----

  private startRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => this.retryMatches(), MATCH_RETRY_MS);
  }

  private stopRetry(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 定时重试所有未匹配的玩家 */
  private retryMatches(): void {
    // 检查超时
    const now = Date.now();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (now - this.queue[i].joinedAt > QUEUE_TIMEOUT_MS) {
        this.send(this.queue[i].socket, {
          type: "queue_timeout",
          message: "匹配超时，请重新加入",
        });
        this.queue.splice(i, 1);
      }
    }

    if (this.queue.length === 0) {
      this.stopRetry();
      return;
    }

    // 尝试匹配
    for (const player of [...this.queue]) {
      if (!this.queue.includes(player)) continue; // 已被匹配移除
      this.tryMatch(player);
    }
  }

  /**
   * 为指定玩家寻找最优匹配
   * 返回匹配的对手，或 null
   */
  private findBestMatch(player: QueuedPlayer): QueuedPlayer | null {
    let best: QueuedPlayer | null = null;
    let bestDiff = Infinity;

    for (const other of this.queue) {
      if (other.userId === player.userId) continue;
      if (other.socket.readyState !== WebSocket.OPEN) {
        this.removePlayer(other.userId);
        continue;
      }
      const diff = Math.abs(player.elo - other.elo);
      if (diff < bestDiff && diff <= MAX_ELO_DIFF) {
        best = other;
        bestDiff = diff;
      }
    }

    return best;
  }

  /** 尝试匹配 */
  private tryMatch(player: QueuedPlayer): void {
    const opponent = this.findBestMatch(player);
    if (!opponent) return;

    // 匹配成功！从队列移除双方
    this.removePlayer(player.userId);
    this.removePlayer(opponent.userId);

    console.log(`[matchmaking] matched: ${player.displayName} (${player.elo}) vs ${opponent.displayName} (${opponent.elo})`);

    // 生成房间码并预创建房间
    const code = generateRoomCode();
    const room = roomManager.getOrCreateRoom(code);
    room.isMatch = true; // 标记为匹配对战房间

    // 30秒后如果房间还是空的 → 清理
    const joinTimer = setTimeout(() => {
      if (room.isEmpty()) {
        console.log(`[matchmaking] Room ${code} join timeout, cleaning up`);
        roomManager.removeRoom(code);
      }
    }, MATCH_JOIN_TIMEOUT_MS);

    // 通知双方
    const matchMsg = {
      type: "match_found" as const,
      room: code,
      opponent: { displayName: opponent.displayName, elo: opponent.elo },
    };
    const matchMsg2 = {
      type: "match_found" as const,
      room: code,
      opponent: { displayName: player.displayName, elo: player.elo },
    };

    this.send(player.socket, matchMsg);
    this.send(opponent.socket, matchMsg2);

    // 关闭双方的匹配 WebSocket（客户端收到 match_found 后会自己关）
    // 延迟关闭，确保消息送达
    setTimeout(() => {
      try { player.socket.close(); } catch { /* ok */ }
      try { opponent.socket.close(); } catch { /* ok */ }
    }, 500);

    if (this.queue.length === 0) this.stopRetry();
  }

  private removePlayer(userId: string): void {
    const idx = this.queue.findIndex((p) => p.userId === userId);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // 连接已断
    }
  }
}

// ---------- 单例 ----------

export const matchmaking = new MatchmakingQueue();

// ---------- 房间码生成（与 room.ts 保持一致） ----------

const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LEN = 6;

function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LEN);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
  }
  return code;
}
