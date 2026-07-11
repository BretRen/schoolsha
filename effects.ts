// ============================================================
// effects.ts — 卡牌效果 + 装备系统
// ============================================================

import type { GameState, Card, PendingType, LogEntry } from "./types.ts";
import { hasCard, removeCard, drawCards } from "./cards.ts";
import { emit } from "./events.ts";
import { getSkill, executeSkillEffect } from "./skills.ts";
import { cardLabel } from "./cards.ts";

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

// ---------- 日志 ----------

export function addLog(s: GameState, entry: LogEntry) {
  s.log.push(entry);
  if (s.log.length > 50) s.log.shift();
}

// ============================================================
// 可复用条件原语
// ============================================================

type Condition = (s: GameState, p: number) => boolean;

const isTurn: Condition = (s, p) => p === s.turnPlayer;
const playPhase: Condition = (s) => s.phase === "play";
const noPending: Condition = (s) => !s.pendingResponse;
const hpBelowMax: Condition = (s, p) => s.players[p].hp < s.players[p].maxHp;
/** AI武器：无视attackUsed限制 */
const canAttack: Condition = (s, p) =>
  !s.attackUsed || s.players[p].weapon?.name === "圆规";

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

function dealDamage(s: GameState, source: number, target: number, amount: number, reason?: string) {
  // 黑名单：点名批评伤害+1
  if (s.players[target].armor?.name === "黑名单" && reason === "volley") {
    amount++;
  }
  s.players[target].hp -= amount;
  if (s.players[target].hp < 0) s.players[target].hp = 0;
  addLog(s, { id: "damage", player: target, amount });
  emit({ type: "damage", source, target, amount }, s);
  // 直接伤害可能致死，触发濒死流程
  if (s.players[target].hp <= 0 && !s.gameOver) {
    setNearDeathPending(s, source);
  }
}

