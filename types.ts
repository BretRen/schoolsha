// ============================================================
// types.ts — 所有类型和常量
// ============================================================

export type Suit = "spade" | "heart" | "club" | "diamond";
export type CardName = "杀" | "闪" | "桃" | "决斗";
export type Phase = "judge" | "draw" | "play" | "discard" | "end";

export interface Card {
  id: string;
  name: CardName;
  suit: Suit;
  number: number; // 1-13
}

export interface Player {
  hp: number;
  maxHp: number; // 默认 3
  hand: Card[];
  alive: boolean;
}

export type PendingType = "dodge" | "near_death" | "duel";

export interface PendingResponse {
  type: PendingType;
  source: number; // 谁发起的（出杀的人 / 濒死的人）
  target: number; // 谁需要响应
  card?: Card; // 关联的牌（比如那张杀）
  timeout: number; // 截止时间戳 ms
  awaiting?: number; // 决斗用：对方是谁（不参与当前响应，但等待中）
}

export interface GameState {
  phase: Phase;
  turnPlayer: number; // 0 or 1
  players: [Player, Player];
  deck: Card[];
  discard: Card[];
  attackUsed: boolean;
  pendingResponse: PendingResponse | null;
  gameOver: boolean;
  winner: number | null;
}

// ---------- WebSocket 消息 ----------

export type ClientMsg =
  | { action: "ready" }
  | { action: "play_card"; card_id: string; target?: number }
  | { action: "end_phase" }
  | { action: "discard"; card_ids: string[] }
  | { action: "pass" };

export interface PlayerView {
  hp: number;
  maxHp: number;
  handCount: number;
  alive: boolean;
}

export interface ServerStateView {
  phase: Phase;
  turnPlayer: number;
  you: { hp: number; maxHp: number; hand: Card[]; alive: boolean };
  opponent: PlayerView;
  attackUsed: boolean;
  pendingResponse: PendingResponse | null;
  gameOver: boolean;
  winner: number | null;
  deckCount: number;
}

export type ServerMsg =
  | { type: "game_state"; state: ServerStateView; yourIndex: number }
  | { type: "error"; message: string };
