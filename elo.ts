// ============================================================
// elo.ts — ELO 积分计算 + 排行榜
// ============================================================

const ELO_FILE = "./elo.json";
const INITIAL_ELO = 1000;
const K_FACTOR = 32;

// ELO 操作在 Deno 单线程环境无并发问题，无需锁
function withEloLock(fn: () => void): void {
  fn();
}

// ---------- 数据结构 ----------

export interface EloEntry {
  elo: number;
  wins: number;
  losses: number;
  displayName: string;
}

export interface LeaderboardEntry extends EloEntry {
  userId: string;
  rank: number;
}

export interface Leaderboard {
  top10: LeaderboardEntry[];
  you: LeaderboardEntry | null;
}

// ---------- 持久化 ----------

function loadElo(): Record<string, EloEntry> {
  try {
    const raw = Deno.readTextFileSync(ELO_FILE);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveElo(data: Record<string, EloEntry>): void {
  const tmp = ELO_FILE + ".tmp";
  Deno.writeTextFileSync(tmp, JSON.stringify(data, null, 2));
  Deno.renameSync(tmp, ELO_FILE);
}

// ---------- ELO 计算 ----------

/**
 * 更新 ELO 分数
 * @param winnerId   胜者 userId
 * @param loserId    败者 userId
 * @param winnerName 胜者显示名
 * @param loserName  败者显示名
 */
export function updateElo(
  winnerId: string,
  loserId: string,
  winnerName: string,
  loserName: string,
): {
  winnerChange: number;
  loserChange: number;
  winnerNewElo: number;
  loserNewElo: number;
} {
  // 整个 read-modify-write 在锁内，防竞态
  let result: {
    winnerChange: number;
    loserChange: number;
    winnerNewElo: number;
    loserNewElo: number;
  };
  withEloLock(() => {
    const data = loadElo();

    if (!data[winnerId]) {
      data[winnerId] = {
        elo: INITIAL_ELO,
        wins: 0,
        losses: 0,
        displayName: winnerName || winnerId,
      };
    }
    if (!data[loserId]) {
      data[loserId] = {
        elo: INITIAL_ELO,
        wins: 0,
        losses: 0,
        displayName: loserName || loserId,
      };
    }
    if (winnerName) data[winnerId].displayName = winnerName.slice(0, 64);
    if (loserName) data[loserId].displayName = loserName.slice(0, 64);

    const w = data[winnerId], l = data[loserId];
    const oldW = w.elo, oldL = l.elo;

    const eWinner = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));

    w.elo = Math.round(w.elo + K_FACTOR * (1 - eWinner));
    l.elo = Math.round(l.elo + K_FACTOR * (0 - eWinner));
    if (w.elo < 0) w.elo = 0;
    if (l.elo < 0) l.elo = 0;

    w.wins++;
    l.losses++;
    saveElo(data);
    result = {
      winnerChange: w.elo - oldW,
      loserChange: l.elo - oldL,
      winnerNewElo: w.elo,
      loserNewElo: l.elo,
    };
  });
  return result!;
}

/**
 * 预测 ELO 变化（不保存）
 */
export function predictEloChange(
  myElo: number,
  oppElo: number,
): { win: number; lose: number } {
  const eWin = 1 / (1 + Math.pow(10, (oppElo - myElo) / 400));
  return {
    win: Math.round(K_FACTOR * (1 - eWin)),
    lose: Math.round(K_FACTOR * (0 - eWin)),
  };
}

/**
 * 获取排行榜
 * @param topK          前几名
 * @param playerUserId  当前玩家 ID（用于查自己的排名，可选）
 */
export function getLeaderboard(
  topK: number,
  playerUserId?: string,
): Leaderboard {
  const data = loadElo();

  // 按 ELO 降序排列
  const sorted = Object.entries(data)
    .sort((a, b) => b[1].elo - a[1].elo)
    .map(([userId, entry], i) => ({ userId, ...entry, rank: i + 1 }));

  const top10: LeaderboardEntry[] = [];
  let you: LeaderboardEntry | null = null;

  for (const entry of sorted) {
    if (top10.length < topK) top10.push(entry);
    if (playerUserId && entry.userId === playerUserId) you = entry;
  }

  return { top10, you };
}

/**
 * 获取某个玩家的 ELO 分数
 */
export function getElo(userId: string): number {
  const data = loadElo();
  return data[userId]?.elo ?? INITIAL_ELO;
}