function healTo(s: GameState, player: number, amount: number) {
  s.players[player].hp = Math.min(s.players[player].hp + amount, s.players[player].maxHp);
  addLog(s, { id: "heal", player: player, amount });
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

function discardFromPool(s: GameState, player: number): boolean {
  const target = s.players[player];
  const pool: Card[] = [...target.hand];
  if (target.weapon) pool.push(target.weapon);
  if (target.armor) pool.push(target.armor);
  if (pool.length === 0) return false;

  const idx = Math.floor(Math.random() * pool.length);
  const c = pool[idx];
  if (target.hand.some(h => h.id === c.id)) removeCard(target.hand, c.id);
  else if (target.weapon?.id === c.id) target.weapon = null;
  else target.armor = null;

  s.discard.push(c);
  addLog(s, { id: "card_discarded", player, cardName: c.name });
  emit({ type: "card_discarded", player, cards: [c] }, s);
  return true;
}

/** 装备一张牌 */
function equipCard(s: GameState, playerIdx: number, card: Card): string | null {
  const player = s.players[playerIdx];
  if (card.type === "weapon") {
    if (player.weapon) {
      s.discard.push(player.weapon);
      addLog(s, { id: "card_discarded", player: playerIdx, cardName: player.weapon.name });
    }
    player.weapon = card;
  } else if (card.type === "armor") {
    if (player.armor) {
      s.discard.push(player.armor);
      addLog(s, { id: "card_discarded", player: playerIdx, cardName: player.armor.name });
    }
    player.armor = card;
  } else {
    return "不是装备牌";
  }
  addLog(s, { id: "card_equipped", player: playerIdx, cardName: card.name });
  emit({ type: "card_played", player: playerIdx, card }, s);
  return null;
}

// ============================================================
// 卡牌效果注册
// ============================================================

// --- 基本牌 ---

registerCardEffect("作业", {
  canUse: all(playPhase, isTurn, noPending, canAttack, (s, p, card) => {
    const opp = s.players[1 - p];
    if (opp.armor?.name === "黑名单") return false;
    if (opp.armor?.name === "校服" && (card.suit === "spade" || card.suit === "club")) return false;
    return true;
  }),
  needsTarget: true,
  targetFilter: (_s, source, target) => source !== target,
  onUse: (s, playerIdx, card) => {
    const opponent = s.players[1 - playerIdx];

    // 涂改液：主动技 — 需玩家确认是否发动
    if (opponent.armor?.name === "涂改液") {
      if (s.deck.length === 0 && s.discard.length === 0) {
        // 无牌可判定，作业正常生效（不询问）
      } else {
        s.pendingResponse = {
          type: "judge_armor",
          source: playerIdx,
          target: 1 - playerIdx,
          card,
          timeout: Date.now() + 8000,
        };
        addLog(s, { id: "card_played", player: playerIdx, cardName: "作业", target: 1 - playerIdx });
        emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
        return;
      }
    }

    s.attackUsed = true;
    setDodgePending(s, playerIdx, card);
    addLog(s, { id: "card_played", player: playerIdx, cardName: "作业", target: 1 - playerIdx });
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("豁免", {
  canUse: () => false,
  needsTarget: false,
  onUse: () => {},
  canRespond: pendingIs("dodge"),
});

registerCardEffect("补给", {
  canUse: any(pendingIs("near_death"), all(playPhase, isTurn, noPending, hpBelowMax)),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    healTo(s, playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

registerCardEffect("小抄", {
  canUse: any(
    pendingIs("near_death"),
    all(playPhase, isTurn, noPending),
  ),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    if (s.pendingResponse?.type === "near_death") {
      s.players[playerIdx].hp = 1;
      emit({ type: "heal", player: playerIdx, amount: 1 }, s);
      s.pendingResponse = null;
    } else {
      s.wineUsed = true;
    }
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

// --- 锦囊牌 — 需要响应 ---

registerCardEffect("辩论", {
  canUse: all(playPhase, isTurn, noPending, (s, p) => s.players[1 - p].armor?.name !== "黑名单"),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "duel", source: playerIdx, target: opponent, card,
      timeout: Date.now() + 15_000,
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "辩论", target: opponent });
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  canRespond: pendingIs("duel"),
});

registerCardEffect("突击测验", {
  canUse: all(playPhase, isTurn, noPending, (s, p) => s.players[1 - p].armor?.name !== "黑名单"),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "barbarian", source: playerIdx, target: opponent, card,
      timeout: Date.now() + 15_000,
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "突击测验", target: opponent });
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  canRespond: pendingIs("barbarian"),
});

registerCardEffect("最终测试", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
    // 双方各抽 2 张
    for (const p of [playerIdx, 1 - playerIdx]) {
      const { drawn, deck, discard } = drawCards(s.deck, s.discard, 2);
      s.deck = deck;
      s.discard = discard;
      s.players[p].hand.push(...drawn);
      addLog(s, { id: "draw", player: p, count: drawn.length });
      emit({ type: "draw_card", player: p, cards: drawn }, s);
    }
    addLog(s, { id: "card_played", player: playerIdx, cardName: "最终测试" });
    emit({ type: "card_played", player: playerIdx, card }, s);
  },
});

registerCardEffect("嫁祸", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "borrow_knife", source: playerIdx, target: opponent, card,
      timeout: Date.now() + 15_000,
    };
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  canRespond: pendingIs("borrow_knife"),
});

// --- 锦囊牌 — 即刻 ---

registerCardEffect("神偷", {
  canUse: all(playPhase, isTurn, noPending, (s, p) => {
    const opp = s.players[1 - p];
    return opp.hand.length > 0 || opp.weapon !== null || opp.armor !== null;
  }),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    const opp = s.players[opponent];
    const exposed: Array<{card: Card; position: number}> = [];
    let pos = 1;
    // 手牌盲选
    const handSize = opp.hand.length;
    pos += handSize;
    if (opp.weapon) { exposed.push({ card: opp.weapon, position: pos }); pos++; }
    if (opp.armor) { exposed.push({ card: opp.armor, position: pos }); pos++; }
    s.pendingResponse = {
      type: "steal", source: playerIdx, target: playerIdx,
      card, timeout: Date.now() + 10_000,
      poolSize: handSize,
      exposedCards: exposed,
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "神偷", target: opponent });
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
});

