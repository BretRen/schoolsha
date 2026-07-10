// ============================================================
// game.ts — 阶段机 + 游戏状态管理
// ============================================================

import type { GameState, Player, Phase, ServerStateView, PlayerView, ClientMsg } from "./types.ts";
import { createDeck, shuffle, drawCards } from "./cards.ts";
import { tryUseCard, handleTimeout } from "./effects.ts";
import { cardLabel } from "./cards.ts";
import { emit } from "./events.ts";
import {
  getCharacter,
  mountPassiveSkills,
  getHandLimit,
  tryUseSkill,
  resetSkillCounts,
} from "./skills.ts";

export { cardLabel };

// ---------- 常量 ----------

const TURN_TIMEOUT_SEC = 20;

// ---------- 创建新游戏 ----------

/** picks: [player0_characterId, player1_characterId] */
export function createGame(picks: [string, string]): GameState {
  const deck = shuffle(createDeck());

  const char0 = getCharacter(picks[0]);
  const char1 = getCharacter(picks[1]);

  const players: [Player, Player] = [
    { hp: char0?.maxHp ?? 3, maxHp: char0?.maxHp ?? 3, hand: [], alive: true, characterId: picks[0], weapon: null, armor: null },
    { hp: char1?.maxHp ?? 3, maxHp: char1?.maxHp ?? 3, hand: [], alive: true, characterId: picks[1], weapon: null, armor: null },
  ];

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
    turnStartTime: Date.now(),
    disconnectCount: [0, 0],
    disconnectedAt: [null, null],
    wineUsed: false,
    skillUseCount: {},
    log: [],
  };

  if (picks[0]) mountPassiveSkills(state, 0, picks[0]);
  if (picks[1]) mountPassiveSkills(state, 1, picks[1]);

  console.log("Game created. Starting hands:");
  console.log(`  P0 (${char0?.name ?? "?"}): ${players[0].hand.map(cardLabel).join(", ")}`);
  console.log(`  P1 (${char1?.name ?? "?"}): ${players[1].hand.map(cardLabel).join(", ")}`);

  advancePhase(state);
  return state;
}

// ---------- 阶段流转 ----------

