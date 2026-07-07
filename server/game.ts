// ============================================================
// game.ts — 阶段机 + 游戏状态管理
// ============================================================

import type { GameState, Player, Phase, ServerStateView, PlayerView, ClientMsg } from "./types.ts";
import { createDeck, shuffle, drawCards } from "./cards.ts";
import { tryUseCard, handleTimeout } from "./effects.ts";
import { cardLabel } from "./cards.ts";
import { emit } from "./events.ts";

export { cardLabel };

// ---------- 创建新游戏 ----------

export function createGame(): GameState {
  const deck = shuffle(createDeck());

  const players: [Player, Player] = [
    { hp: 3, maxHp: 3, hand: [], alive: true },
    { hp: 3, maxHp: 3, hand: [], alive: true },
  ];

  // 先每人摸 4 张起始手牌
  const r1 = drawCards(deck, [], 4);
  players[0].hand = r1.drawn;
  const r2 = drawCards(r1.deck, r1.discard, 4);
  players[1].hand = r2.drawn;

  const state: GameState = {
    phase: "judge",
    turnPlayer: 0,
    players,
    deck: r2.deck,
    discard: r2.discard,
    attackUsed: false,
    pendingResponse: null,
    gameOver: false,
    winner: null,
  };

  console.log("Game created. Starting hands:");
  console.log(`  P0: ${players[0].hand.map(cardLabel).join(", ")}`);
  console.log(`  P1: ${players[1].hand.map(cardLabel).join(", ")}`);

  // 自动推进到第一个阶段
  advancePhase(state);
  return state;
}

// ---------- 阶段流转 ----------

export function advancePhase(state: GameState) {
  if (state.gameOver) return;
  if (state.pendingResponse) return; // 等响应，不推进

  // 跳过判定阶段（暂未实现）
  if (state.phase === "judge") {
    emit({ type: "phase_exit", phase: "judge", player: state.turnPlayer }, state);
    state.phase = "draw";
    enterPhase(state, "draw");
    return;
  }

  if (state.phase === "draw") {
    emit({ type: "phase_exit", phase: "draw", player: state.turnPlayer }, state);
    state.phase = "play";
    enterPhase(state, "play");
    return;
  }

  if (state.phase === "play") {
    // play 阶段由玩家手动结束或自然结束
    emit({ type: "phase_exit", phase: "play", player: state.turnPlayer }, state);
    state.phase = "discard";
    enterPhase(state, "discard");
    return;
  }

  if (state.phase === "discard") {
    emit({ type: "phase_exit", phase: "discard", player: state.turnPlayer }, state);
    state.phase = "end";
    enterPhase(state, "end");
    return;
  }

  if (state.phase === "end") {
    enterPhase(state, "end");
    return;
  }
}

function enterPhase(state: GameState, phase: Phase) {
  emit({ type: "phase_enter", phase, player: state.turnPlayer }, state);

  switch (phase) {
    case "draw": {
      // 摸 2 张
      const { drawn, deck, discard } = drawCards(state.deck, state.discard, 2);
      state.deck = deck;
      state.discard = discard;
      state.players[state.turnPlayer].hand.push(...drawn);
      emit({ type: "draw_card", player: state.turnPlayer, cards: drawn }, state);
      console.log(
        `P${state.turnPlayer} draws: ${drawn.map(cardLabel).join(", ")}`,
      );

      // 摸完自动进入出牌
      advancePhase(state);
      break;
    }

    case "discard": {
      // 弃牌阶段：手牌上限 = 当前血量
      const player = state.players[state.turnPlayer];
      const limit = player.hp;
      if (player.hand.length <= limit) {
        console.log(
          `P${state.turnPlayer} discard: hand=${player.hand.length} <= hp=${limit}, skip`,
        );
        advancePhase(state);
      }
      break;
    }

    case "end": {
      emit({ type: "turn_end", player: state.turnPlayer }, state);
      state.turnPlayer = 1 - state.turnPlayer;
      state.attackUsed = false;
      state.phase = "judge";
      emit({ type: "turn_start", player: state.turnPlayer }, state);
      enterPhase(state, "judge");
      advancePhase(state);
      break;
    }
  }
}