registerCardEffect("告密", {
  canUse: all(playPhase, isTurn, noPending, (s, p) => {
    const opp = s.players[1 - p];
    return opp.hand.length > 0 || opp.weapon !== null || opp.armor !== null;
  }),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    const opp = s.players[opponent];
    const exposed: Array<{card: Card; position: number}> = [];
    let pos = 1;
    const handSize = opp.hand.length;
    pos += handSize;
    if (opp.weapon) { exposed.push({ card: opp.weapon, position: pos }); pos++; }
    if (opp.armor) { exposed.push({ card: opp.armor, position: pos }); pos++; }
    s.pendingResponse = {
      type: "steal", source: playerIdx, target: playerIdx,
      card, timeout: Date.now() + 10_000,
      poolSize: handSize,
      exposedCards: exposed,
      stealAction: "discard",
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "告密", target: opponent });
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
});

registerCardEffect("陷害", {
  canUse: all(playPhase, isTurn, noPending, (s, p) => {
    const opp = s.players[1 - p];
    let count = opp.hand.length + (opp.weapon ? 1 : 0) + (opp.armor ? 1 : 0);
    return count >= 2;
  }),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opp = s.players[1 - playerIdx];
    const pool: Card[] = [...opp.hand];
    if (opp.weapon) pool.push(opp.weapon);
    if (opp.armor) pool.push(opp.armor);
    // 让攻击方从对手牌中选择 2 张弃置
    s.pendingResponse = {
      type: "pick_discard",
      source: playerIdx,
      target: playerIdx,
      card,
      selectableCards: pool,
      discardCount: 2,
      timeout: Date.now() + 15000,
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "陷害", target: 1 - playerIdx });
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("点名批评", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    s.pendingResponse = {
      type: "volley", source: playerIdx, target: opponent, card,
      timeout: Date.now() + 15_000,
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "点名批评", target: opponent });
    emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
  },
  canRespond: pendingIs("volley"),
});

