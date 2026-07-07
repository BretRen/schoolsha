// ============================================================
// effects.ts — 卡牌效果（杀、闪、桃）
// ============================================================

import { hasCard, removeCard } from "./cards.ts";
import { emit } from "./events.ts";
import type { Card, CardName, GameState } from "./types.ts";

// ---------- 效果类型 ----------

export interface CardEffect {
  /** 主动使用条件 */
  canUse: (state: GameState, playerIdx: number, card: Card) => boolean;
  /** 需要选择目标 */
  needsTarget: boolean;
  /** 目标合法性（仅 needsTarget=true 时调用） */
  targetFilter?: (state: GameState, source: number, target: number) => boolean;
  /** 使用后的逻辑 */
  onUse: (
    state: GameState,
    playerIdx: number,
    card: Card,
    target?: number,
  ) => void;
  /** 可作为响应使用 */
  canRespond?: (state: GameState, playerIdx: number, card: Card) => boolean;
}

// ---------- 效果注册表 ----------

export const cardEffects: Record<CardName, CardEffect> = {
  "杀": {
    canUse: (state, playerIdx) =>
      state.phase === "play" &&
      playerIdx === state.turnPlayer &&
      !state.attackUsed &&
      state.pendingResponse === null,
    needsTarget: true,
    targetFilter: (_state, source, target) => source !== target,
    onUse: (state, playerIdx, card, target) => {
      state.attackUsed = true;
      const opponent = 1 - playerIdx;

      // 设置等待出闪
      state.pendingResponse = {
        type: "dodge",
        source: playerIdx,
        target: opponent,
        card,
        timeout: Date.now() + 15_000,
      };

      emit({ type: "card_played", player: playerIdx, card, target }, state);
    },
  },

  "闪": {
    // 闪不能主动使用，只能响应杀
    canUse: () => false,
    needsTarget: false,
    onUse: () => {},

    canRespond: (state, playerIdx, _card) =>
      state.pendingResponse?.type === "dodge" &&
      state.pendingResponse.target === playerIdx,
  },

  "桃": {
    canUse: (state, playerIdx, _card) => {
      if (
        state.pendingResponse?.type === "near_death" &&
        state.pendingResponse.target === playerIdx
      ) {
        return true;
      }
      return state.phase === "play" &&
        playerIdx === state.turnPlayer &&
        state.players[playerIdx].hp < state.players[playerIdx].maxHp &&
        state.pendingResponse === null;
    },
    needsTarget: false,
    onUse: (state, playerIdx, _card) => {
      state.players[playerIdx].hp++;
      emit({ type: "heal", player: playerIdx, amount: 1 }, state);
      emit({ type: "card_played", player: playerIdx, card: _card }, state);
    },
  },

  "决斗": {
    canUse: (state, playerIdx) =>
      state.phase === "play" &&
      playerIdx === state.turnPlayer &&
      state.pendingResponse === null,
    needsTarget: true,
    targetFilter: (_state, source, target) => source !== target,
    onUse: (state, playerIdx) => {
      state.pendingResponse = {
        type: "duel",
        source: playerIdx, // 谁发起的决斗
        target: 1 - playerIdx, // 谁现在必须出杀
        awaiting: playerIdx, // 对方（等下轮到自己时翻转）
        timeout: Date.now() + 15_000,
      };
    },
  },
};

// ---------- 辅助函数 ----------

/** 玩家主动使用一张牌 */
export function tryUseCard(
  state: GameState,
  playerIdx: number,
  cardId: string,
  target?: number,
): string | null {
  // 检查是否有等待响应
  if (state.pendingResponse) {
    return tryRespond(state, playerIdx, cardId);
  }

  // 不能在别人的回合出牌
  if (playerIdx !== state.turnPlayer) return "不是你的回合";
  if (state.phase !== "play") return "只能在出牌阶段使用";
  if (state.pendingResponse) return "请先响应";

  const player = state.players[playerIdx];
  if (!hasCard(player.hand, cardId)) return "你没有这张牌";

  const card = player.hand.find((c) => c.id === cardId)!;
  const effect = cardEffects[card.name];

  // 检查 canUse
  if (!effect.canUse(state, playerIdx, card)) {
    return `不能使用【${card.name}】`;
  }

  // 检查目标
  let finalTarget = target;
  if (effect.needsTarget) {
    if (target === undefined) return "请选择目标";
    const opponent = state.players[1 - playerIdx];
    if (!opponent.alive) return "对手已死亡";
    finalTarget = 1 - playerIdx; // 1v1 只能打对手
  }

  // 消耗牌
  removeCard(player.hand, cardId);
  state.discard.push(card);

  // 执行效果
  effect.onUse(state, playerIdx, card, finalTarget);

  return null; // 成功
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

  if (pending.type === "duel") {
    // 验牌必须是杀
    if (card.name !== "杀") return "需要出【杀】";

    // 消耗牌
    removeCard(player.hand, cardId);
    state.discard.push(card);

    // 翻转目标：等的那个人变成响应者，响应者变成等待者
    const nextTarget = pending.awaiting!;
    pending.target = nextTarget; // 现在轮到对方出杀
    pending.awaiting = playerIdx; // 当前响应者变成等待方
    pending.timeout = Date.now() + 15_000; // 重置计时
  }

  // 消耗牌
  removeCard(player.hand, cardId);
  state.discard.push(card);

  if (pending.type === "near_death") {
    state.players[playerIdx].hp = 1;
    emit({ type: "heal", player: playerIdx, amount: 1 }, state);
  }

  // 闪抵消杀 → 清除 pending
  state.pendingResponse = null;
  emit({ type: "card_played", player: playerIdx, card }, state);

  return null;
}

/** 超时未响应 */
export function handleTimeout(state: GameState) {
  const pending = state.pendingResponse;
  if (!pending) return;

  if (pending.type === "dodge") {
    // 没出闪 → 扣血
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

  if (pending.type === "duel") {
    // 当前 target 没出杀 → 扣血
    state.players[pending.target].hp--;
    emit({
      type: "damage",
      source: pending.source,
      target: pending.target,
      amount: 1,
    }, state);
    state.pendingResponse = null;

    // 然后检查濒死...
    if (state.players[pending.target].hp <= 0) {
      state.pendingResponse = {
        type: "near_death",
        source: pending.source,
        target: pending.target,
        timeout: Date.now() + 15_000,
      };
    }
    return;
  }

  if (pending.type === "near_death") {
    handleDeath(state, pending.target);
    return;
  }

  state.pendingResponse = null;
}

export function handleDeath(state: GameState, playerIdx: number) {
  state.players[playerIdx].alive = false;
  state.players[playerIdx].hp = 0;
  emit({ type: "player_death", player: playerIdx }, state);
  state.pendingResponse = null;
  state.gameOver = true;
  state.winner = 1 - playerIdx;
}