export function advancePhase(state: GameState) {
  if (state.gameOver) return;
  if (state.pendingResponse) return;

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
      const { drawn, deck, discard } = drawCards(state.deck, state.discard, 2);
      state.deck = deck;
      state.discard = discard;
      state.players[state.turnPlayer].hand.push(...drawn);
      emit({ type: "draw_card", player: state.turnPlayer, cards: drawn }, state);
      console.log(
        `P${state.turnPlayer} draws: ${drawn.map(cardLabel).join(", ")}`,
      );
      advancePhase(state);
      break;
    }

    case "play": {
      state.turnStartTime = Date.now();
      break;
    }

    case "discard": {
      const player = state.players[state.turnPlayer];
      const limit = getHandLimit(state, state.turnPlayer, player.characterId ?? "");
      if (player.hand.length <= limit) {
        console.log(
          `P${state.turnPlayer} discard: hand=${player.hand.length} <= hp+skill=${limit}, skip`,
        );
        advancePhase(state);
      }
      break;
    }

    case "end": {
      emit({ type: "turn_end", player: state.turnPlayer }, state);
      state.turnPlayer = 1 - state.turnPlayer;
      state.attackUsed = false;
      state.wineUsed = false;
      state.phase = "judge";
      resetSkillCounts(state);
      state.turnStartTime = Date.now();
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

  // 有人断线时暂停游戏，禁止所有操作
  if (anyoneDisconnected(state)) return "等待对手重连...";

  const action = msg?.action;
  if (!action) return "无效消息";

  switch (action) {
    case "play_card":
      return handlePlayCard(state, playerIdx, msg.card_id, msg.target);

    case "use_skill":
      return handleUseSkill(state, playerIdx, msg.skill_id);

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
  // 每次出牌重置倒计时
  state.turnStartTime = Date.now();
  if (state.gameOver) return null;
  if (state.pendingResponse) return null;
  if (!state.players[state.turnPlayer].alive) return null;
  return null;
}

function handleUseSkill(
  state: GameState,
  playerIdx: number,
  skillId: string,
): string | null {
  const charId = state.players[playerIdx].characterId;
  if (!charId) return "你没有选择角色";

  const err = tryUseSkill(state, playerIdx, charId, skillId);
  if (err) return err;
  return null;
}

function handleDiscard(
  state: GameState,
  playerIdx: number,
  cardIds: string[],
): string | null {
  const player = state.players[playerIdx];
  const limit = getHandLimit(state, playerIdx, player.characterId ?? "");

  const needDiscard = player.hand.length - limit;
  if (needDiscard <= 0) {
    advancePhase(state);
    return null;
  }

  if (cardIds.length < needDiscard) {
    return `需要弃 ${needDiscard} 张牌，只选了 ${cardIds.length} 张`;
  }

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

// ---------- 超时检查 ----------

const TURN_TIMEOUT_MS = TURN_TIMEOUT_SEC * 1000;

export function checkTimeout(state: GameState): boolean {
  let changed = false;

  // Pending 超时
  if (state.pendingResponse && Date.now() >= state.pendingResponse.timeout) {
    console.log(`P${state.pendingResponse.target} timeout on ${state.pendingResponse.type}`);
    handleTimeout(state);
    changed = true;
  }

  // 回合超时（仅在 play 阶段）
  if (
    !state.gameOver &&
    state.phase === "play" &&
    !state.pendingResponse &&
    Date.now() - state.turnStartTime > TURN_TIMEOUT_MS
  ) {
    console.log(`P${state.turnPlayer} turn timeout (${TURN_TIMEOUT_SEC}s)`);
    advancePhase(state);
    changed = true;
  }

  return changed;
}

// ---------- 断线管理 ----------

const MAX_DISCONNECTS = 3;

/** 标记玩家断线。返回是否应立即判负（超过次数限制） */
export function markDisconnected(state: GameState, playerIdx: number): boolean {
  state.disconnectedAt[playerIdx] = Date.now();
  state.disconnectCount[playerIdx]++;
  console.log(`P${playerIdx} disconnected (${state.disconnectCount[playerIdx]}/${MAX_DISCONNECTS})`);

  if (state.disconnectCount[playerIdx] > MAX_DISCONNECTS && !state.gameOver) {
    console.log(`P${playerIdx} exceeded disconnect limit, opponent wins`);
    state.gameOver = true;
    state.winner = 1 - playerIdx;
    return true;
  }
  return false;
}

/** 玩家重连 */
export function markReconnected(state: GameState, playerIdx: number) {
  state.disconnectedAt[playerIdx] = null;
  console.log(`P${playerIdx} reconnected`);
}

/** 检查断线是否超时（30秒）。返回是否已判负 */
export function checkDisconnectTimeout(state: GameState, playerIdx: number): boolean {
  const at = state.disconnectedAt[playerIdx];
  if (at === null) return false;
  if (Date.now() - at > 30_000 && !state.gameOver) {
    console.log(`P${playerIdx} disconnect timeout (30s), opponent wins`);
    state.gameOver = true;
    state.winner = 1 - playerIdx;
    return true;
  }
  return false;
}

/** 是否有人断线中 */
export function anyoneDisconnected(state: GameState): boolean {
  return state.disconnectedAt[0] !== null || state.disconnectedAt[1] !== null;
}

// ---------- 生成客户端视图 ----------

export function getPlayerView(
  state: GameState,
  playerIdx: number,
): ServerStateView {
  const me = state.players[playerIdx];
  const opponent = state.players[1 - playerIdx];

  const oppChar = opponent.characterId ? getCharacter(opponent.characterId) : null;
  const oppView: PlayerView = {
    hp: opponent.hp,
    maxHp: opponent.maxHp,
    handCount: opponent.hand.length,
    alive: opponent.alive,
    characterId: opponent.characterId,
    weapon: opponent.weapon,
    armor: opponent.armor,
    skills: oppChar?.skills ?? [],
  };

  const char = me.characterId ? getCharacter(me.characterId) : null;

  const pendingView = state.pendingResponse ? { ...state.pendingResponse } : null;

  // 回合剩余时间
  const turnTimeLeft = state.phase === "play" && !state.pendingResponse
    ? Math.max(0, TURN_TIMEOUT_SEC - Math.floor((Date.now() - state.turnStartTime) / 1000))
    : TURN_TIMEOUT_SEC;

  return {
    phase: state.phase,
    turnPlayer: state.turnPlayer,
    you: { ...me, skills: char?.skills ?? [] },
    opponent: oppView,
    attackUsed: state.attackUsed,
    pendingResponse: pendingView,
    gameOver: state.gameOver,
    winner: state.winner,
    deckCount: state.deck.length,
    turnTimeLeft,
    opponentDisconnected: state.disconnectedAt[1 - playerIdx] !== null,
    log: state.log,
    // 名字字段由 main.ts 的 broadcast() 填充
    playerName: "",
    playerId: "",
    opponentName: "",
    opponentId: "",
    handLimit: getHandLimit(state, playerIdx, me.characterId ?? ""),
  };
}