// ---------- 消息处理 ----------

export function handleMessage(
  state: GameState,
  playerIdx: number,
  msg: ClientMsg,
): string | null {
  if (state.gameOver) return "游戏已结束";

  const action = msg?.action;
  if (!action) return "无效消息";

  switch (action) {
    case "play_card":
      return handlePlayCard(state, playerIdx, msg.card_id, msg.target);

    case "end_phase": {
      if (playerIdx !== state.turnPlayer) return "不是你的回合";
      if (state.phase !== "play") return "只能在出牌阶段手动结束";
      advancePhase(state);
      return null;
    }

    case "discard": {
      if (playerIdx !== state.turnPlayer) return "不是你的回合";
      if (state.phase !== "discard") return "不在弃牌阶段";
      return handleDiscard(state, playerIdx, msg.card_ids);
    }

    case "pass": {
      if (!state.pendingResponse) return "没有需要响应的";
      if (playerIdx !== state.pendingResponse.target) return "不是你需要响应";
      handleTimeout(state);
      return null;
    }

    default:
      return `未知操作: ${action}`;
  }
}

function handlePlayCard(
  state: GameState,
  playerIdx: number,
  cardId: string,
  target?: number,
): string | null {
  const error = tryUseCard(state, playerIdx, cardId, target);
  if (error) return error;

  // 检查是否有人死了
  if (state.gameOver) return null;

  // 如果需要响应，暂停阶段推进
  if (state.pendingResponse) return null;

  // 检查回合玩家是否还活着（比如对自己用了某些牌）
  const turnPlayer = state.players[state.turnPlayer];
  if (!turnPlayer.alive) return null;

  return null;
}

function handleDiscard(
  state: GameState,
  playerIdx: number,
  cardIds: string[],
): string | null {
  const player = state.players[playerIdx];
  const limit = player.hp;

  const needDiscard = player.hand.length - limit;
  if (needDiscard <= 0) {
    advancePhase(state);
    return null;
  }

  if (cardIds.length < needDiscard) {
    return `需要弃 ${needDiscard} 张牌，只选了 ${cardIds.length} 张`;
  }

  // 验证并移除
  const discarded: typeof player.hand = [];
  for (const id of cardIds.slice(0, needDiscard)) {
    const idx = player.hand.findIndex((c) => c.id === id);
    if (idx === -1) return `你没有牌 ${id}`;
    discarded.push(player.hand.splice(idx, 1)[0]);
  }

  state.discard.push(...discarded);
  emit(
    { type: "card_discarded", player: playerIdx, cards: discarded },
    state,
  );

  advancePhase(state);
  return null;
}

// ---------- 超时检查（外部定时器调用） ----------

export function checkTimeout(state: GameState) {
  if (!state.pendingResponse) return false;

  if (Date.now() >= state.pendingResponse.timeout) {
    console.log(`P${state.pendingResponse.target} timeout on ${state.pendingResponse.type}`);
    handleTimeout(state);
    return true;
  }
  return false;
}

// ---------- 生成客户端视图 ----------

export function getPlayerView(
  state: GameState,
  playerIdx: number,
): ServerStateView {
  const me = state.players[playerIdx];
  const opponent = state.players[1 - playerIdx];

  const oppView: PlayerView = {
    hp: opponent.hp,
    maxHp: opponent.maxHp,
    handCount: opponent.hand.length,
    alive: opponent.alive,
  };

  // 如果 pending 对象的 type 包含 card 引用，它会包含 Card 对象
  // ServerStateView 中的 pendingResponse 可以原样传递
  const pendingView = state.pendingResponse ? { ...state.pendingResponse } : null;

  return {
    phase: state.phase,
    turnPlayer: state.turnPlayer,
    you: { ...me },
    opponent: oppView,
    attackUsed: state.attackUsed,
    pendingResponse: pendingView,
    gameOver: state.gameOver,
    winner: state.winner,
    deckCount: state.deck.length,
  };
}