registerCardEffect("午饭留堂", {
  canUse: all(playPhase, isTurn, noPending, (s, p) => {
    const opp = s.players[1 - p];
    return opp.hand.length > 0 || opp.weapon !== null || opp.armor !== null;
  }),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opp = s.players[1 - playerIdx];
    const pool: Card[] = [...opp.hand];
    if (opp.weapon) pool.push(opp.weapon);
    if (opp.armor) pool.push(opp.armor);
    s.pendingResponse = {
      type: "pick_discard",
      source: playerIdx,
      target: playerIdx,
      card,
      selectableCards: pool,
      discardCount: 1,
      timeout: Date.now() + 15000,
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "午饭留堂", target: 1 - playerIdx });
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("午饭", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => {
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
    dealDamage(s, playerIdx, 1 - playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("免罚券", {
  canUse: () => false,
  needsTarget: false,
  onUse: () => {},
  canRespond: (s, p) => {
    const pn = s.pendingResponse;
    if (!pn || pn.target !== p) return false;
    return ["barbarian", "volley", "borrow_knife", "duel"].includes(pn.type);
  },
});

// --- 装备牌（批量注册） ---
for (const name of ["钢笔", "圆规", "尺子", "橡皮", "校服", "黑名单", "涂改液"]) {
  registerCardEffect(name, {
    canUse: all(playPhase, isTurn, noPending),
    needsTarget: false,
    onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
  });
}

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

  // 装备牌不走弃牌堆
  if (card.type === "weapon" || card.type === "armor") {
    removeCard(player.hand, cardId);
    const err = equipCard(state, playerIdx, card);
    if (err) return err;
  } else {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    effect.onUse(state, playerIdx, card, finalTarget);
  }

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

  // 赦免 → dodge / volley
  if (card.name === "豁免" && (pending.type === "dodge" || pending.type === "volley")) {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    addLog(state, { id: "card_played", player: playerIdx, cardName: "豁免" });
    emit({ type: "card_played", player: playerIdx, card }, state);

    // 尺子：出赦免后攻击者可以再出一张作业
    if (pending.type === "dodge" && state.players[pending.source].weapon?.name === "尺子") {
      state.attackUsed = false;
    }
    // 三角尺：出赦免后仍受到1点伤害
    if (pending.type === "dodge" && state.players[pending.source].weapon?.name === "橡皮") {
      dealDamage(state, pending.source, playerIdx, 1);
    }
    return null;
  }

  // 放假/辣条 → near_death
  if (pending.type === "near_death" && (card.name === "补给" || card.name === "小抄")) {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.players[playerIdx].hp = 1;
    emit({ type: "heal", player: playerIdx, amount: 1 }, state);
    state.pendingResponse = null;
    addLog(state, { id: "card_played", player: playerIdx, cardName: card.name });
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 作业 → duel / barbarian
  if ((pending.type === "duel" || pending.type === "barbarian") && card.name === "作业") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    addLog(state, { id: "card_played", player: playerIdx, cardName: "作业" });
    emit({ type: "card_played", player: playerIdx, card }, state);

    if (pending.type === "duel") {
      const [source, target] = [pending.source, pending.target];
      state.pendingResponse = {
        type: "duel", source: target, target: source,
        card: pending.card, timeout: Date.now() + 15_000,
      };
    } else {
      state.pendingResponse = null;
    }
    return null;
  }

  // 任意牌 → borrow_knife
  if (pending.type === "borrow_knife") {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    addLog(state, { id: "card_played", player: playerIdx, cardName: card.name });
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 免罚券 → 取消任何锦囊 pending
  if (card.name === "免罚券" && ["barbarian", "volley", "borrow_knife", "duel"].includes(pending.type)) {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    addLog(state, { id: "card_played", player: playerIdx, cardName: "免罚券" });
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  if (pending.type === "dodge") return "需要出【豁免】";
  if (pending.type === "near_death") return "需要出【补给】或【小抄】";
  if (pending.type === "duel" || pending.type === "barbarian") return "需要出【作业】";
  if (pending.type === "volley") return "需要出【豁免】";
  if (pending.type === "steal") return "请选择要偷的牌";
  if (pending.type === "skill_discard") return "需要选择要弃置的牌";
  if (pending.type === "borrow_knife") return "需要弃一张牌";

  return "无效响应";
}


// ============================================================
// steal 选牌处理
// ============================================================

export function handleStealCard(state: GameState, playerIdx: number, position?: number): string | null {
  const pending = state.pendingResponse;
  if (!pending || pending.type !== "steal") return "没有正在进行的偷牌";
  if (playerIdx !== pending.target) return "不是你在选择";

  const opponent = 1 - playerIdx;
  const opp = state.players[opponent];

  // 构建池（同 onUse 顺序：手牌 + 武器 + 护甲）
  const pool: Card[] = [...opp.hand];
  if (opp.weapon) pool.push(opp.weapon);
  if (opp.armor) pool.push(opp.armor);
  if (pool.length === 0) return "无可选牌";

  // 盲选：根据位置（1-indexed），超时时由 handleTimeout 随机选
  const pos = (position != null && position >= 1 && position <= pool.length) ? position : Math.floor(Math.random() * pool.length) + 1;
  const card = pool[pos - 1];

  // 从对手手中或装备区移除
  if (opp.hand.some(c => c.id === card.id)) {
    removeCard(opp.hand, card.id);
  } else if (opp.weapon?.id === card.id) {
    opp.weapon = null;
  } else if (opp.armor?.id === card.id) {
    opp.armor = null;
  }

  // 偷或弃
  if (pending.stealAction === "discard") {
    state.discard.push(card);
    state.pendingResponse = null;
    state.discard.push(pending.card!);
    addLog(state, { id: "card_discarded", player: playerIdx, cardName: card.name });
  } else {
    state.players[playerIdx].hand.push(card);
    state.pendingResponse = null;
    state.discard.push(pending.card!);
    addLog(state, { id: "card_played", player: playerIdx, cardName: card.name });
  }
  emit({ type: "card_played", player: playerIdx, card }, state);
  return null;
}

export function handleTimeout(state: GameState) {
  const pending = state.pendingResponse;
  if (!pending) return;

  if (pending.type === "dodge") {
    const target = pending.target;
    let dmg = 1;
    if (state.wineUsed) { dmg++; state.wineUsed = false; }
    if (state.players[pending.source].weapon?.name === "钢笔") dmg++;
    state.pendingResponse = null; // 先清原始 pending，dealDamage 内会设 near_death
    dealDamage(state, pending.source, target, dmg);
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

  // duel / barbarian / volley / borrow_knife 超时
  const plainTypes = ["duel", "barbarian", "volley", "borrow_knife"] as string[];
  if (plainTypes.includes(pending.type)) {
    const target = pending.target;
    state.pendingResponse = null; // 先清，dealDamage 内处理 near_death
    dealDamage(state, pending.source, target, 1, pending.type);
    return;
  }

  // steal 超时 → 随机选一张
  if (pending.type === "steal") {
    handleStealCard(state, pending.target!);
    return;
  }

  // skill_discard 超时 → 随机弃牌，执行技能
  if (pending.type === "skill_discard") {
    handleSkillDiscardTimeout(state, pending.target!);
    return;
  }

  // opponent_discard 超时 → 随机弃对手牌
  if (pending.type === "opponent_discard") {
    handleOpponentDiscardTimeout(state, pending.target!);
    return;
  }

  // judge_armor 超时 → 玩家选择不发动涂改液 → 作业正常生效
  if (pending.type === "judge_armor") {
    state.pendingResponse = null;
    setDodgePending(state, pending.source, pending.card!);
    return;
  }

  // pick_discard 超时 → 取消，牌浪费
  if (pending.type === "pick_discard") {
    state.pendingResponse = null;
    return;
  }

  state.pendingResponse = null;
}

// 涂改液主动技 — 玩家确认发动后翻牌判定
export function handleActivateArmor(state: GameState, playerIdx: number): string | null {
  const pending = state.pendingResponse;
  if (!pending || pending.type !== "judge_armor") return "没有需要响应的判定";
  if (playerIdx !== pending.target) return "不是你需要响应";

  const { drawn, deck, discard } = drawCards(state.deck, state.discard, 1);
  state.deck = deck;
  state.discard = discard;
  state.pendingResponse = null;

  if (drawn.length > 0) {
    const judge = drawn[0];
    state.discard.push(judge);
    const isRed = judge.suit === "heart" || judge.suit === "diamond";
    addLog(state, { id: "judge_result", player: playerIdx, cardName: judge.name, suit: judge.suit, result: isRed ? "success" : "fail" });
    if (isRed) {
      // 红色 → 闪避成功，作业无效
      emit({ type: "card_played", player: pending.source, card: pending.card!, target: playerIdx }, state);
      return null;
    }
    // 黑色 → 判定失败，作业正常生效
    setDodgePending(state, pending.source, pending.card!);
    return null;
  }

  // 无牌可判（理论上不会走到这里）
  setDodgePending(state, pending.source, pending.card!);
  return null;
}

// 陷害等：攻击方从对手牌中选牌弃置
export function handlePickDiscard(state: GameState, playerIdx: number, cardIds: string[]): string | null {
  const pending = state.pendingResponse;
  if (!pending || pending.type !== "pick_discard") return "没有待选择的弃牌";
  if (playerIdx !== pending.target) return "不是你需要选择";

  const count = pending.discardCount || 1;
  if (cardIds.length !== count) return `需要选 ${count} 张牌`;

  const pool = pending.selectableCards || [];
  const oppIdx = 1 - pending.source;
  const opp = state.players[oppIdx];

  for (const id of cardIds) {
    const c = pool.find(c => c.id === id);
    if (!c) return `无效的牌 ${id}`;
    if (opp.hand.some(h => h.id === c.id)) {
      removeCard(opp.hand, c.id);
    } else if (opp.weapon?.id === c.id) {
      opp.weapon = null;
    } else if (opp.armor?.id === c.id) {
      opp.armor = null;
    }
    state.discard.push(c);
    addLog(state, { id: "card_discarded", player: oppIdx, cardName: c.name });
  }

  state.pendingResponse = null;
  return null;
}

function handleSkillDiscardTimeout(state: GameState, playerIdx: number) {
  // 超时取消技能，不随机弃牌
  state.pendingResponse = null;
}

function handleOpponentDiscardTimeout(state: GameState, targetIdx: number) {
  // 超时取消，不随机弃牌
  state.pendingResponse = null;
}
