// ============================================================
// effects.ts — 卡牌效果（杀、闪、桃）
// ============================================================

import type { GameState, Card } from "./types.ts";
import { hasCard, removeCard } from "./cards.ts";
import { emit } from "./events.ts";

// ---------- 效果类型 ----------

export interface CardEffect {
  /** 主动使用条件 */
  canUse: (state: GameState, playerIdx: number, card: Card) => boolean;
  /** 需要选择目标 */
  needsTarget: boolean;
  /** 目标合法性（仅 needsTarget=true 时调用） */
  targetFilter?: (state: GameState, source: number, target: number) => boolean;
  /** 使用后的逻辑 */
  onUse: (state: GameState, playerIdx: number, card: Card, target?: number) => void;
  /** 可作为响应使用 */
  canRespond?: (state: GameState, playerIdx: number, card: Card) => boolean;
}

// ---------- 效果注册表 ----------

const effectMap = new Map<string, CardEffect>();

export function registerCardEffect(name: string, effect: CardEffect) {
  effectMap.set(name, effect);
}

export function getCardEffect(name: string): CardEffect | undefined {
  return effectMap.get(name);
}

// ---------- 内置卡牌效果 ----------

registerCardEffect("杀", {
  canUse: (state, playerIdx, _card) =>
    state.phase === "play" &&
    playerIdx === state.turnPlayer &&
    !state.attackUsed &&
    state.pendingResponse === null,
  needsTarget: true,
  targetFilter: (_state, source, target) => source !== target,
  onUse: (state, playerIdx, card, _target) => {
    state.attackUsed = true;
    const opponent = 1 - playerIdx;
    state.pendingResponse = {
      type: "dodge",
      source: playerIdx,
      target: opponent,
      card,
      timeout: Date.now() + 15_000,
    };
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, state);
  },
});

registerCardEffect("闪", {
  canUse: () => false,
  needsTarget: false,
  onUse: () => {},
  canRespond: (state, playerIdx, _card) =>
    state.pendingResponse?.type === "dodge" &&
    state.pendingResponse.target === playerIdx,
});

registerCardEffect("桃", {
  canUse: (state, playerIdx, _card) => {
    if (state.pendingResponse?.type === "near_death" && state.pendingResponse.target === playerIdx) {
      return true;
    }
    return state.phase === "play" &&
      playerIdx === state.turnPlayer &&
      state.players[playerIdx].hp < state.players[playerIdx].maxHp &&
      state.pendingResponse === null;
  },
  needsTarget: false,
  onUse: (state, playerIdx, card) => {
    state.players[playerIdx].hp++;
    emit({ type: "heal", player: playerIdx, amount: 1 }, state);
    emit({ type: "card_played", player: playerIdx, card }, state);
  },
});

// ---------- 辅助函数 ----------

/** 玩家主动使用一张牌 */
export function tryUseCard(
  state: GameState,
  playerIdx: number,
  cardId: string,
  target?: number,
): string | null {
  if (state.pendingResponse) {
    return tryRespond(state, playerIdx, cardId);
  }

  if (playerIdx !== state.turnPlayer) return "不是你的回合";
  if (state.phase !== "play") return "只能在出牌阶段使用";
  if (state.pendingResponse) return "请先响应";

  const player = state.players[playerIdx];
  if (!hasCard(player.hand, cardId)) return "你没有这张牌";

  const card = player.hand.find((c) => c.id === cardId)!;
  const effect = getCardEffect(card.name);

  if (!effect) return `未知卡牌: ${card.name}`;
  if (!effect.canUse(state, playerIdx, card)) {
    return `不能使用【${card.name}】`;
  }

  let finalTarget = target;
  if (effect.needsTarget) {
    if (target === undefined) return "请选择目标";
    const opponent = state.players[1 - playerIdx];
    if (!opponent.alive) return "对手已死亡";
    finalTarget = 1 - playerIdx;
  }

  removeCard(player.hand, cardId);
  state.discard.push(card);
  effect.onUse(state, playerIdx, card, finalTarget);

  return null;
}

/** 响应 pending（比如出闪） */
export function tryRespond(
  state: GameState,
  playerIdx: number,
  cardId: string,
): string | null {
  const pending = state.pendingResponse;
  if (!pending) return null;

  if (playerIdx !== pending.target) return "不是你需要响应";

  const player = state.players[playerIdx];
  if (!hasCard(player.hand, cardId)) return "你没有这张牌";

  const card = player.hand.find((c) => c.id === cardId)!;

  if (pending.type === "dodge" && card.name !== "闪") {
    return "需要出【闪】";
  }
  if (pending.type === "near_death" && card.name !== "桃") {
    return "需要出【桃】";
  }

  removeCard(player.hand, cardId);
  state.discard.push(card);

  if (pending.type === "near_death") {
    state.players[playerIdx].hp = 1;
    emit({ type: "heal", player: playerIdx, amount: 1 }, state);
  }

  state.pendingResponse = null;
  emit({ type: "card_played", player: playerIdx, card }, state);

  return null;
}

/** 超时未响应 */
export function handleTimeout(state: GameState) {
  const pending = state.pendingResponse;
  if (!pending) return;

  if (pending.type === "dodge") {
    const target = pending.target;
    state.players[target].hp--;
    emit(
      { type: "damage", source: pending.source, target, amount: 1 },
      state,
    );
    state.pendingResponse = null;

    if (state.players[target].hp <= 0) {
      state.pendingResponse = {
        type: "near_death",
        source: pending.source,
        target,
        timeout: Date.now() + 15_000,
      };
    }
    return;
  }

  if (pending.type === "near_death") {
    const target = pending.target;
    state.players[target].alive = false;
    state.players[target].hp = 0;
    emit({ type: "player_death", player: target }, state);
    state.pendingResponse = null;
    state.gameOver = true;
    state.winner = 1 - target;
    return;
  }

  state.pendingResponse = null;
}

function handleDeath(state: GameState, playerIdx: number) {
  state.players[playerIdx].alive = false;
  emit({ type: "player_death", player: playerIdx }, state);
  state.gameOver = true;
  state.winner = 1 - playerIdx;
}
