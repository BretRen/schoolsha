// ============================================================
// effects.ts — 卡牌效果（可复用原语 + 注册表）
// ============================================================

import type { GameState, Card, PendingType } from "./types.ts";
import { hasCard, removeCard, shuffle } from "./cards.ts";
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

// ============================================================
// 可复用条件原语
// ============================================================

type Condition = (s: GameState, p: number) => boolean;

const isTurn: Condition = (s, p) => p === s.turnPlayer;
const phaseIs = (phase: string): Condition => (s) => s.phase === phase;
const playPhase: Condition = (s) => s.phase === "play";
const noPending: Condition = (s) => !s.pendingResponse;
const noAttack: Condition = (s) => !s.attackUsed;
const hpBelowMax: Condition = (s, p) => s.players[p].hp < s.players[p].maxHp;

function all(...conds: Condition[]): Condition {
  return (s, p) => conds.every((c) => c(s, p));
}

function any(...conds: Condition[]): Condition {
  return (s, p) => conds.some((c) => c(s, p));
}

/** 检查 pending 响应条件 */
function pendingIs(pendingType: PendingType): Condition {
  return (s, p) =>
    s.pendingResponse?.type === pendingType &&
    s.pendingResponse.target === p;
}

// ============================================================
// 可复用效果原语
// ============================================================

function dealDamage(s: GameState, source: number, target: number, amount: number) {
  s.players[target].hp -= amount;
  emit({ type: "damage", source, target, amount }, s);
}

function healTo(s: GameState, player: number, amount: number) {
  s.players[player].hp = Math.min(s.players[player].hp + amount, s.players[player].maxHp);
  emit({ type: "heal", player, amount }, s);
}

function setDodgePending(s: GameState, source: number, card: Card) {
  const opponent = 1 - source;
  s.pendingResponse = {
    type: "dodge",
    source,
    target: opponent,
    card,
    timeout: Date.now() + 15_000,
  };
}

function setNearDeathPending(s: GameState, source: number) {
  const target = 1 - source;
  s.pendingResponse = {
    type: "near_death",
    source,
    target,
    timeout: Date.now() + 15_000,
  };
}

/** 从对手手牌随机抽一张到自己手牌 */
function stealRandomCard(s: GameState, from: number, to: number): boolean {
  const hand = s.players[from].hand;
  if (hand.length === 0) return false;
  const idx = Math.floor(Math.random() * hand.length);
  const card = hand.splice(idx, 1)[0];
  s.players[to].hand.push(card);
  emit({ type: "card_played", player: to, card }, s);
  return true;
}

/** 从手牌随机弃一张 */
function discardRandomCard(s: GameState, player: number): boolean {
  const hand = s.players[player].hand;
  if (hand.length === 0) return false;
  const idx = Math.floor(Math.random() * hand.length);
  const card = hand.splice(idx, 1)[0];
  s.discard.push(card);
  emit({ type: "card_discarded", player, cards: [card] }, s);
  return true;
}

// ============================================================
// 卡牌效果注册
// ============================================================

registerCardEffect("杀", {
  canUse: all(playPhase, isTurn, noPending, noAttack),
  needsTarget: true,
  targetFilter: (_s, source, target) => source !== target,
  onUse: (s, playerIdx, card) => {
    s.attackUsed = true;
    setDodgePending(s, playerIdx, card);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("闪", {
  canUse: () => false,
  needsTarget: false,
  onUse: () => {},
  canRespond: pendingIs("dodge"),
});

registerCardEffect("桃", {
  canUse: any(pendingIs("near_death"), all(playPhase, isTurn, noPending, hpBelowMax)),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    healTo(s, playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

registerCardEffect("顺手牵羊", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, _card) => {
    const ok = stealRandomCard(s, 1 - playerIdx, playerIdx);
    if (!ok) {
      // 对手没牌——顺手牵羊白用了
      emit({ type: "card_played", player: playerIdx, card: _card, target: 1 - playerIdx }, s);
    }
  },
});

registerCardEffect("过河拆桥", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, _card) => {
    discardRandomCard(s, 1 - playerIdx);
    emit({ type: "card_played", player: playerIdx, card: _card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("决斗", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "duel",
      source: playerIdx,
      target: opponent,
      card,
      timeout: Date.now() + 15_000,
    };
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  // 响应决斗：也可以出杀
  canRespond: pendingIs("duel"),
});

// ============================================================
// 辅助函数
// ============================================================

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

  // 闪响应杀（dodge）
  if (pending.type === "dodge" && card.name === "闪") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 桃响应濒死
  if (pending.type === "near_death" && card.name === "桃") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.players[playerIdx].hp = 1;
    emit({ type: "heal", player: playerIdx, amount: 1 }, state);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 杀响应决斗
  if (pending.type === "duel" && card.name === "杀") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    emit({ type: "card_played", player: playerIdx, card }, state);

    // 切换到对方出杀
    const [source, target] = [pending.source, pending.target];
    state.pendingResponse = {
      type: "duel",
      source: target,
      target: source,
      card: pending.card,
      timeout: Date.now() + 15_000,
    };
    return null;
  }

  // 决斗中只能出杀
  if (pending.type === "duel") return "需要出【杀】";
  if (pending.type === "dodge") return "需要出【闪】";
  if (pending.type === "near_death") return "需要出【桃】";

  return "无效响应";
}

export function handleTimeout(state: GameState) {
  const pending = state.pendingResponse;
  if (!pending) return;

  if (pending.type === "dodge") {
    const target = pending.target;
    dealDamage(state, pending.source, target, 1);
    state.pendingResponse = null;

    if (state.players[target].hp <= 0) {
      setNearDeathPending(state, pending.source);
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

  if (pending.type === "duel") {
    // 没出杀 → 扣血
    const target = pending.target;
    dealDamage(state, pending.source, target, 1);
    state.pendingResponse = null;

    if (state.players[target].hp <= 0) {
      setNearDeathPending(state, pending.source);
    }
    return;
  }

  state.pendingResponse = null;
}
