// ============================================================
// effects.ts — 卡牌效果（可复用原语 + 全卡牌注册表）
// ============================================================

import type { GameState, Card, PendingType } from "./types.ts";
import { hasCard, removeCard, drawCards } from "./cards.ts";
import { emit } from "./events.ts";

// ---------- 效果类型 ----------

export interface CardEffect {
  canUse: (state: GameState, playerIdx: number, card: Card) => boolean;
  needsTarget: boolean;
  targetFilter?: (state: GameState, source: number, target: number) => boolean;
  onUse: (state: GameState, playerIdx: number, card: Card, target?: number) => void;
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

function stealRandomCard(s: GameState, from: number, to: number): boolean {
  const hand = s.players[from].hand;
  if (hand.length === 0) return false;
  const idx = Math.floor(Math.random() * hand.length);
  const card = hand.splice(idx, 1)[0];
  s.players[to].hand.push(card);
  emit({ type: "card_played", player: to, card }, s);
  return true;
}

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
// 卡牌效果注册 — 全部使用学校主题名称
// ============================================================

// 基本牌

registerCardEffect("作业", {
  canUse: all(playPhase, isTurn, noPending, noAttack),
  needsTarget: true,
  targetFilter: (_s, source, target) => source !== target,
  onUse: (s, playerIdx, card) => {
    s.attackUsed = true;
    setDodgePending(s, playerIdx, card);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("赦免", {
  canUse: () => false,
  needsTarget: false,
  onUse: () => {},
  canRespond: pendingIs("dodge"),
});

registerCardEffect("放假", {
  canUse: any(pendingIs("near_death"), all(playPhase, isTurn, noPending, hpBelowMax)),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    healTo(s, playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

registerCardEffect("辣条", {
  canUse: any(
    pendingIs("near_death"),
    all(playPhase, isTurn, noPending),
  ),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    // 濒死用：回血（同放假）
    if (s.pendingResponse?.type === "near_death") {
      s.players[playerIdx].hp = 1;
      emit({ type: "heal", player: playerIdx, amount: 1 }, s);
      s.pendingResponse = null;
    } else {
      // 出牌阶段用：下一张作业伤害+1
      s.wineUsed = true;
    }
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

// 锦囊牌 — 即时

registerCardEffect("拼作业", {
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
  canRespond: pendingIs("duel"),
});

registerCardEffect("神偷", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    stealRandomCard(s, 1 - playerIdx, playerIdx);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("打小报告", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    discardRandomCard(s, 1 - playerIdx);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

// 锦囊牌 — 需要对手响应

registerCardEffect("作业检查", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "barbarian",
      source: playerIdx,
      target: opponent,
      card,
      timeout: Date.now() + 15_000,
    };
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  canRespond: pendingIs("barbarian"),
});

registerCardEffect("最终测试", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "volley",
      source: playerIdx,
      target: opponent,
      card,
      timeout: Date.now() + 15_000,
    };
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  canRespond: pendingIs("volley"),
});

registerCardEffect("嫁祸", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "borrow_knife",
      source: playerIdx,
      target: opponent,
      card,
      timeout: Date.now() + 15_000,
    };
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  // 对手可以弃牌或扣血——弃牌通过 discard 响应（简化：任何牌都行，视为"给武器"）
  canRespond: pendingIs("borrow_knife"),
});

// 锦囊牌 — 即刻生效

registerCardEffect("团队项目", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    dealDamage(s, playerIdx, opponent, 2);
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
});

registerCardEffect("点名", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    dealDamage(s, playerIdx, opponent, 1);
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
});

registerCardEffect("陷害", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    dealDamage(s, playerIdx, opponent, 3);
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
});

registerCardEffect("午饭留堂", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    discardRandomCard(s, 1 - playerIdx);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("午饭", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    // 揭示4张牌，回合玩家摸2张
    const { drawn, deck, discard } = drawCards(s.deck, s.discard, 2);
    s.deck = deck;
    s.discard = discard;
    s.players[playerIdx].hand.push(...drawn);
    emit({ type: "draw_card", player: playerIdx, cards: drawn }, s);
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

registerCardEffect("感冒", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    dealDamage(s, playerIdx, opponent, 1);
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
});

registerCardEffect("免罚券", {
  canUse: () => false,
  needsTarget: false,
  onUse: () => {},
  // 可以响应任何锦囊 pending（非 dodge/near_death/duel 的 pending）
  canRespond: (s, p) => {
    const pn = s.pendingResponse;
    if (!pn || pn.target !== p) return false;
    // 锦囊 pending 类型列表
    return ["barbarian", "volley", "borrow_knife"].includes(pn.type);
  },
});

// 装备牌 — 暂作为普通伤害牌，装备系统后续实现
registerCardEffect("钢笔", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    dealDamage(s, playerIdx, 1 - playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("AI", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    // AI（诸葛连弩）简化：打出后本回合可以多出一张作业
    s.attackUsed = false;
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("尺子", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    dealDamage(s, playerIdx, 1 - playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("三角尺", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    dealDamage(s, playerIdx, 1 - playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("电脑", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    healTo(s, playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

registerCardEffect("大衣", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    healTo(s, playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

registerCardEffect("抽奖", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    const { drawn, deck, discard } = drawCards(s.deck, s.discard, 1);
    s.deck = deck;
    s.discard = discard;
    s.players[playerIdx].hand.push(...drawn);
    emit({ type: "draw_card", player: playerIdx, cards: drawn }, s);
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

// ============================================================
// tryUseCard / tryRespond / handleTimeout
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

  // 赦免 → dodge
  if (pending.type === "dodge" && card.name === "赦免") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 放假/辣条 → near_death
  if (pending.type === "near_death" && (card.name === "放假" || card.name === "辣条")) {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.players[playerIdx].hp = 1;
    emit({ type: "heal", player: playerIdx, amount: 1 }, state);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 作业 → duel / barbarian
  if ((pending.type === "duel" || pending.type === "barbarian") && card.name === "作业") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    emit({ type: "card_played", player: playerIdx, card }, state);

    if (pending.type === "duel") {
      const [source, target] = [pending.source, pending.target];
      state.pendingResponse = {
        type: "duel",
        source: target,
        target: source,
        card: pending.card,
        timeout: Date.now() + 15_000,
      };
    } else {
      state.pendingResponse = null;
    }
    return null;
  }

  // 赦免 → volley
  if (pending.type === "volley" && card.name === "赦免") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 任意牌 → borrow_knife（弃牌视为"给武器"）
  if (pending.type === "borrow_knife") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 免罚券 → 抵消锦囊 pending
  if (card.name === "免罚券" && ["barbarian", "volley", "borrow_knife"].includes(pending.type)) {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 错误提示
  if (pending.type === "dodge") return "需要出【赦免】";
  if (pending.type === "near_death") return "需要出【放假】或【辣条】";
  if (pending.type === "duel" || pending.type === "barbarian") return "需要出【作业】";
  if (pending.type === "volley") return "需要出【赦免】";
  if (pending.type === "borrow_knife") return "需要弃一张牌";

  return "无效响应";
}

export function handleTimeout(state: GameState) {
  const pending = state.pendingResponse;
  if (!pending) return;

  if (pending.type === "dodge") {
    const target = pending.target;
    const dmg = state.wineUsed ? 2 : 1;
    state.wineUsed = false;
    dealDamage(state, pending.source, target, dmg);
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
    const target = pending.target;
    dealDamage(state, pending.source, target, 1);
    state.pendingResponse = null;

    if (state.players[target].hp <= 0) {
      setNearDeathPending(state, pending.source);
    }
    return;
  }

  if (pending.type === "barbarian") {
    const target = pending.target;
    dealDamage(state, pending.source, target, 1);
    state.pendingResponse = null;

    if (state.players[target].hp <= 0) {
      setNearDeathPending(state, pending.source);
    }
    return;
  }

  if (pending.type === "volley") {
    const target = pending.target;
    dealDamage(state, pending.source, target, 1);
    state.pendingResponse = null;

    if (state.players[target].hp <= 0) {
      setNearDeathPending(state, pending.source);
    }
    return;
  }

  if (pending.type === "borrow_knife") {
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
