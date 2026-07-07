// ============================================================
// events.ts — 事件系统（为技能系统留坑）
// ============================================================

import type { Card, GameState, Phase } from "./types.ts";

// ---------- 事件类型 ----------

export type GameEvent =
  | { type: "phase_enter"; phase: Phase; player: number }
  | { type: "phase_exit"; phase: Phase; player: number }
  | { type: "draw_card"; player: number; cards: Card[] }
  | { type: "card_played"; player: number; card: Card; target?: number }
  | { type: "card_discarded"; player: number; cards: Card[] }
  | { type: "damage"; source: number; target: number; amount: number }
  | { type: "heal"; player: number; amount: number }
  | { type: "player_death"; player: number }
  | { type: "turn_start"; player: number }
  | { type: "turn_end"; player: number };

// ---------- 处理器（当前为空，技能系统接入点） ----------

type EventHandler = (event: GameEvent, state: GameState) => void;
const handlers: EventHandler[] = [];

export function onEvent(handler: EventHandler) {
  handlers.push(handler);
}

export function emit(event: GameEvent, state: GameState) {
  console.log(`[Event] ${event.type}`, JSON.stringify(event).slice(0, 120));
  for (const handler of handlers) {
    handler(event, state);
  }
}
