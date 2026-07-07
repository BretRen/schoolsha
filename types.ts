// ============================================================
// types.ts — 所有类型和常量
// ============================================================

export type Suit = "spade" | "heart" | "club" | "diamond";
export type Phase = "judge" | "draw" | "play" | "discard" | "end";
export type CardType = "basic" | "trick" | "weapon" | "armor";

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

export type PendingType = "dodge" | "near_death" | "duel" | "barbarian" | "volley" | "borrow_knife";

export interface PendingResponse {
  type: PendingType;
  source: number;
  target: number;
  card?: Card;
  timeout: number;
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
  | { action: "pass" }
  | { action: "reconnect"; seat: number };

export interface CharacterInfo {
  id: string;
  name: string;
  maxHp: number;
  skills: string[];
}

export interface PlayerView {
  hp: number;
  maxHp: number;
  handCount: number;
  alive: boolean;
  characterId: string | null;
  weapon: Card | null;
  armor: Card | null;
}

export interface ServerStateView {
  phase: Phase;
  turnPlayer: number;
  you: {
    hp: number; maxHp: number; hand: Card[]; alive: boolean;
    characterId: string | null; skills: string[];
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
}

export type ServerMsg =
  | { type: "character_select"; characters: CharacterInfo[]; timeoutSec: number }
  | { type: "game_state"; state: ServerStateView; yourIndex: number }
  | { type: "waiting"; message: string }
  | { type: "disconnected"; message: string; attemptsLeft: number }
  | { type: "reconnected"; message: string }
  | { type: "error"; message: string };
