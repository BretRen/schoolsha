// ============================================================
// effects.ts — 卡牌效果 + 装备系统
// ============================================================

import type { GameState, Card, PendingType, LogEntry } from "./types.ts";
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

// ---------- 日志 ----------

function addLog(s: GameState, entry: LogEntry) {
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
const _noAttack: Condition = (s) => !s.attackUsed;
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

function dealDamage(s: GameState, source: number, target: number, amount: number) {
  // 大衣：陷害/点名 伤害+1
  if (s.players[target].armor?.name === "黑名单") {
    const pending = s.pendingResponse;
    // 仅在陷害/点名等"火属性"伤害时 +1（简化：非作业来源的伤害）
    if (!pending || (pending.type !== "dodge" && pending.type !== "barbarian")) {
      amount++;
    }
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

function stealRandomCard(s: GameState, from: number, to: number): boolean {
  const target = s.players[from];
  // 手牌 + 装备 全都可以偷
  const pool: { card: Card; source: "hand" | "weapon" | "armor" }[] = [];
  for (const c of target.hand) pool.push({ card: c, source: "hand" });
  if (target.weapon) pool.push({ card: target.weapon, source: "weapon" });
  if (target.armor) pool.push({ card: target.armor, source: "armor" });
  if (pool.length === 0) return false;

  const idx = Math.floor(Math.random() * pool.length);
  const { card, source } = pool[idx];

  if (source === "hand") {
    removeCard(target.hand, card.id);
  } else if (source === "weapon") {
    target.weapon = null;
  } else {
    target.armor = null;
  }

  s.players[to].hand.push(card);
  emit({ type: "card_played", player: to, card }, s);
  return true;
}

function discardFromPool(s: GameState, player: number): boolean {
  const target = s.players[player];
  const pool: { card: Card; source: "hand" | "weapon" | "armor" }[] = [];
  for (const c of target.hand) pool.push({ card: c, source: "hand" });
  if (target.weapon) pool.push({ card: target.weapon, source: "weapon" });
  if (target.armor) pool.push({ card: target.armor, source: "armor" });
  if (pool.length === 0) return false;

  const idx = Math.floor(Math.random() * pool.length);
  const { card, source } = pool[idx];

  if (source === "hand") {
    removeCard(target.hand, card.id);
  } else if (source === "weapon") {
    target.weapon = null;
  } else {
    target.armor = null;
  }

  s.discard.push(card);
  emit({ type: "card_discarded", player, cards: [card] }, s);
  return true;
}

/** 装备一张牌 */
function equipCard(s: GameState, playerIdx: number, card: Card): string | null {
  const player = s.players[playerIdx];
  if (card.type === "weapon") {
    if (player.weapon) s.discard.push(player.weapon);
    player.weapon = card;
  } else if (card.type === "armor") {
    if (player.armor) s.discard.push(player.armor);
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
  canUse: all(playPhase, isTurn, noPending, canAttack),
  needsTarget: true,
  targetFilter: (_s, source, target) => source !== target,
  onUse: (s, playerIdx, card) => {
    const opponent = s.players[1 - playerIdx];

    // 电脑：黑作业(spade/club)无效
    if (opponent.armor?.name === "校服" && (card.suit === "spade" || card.suit === "club")) {
      emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
      return;
    }

    // 大衣：作业无效
    if (opponent.armor?.name === "黑名单") {
      emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
      return;
    }

    // 抽奖：判定 — 抽一张牌，红色=自动闪避
    if (opponent.armor?.name === "涂改液") {
      if (s.deck.length === 0 && s.discard.length === 0) {
        // 无牌可判定，作业正常生效
      } else {
        const { drawn, deck, discard } = drawCards(s.deck, s.discard, 1);
        s.deck = deck;
        s.discard = discard;
        if (drawn.length > 0) {
          const judge = drawn[0];
          s.discard.push(judge);
          if (judge.suit === "heart" || judge.suit === "diamond") {
            // 红色=自动闪避，作业无效
            emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
            return;
          }
        }
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
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    // 大衣：免疫
    if (s.players[opponent].armor?.name === "黑名单") {
      emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
      return;
    }
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
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    if (s.players[opponent].armor?.name === "黑名单") {
      emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
      return;
    }
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
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    const opponent = 1 - playerIdx;
    if (s.players[opponent].armor?.name === "黑名单") {
      emit({ type: "card_played", player: playerIdx, card, target: opponent }, s);
      return;
    }
    s.pendingResponse = {
      type: "volley", source: playerIdx, target: opponent, card,
      timeout: Date.now() + 15_000,
    };
    addLog(s, { id: "card_played", player: playerIdx, cardName: "点名批评", target: opponent });
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
    const pool: Card[] = [...opp.hand];
    if (opp.weapon) pool.push(opp.weapon);
    if (opp.armor) pool.push(opp.armor);
    s.pendingResponse = {
      type: "steal", source: playerIdx, target: playerIdx,
      card, timeout: Date.now() + 10_000,
      selectableCards: pool,
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
    discardFromPool(s, 1 - playerIdx);
    addLog(s, { id: "card_played", player: playerIdx, cardName: "告密", target: 1 - playerIdx });
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("陷害", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    dealDamage(s, playerIdx, 1 - playerIdx, 3);
    addLog(s, { id: "card_played", player: playerIdx, cardName: "陷害", target: 1 - playerIdx });
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("团队项目", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    dealDamage(s, playerIdx, 1 - playerIdx, 2);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("点名批评", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    dealDamage(s, playerIdx, 1 - playerIdx, 1);
    emit({ type: "card_played", player: playerIdx, card, target: 1 - playerIdx }, s);
  },
});

registerCardEffect("午饭留堂", {
  canUse: all(playPhase, isTurn, noPending, (s, p) => {
    const opp = s.players[1 - p];
    return opp.hand.length > 0 || opp.weapon !== null || opp.armor !== null;
  }),
  needsTarget: true,
  onUse: (s, playerIdx, card) => {
    discardFromPool(s, 1 - playerIdx);
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

// --- 装备牌 ---

registerCardEffect("钢笔", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
});

registerCardEffect("圆规", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
});

registerCardEffect("尺子", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
});

registerCardEffect("橡皮", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
});

registerCardEffect("校服", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
});

registerCardEffect("黑名单", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
});

registerCardEffect("涂改液", {
  canUse: all(playPhase, isTurn, noPending),
  needsTarget: false,
  onUse: (s, playerIdx, card) => equipCard(s, playerIdx, card),
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
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  // 免罚券 → 取消任何锦囊 pending
  if (card.name === "免罚券" && ["barbarian", "volley", "borrow_knife", "duel"].includes(pending.type)) {
    removeCard(player.hand, cardId);
    state.discard.push(card);
    state.pendingResponse = null;
    emit({ type: "card_played", player: playerIdx, card }, state);
    return null;
  }

  if (pending.type === "dodge") return "需要出【豁免】";
  if (pending.type === "near_death") return "需要出【补给】或【小抄】";
  if (pending.type === "duel" || pending.type === "barbarian") return "需要出【作业】";
  if (pending.type === "volley") return "需要出【豁免】";
  if (pending.type === "steal") return "请选择要偷的牌";
  if (pending.type === "borrow_knife") return "需要弃一张牌";

  return "无效响应";
}


// ============================================================
// steal 选牌处理
// ============================================================

export function handleStealCard(state: GameState, playerIdx: number, cardId: string): string | null {
  const pending = state.pendingResponse;
  if (!pending || pending.type !== "steal") return "没有正在进行的偷牌";
  if (playerIdx !== pending.target) return "不是你在选择";
  
  const pool = pending.selectableCards;
  if (!pool) return "无可选牌";
  const card = pool.find(c => c.id === cardId);
  if (!card) return "无效选择";
  
  const fromIdx = 1 - playerIdx;
  const from = state.players[fromIdx];
  
  // 从对手手中或装备区移除
  if (from.hand.some(c => c.id === cardId)) {
    removeCard(from.hand, cardId);
  } else if (from.weapon?.id === cardId) {
    from.weapon = null;
  } else if (from.armor?.id === cardId) {
    from.armor = null;
  }
  
  state.players[playerIdx].hand.push(card);
  state.pendingResponse = null;
  state.discard.push(pending.card!);
  addLog(state, { id: "card_played", player: playerIdx, cardName: card.name });
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
    // 钢笔：伤害+1
    if (state.players[pending.source].weapon?.name === "钢笔") dmg++;
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

  // duel / barbarian / volley / borrow_knife 超时
  const plainTypes = ["duel", "barbarian", "volley", "borrow_knife"] as string[];
  if (plainTypes.includes(pending.type)) {
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
