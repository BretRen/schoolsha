// ============================================================
// events.ts — 事件系统（技能系统的核心入口）
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

// ---------- 处理器 ----------

type EventHandlerFn = (event: GameEvent, state: GameState) => void;

interface RegisteredHandler {
  eventTypes: string[];
  fn: EventHandlerFn;
}

const handlers: RegisteredHandler[] = [];

/**
 * 注册事件处理器。返回 unsubscribe 函数。
 *
 * @param eventTypes - 要监听的 GameEvent['type'] 列表
 * @param fn - 事件触发时的回调
 * @returns 调用可取消注册
 */
export function onEvent(
  eventTypes: string[],
  fn: EventHandlerFn,
): () => void {
  const entry: RegisteredHandler = { eventTypes, fn };
  handlers.push(entry);
  return () => {
    const idx = handlers.indexOf(entry);
    if (idx !== -1) handlers.splice(idx, 1);
  };
}

/**
 * 触发事件。遍历所有监听该事件类型的 handler。
 */
export function emit(event: GameEvent, state: GameState) {
  console.log(
    `[Event] ${event.type}`,
    JSON.stringify(event).slice(0, 120),
  );

  for (const entry of handlers) {
    if (entry.eventTypes.includes(event.type)) {
      entry.fn(event, state);
    }
  }
}
