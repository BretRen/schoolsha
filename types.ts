// ============================================================
// types.ts — 所有类型和常量
// ============================================================

export type Suit = "spade" | "heart" | "club" | "diamond";
export type Phase = "judge" | "draw" | "play" | "discard" | "end";
export type CardType = "basic" | "trick" | "weapon" | "armor";

// ---------- 结构化日志（便于 i18n）----------

export type LogEntry = {
  id: "card_played"; player: number; cardName: string; target?: number;
} | {
  id: "card_equipped"; player: number; cardName: string;
} | {
  id: "damage"; player: number; amount: number;
} | {
  id: "heal"; player: number; amount: number;
} | {
  id: "skill_used"; player: number; skillName: string;
} | {
  id: "phase"; player: number; phase: string;
} | {
  id: "draw"; player: number; count: number;
} | {
  id: "discard"; player: number; cardName: string;
} | {
  id: "card_discarded"; player: number; cardName: string;
} | {
  id: "death"; player: number;
};

export interface Card {
  id: string;
  name: string;
  suit: Suit;
  number: number;
  type: CardType;
}

export interface Player {
  hp: number;
  maxHp: number;
  hand: Card[];
  alive: boolean;
  characterId: string | null;
  weapon: Card | null;
  armor: Card | null;
}

export type PendingType = "dodge" | "near_death" | "duel" | "barbarian" | "volley" | "borrow_knife" | "steal" | "skill_discard";

export interface PendingResponse {
  type: PendingType;
  source: number;
  target: number;
  card?: Card;
  timeout: number;
  /** steal 类型时，可选的牌列表（明选，旧版） */
  selectableCards?: Card[];
  /** steal 类型时，对手牌数量（盲选） */
  poolSize?: number;
  /** 选牌后的动作：偷(默认) 或 弃 */
  stealAction?: "steal" | "discard";
  /** skill_discard 类型时，待确认的技能 ID */
  pendingSkillId?: string;
  /** skill_discard 类型时，需要弃牌的数量 */
  discardCount?: number;
}

export interface GameState {
  phase: Phase;
  turnPlayer: number;
  players: [Player, Player];
  deck: Card[];
  discard: Card[];
  attackUsed: boolean;
  pendingResponse: PendingResponse | null;
  gameOver: boolean;
  winner: number | null;
  /** 当前回合开始时间（用于回合超时检测） */
  turnStartTime: number;
  /** 每名玩家的断线次数（最多3次） */
  disconnectCount: [number, number];
  /** 每名玩家的断线起始时间（null = 在线） */
  disconnectedAt: [number | null, number | null];
  /** 酒/辣条效果：本回合下一张作业伤害+1 */
  wineUsed: boolean;
  /** 技能每回合使用次数（多房间隔离） */
  skillUseCount: Record<string, number>;
  /** 对局日志 */
  log: LogEntry[];
}

// ---------- JSON 配置类型 ----------

export interface CardSpec {
  name: string;
  suit: Suit;
  number: number;
  count: number;
  type: CardType;
}

export interface CardsConfig {
  cards: CardSpec[];
}

// ---------- WebSocket 消息 ----------

export type ClientMsg =
  | { action: "ready" }
  | { action: "pick_character"; id: string }
  | { action: "play_card"; card_id: string; target?: number }
  | { action: "use_skill"; skill_id: string; target?: number }
  | { action: "end_phase" }
  | { action: "discard"; card_ids: string[] }
  | { action: "steal_card"; card_id?: string; position?: number }
  | { action: "pass" }
  | { action: "respond"; card_id: string }
  | { action: "reconnect"; seat: number }
  | { action: "confirm_skill"; card_ids: string[] }
  | { action: "lock_character" };

export interface CharacterInfo {
  id: string;
  name: string;
  maxHp: number;
  skills: string[];
}

export interface SkillView {
  id: string;
  name: string;
  type: string; // "active" | "passive" | "locked"
}

export interface PlayerView {
  hp: number;
  maxHp: number;
  handCount: number;
  alive: boolean;
  characterId: string | null;
  weapon: Card | null;
  armor: Card | null;
  skills: SkillView[];
}

export interface ServerStateView {
  phase: Phase;
  turnPlayer: number;
  you: {
    hp: number; maxHp: number; hand: Card[]; alive: boolean;
    characterId: string | null; skills: SkillView[];
    weapon: Card | null; armor: Card | null;
  };
  opponent: PlayerView;
  attackUsed: boolean;
  pendingResponse: PendingResponse | null;
  gameOver: boolean;
  winner: number | null;
  deckCount: number;
  turnTimeLeft: number;
  opponentDisconnected: boolean;
  /** 自己的显示名称 */
  playerName: string;
  /** 自己的唯一 ID */
  playerId: string;
  /** 对手的显示名称 */
  opponentName: string;
  /** 对手的唯一 ID */
  opponentId: string;
  /** 当前手牌上限（含技能加成） */
  handLimit: number;
  /** 对局日志 */
  log: LogEntry[];
}

export type ServerMsg =
  | { type: "character_select"; characters: CharacterInfo[]; timeoutSec: number; opponent?: { displayName: string; elo: number; userId: string }; elo?: { my: number; prediction: { win: number; lose: number } | null } }
  | { type: "game_state"; state: ServerStateView; yourIndex: number; eloResult?: { change: number; newElo: number; opponentChange: number } }
  | { type: "waiting"; message: string }
  | { type: "disconnected"; message: string; attemptsLeft: number }
  | { type: "room_created"; code: string; inviteUrl: string; wsUrl: string }
  | { type: "reconnected"; message: string }
  | { type: "error"; message: string }
  | { type: "queue_status"; status: string; position: number; estimatedWait: string }
  | { type: "match_found"; room: string; opponent: { displayName: string; elo: number } }
  | { type: "queue_timeout"; message: string }
  | { type: "opponent_picked"; picked: boolean }
  | { type: "opponent_locked"; locked: boolean }
  | { type: "opponent_left_win"; message: string };

/** /room/create 响应 */
export interface RoomInfo {
  code: string;
  wsUrl: string;
  inviteUrl: string;
  deepLink: string;
}
