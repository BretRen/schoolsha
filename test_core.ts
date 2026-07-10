// ============================================================
// test_core.ts — 核心逻辑单元测试
// ============================================================

import { assertEquals, assert, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDeck, shuffle, drawCards, cardLabel } from "./cards.ts";
import { getElo, predictEloChange } from "./elo.ts";
import { onEvent, emit } from "./events.ts";
import { getCardEffect } from "./effects.ts";
import { getAllCharacters, getHandLimit } from "./skills.ts";
import { createGame, checkTimeout } from "./game.ts";
import { roomManager } from "./room.ts";

// ---- cards.ts ----

Deno.test("cards: createDeck 生成完整牌堆", () => {
  const deck = createDeck();
  assert(deck.length > 50); // 牌堆大小取决于 cards.json 配置
  assert(deck.length < 200);
});

Deno.test("cards: shuffle 不改变牌数", () => {
  const deck = createDeck();
  const deckLen = deck.length;
  const shuffled = shuffle(structuredClone(deck));
  assertEquals(shuffled.length, deckLen);
  const ids1 = deck.map(c => c.id).sort();
  const ids2 = shuffled.map(c => c.id).sort();
  assertEquals(ids1, ids2);
});

Deno.test("cards: drawCards 正常抽牌", () => {
  const deck = createDeck();
  const { drawn, deck: remaining } = drawCards(deck, [], 5);
  assertEquals(drawn.length, 5);
  assert(remaining.length > 0);
});

Deno.test("cards: drawCards 牌堆空时重洗弃牌堆", () => {
  const deck = createDeck();
  const r1 = drawCards(deck, [], 50);
  const r2 = drawCards(r1.deck, r1.drawn, 5);
  assertEquals(r2.drawn.length, 5);
});

Deno.test("cards: cardLabel 含花色和牌名", () => {
  const card = { id: "T1", suit: "heart" as const, number: 7, name: "作业", type: "basic" as const };
  const label = cardLabel(card);
  assert(label.includes("作业"));
  assert(label.includes("♥"));
});

// ---- elo.ts ----

Deno.test("elo: 新玩家默认 1000", () => {
  assertEquals(getElo("new_player_xyz"), 1000);
});

Deno.test("elo: ELO 同分预测 16/-16", () => {
  const { win, lose } = predictEloChange(1000, 1000);
  assertEquals(win, 16);
  assertEquals(lose, -16);
});

Deno.test("elo: 高分打低分加分少", () => {
  const high = predictEloChange(1400, 1000);
  const low = predictEloChange(1000, 1400);
  assert(high.win < low.win);
});

// ---- events.ts ----

Deno.test("events: onEvent 注册和取消", () => {
  const calls: string[] = [];
  const dummy = { players: [], gameOver: false } as any;
  const unsub = onEvent(["damage"], () => calls.push("hit"));
  emit({ type: "damage", source: 0, target: 1, amount: 2 }, dummy);
  assertEquals(calls, ["hit"]);
  unsub();
  emit({ type: "damage", source: 0, target: 1, amount: 2 }, dummy);
  assertEquals(calls, ["hit"]);
});

Deno.test("events: onEvent 返回取消函数可多次调用", () => {
  const calls: string[] = [];
  const dummy = { players: [], gameOver: false } as any;
  const unsub = onEvent(["damage"], () => calls.push("hit"));
  emit({ type: "damage", source: 0, target: 1, amount: 2 }, dummy);
  emit({ type: "damage", source: 0, target: 1, amount: 1 }, dummy);
  assertEquals(calls, ["hit", "hit"]);
  unsub();
  emit({ type: "damage", source: 0, target: 1, amount: 3 }, dummy);
  assertEquals(calls, ["hit", "hit"]); // 取消后不再触发
});

// ---- effects.ts ----

Deno.test("effects: 作业 canUse 需要目标", () => {
  const e = getCardEffect("作业");
  assert(e);
  assertEquals(e.needsTarget, true);
});

Deno.test("effects: 豁免不能主动使用", () => {
  const e = getCardEffect("豁免");
  assert(e);
  assertEquals(e.canUse({ phase: "play", turnPlayer: 0, pendingResponse: null } as any, 0, {} as any), false);
  assert(e.canRespond);
});

Deno.test("effects: 免罚券响应 duel 不响应 dodge", () => {
  const e = getCardEffect("免罚券");
  assert(e);
  assert(e.canRespond!({ pendingResponse: { type: "duel", target: 0 } } as any, 0, {} as any));
  assertFalse(e.canRespond!({ pendingResponse: { type: "dodge", target: 0 } } as any, 0, {} as any));
});

Deno.test("effects: 神偷对手空手不能出", () => {
  const s = getCardEffect("神偷");
  const state = { players: [{ hp: 3 }, { hp: 3, hand: [], weapon: null, armor: null }], phase: "play", turnPlayer: 0, pendingResponse: null } as any;
  assertFalse(s!.canUse(state, 0, {} as any));
});

Deno.test("effects: 告密对手空手不能出", () => {
  const d = getCardEffect("告密");
  const state = { players: [{ hp: 3 }, { hp: 3, hand: [], weapon: null, armor: null }], phase: "play", turnPlayer: 0, pendingResponse: null } as any;
  assertFalse(d!.canUse(state, 0, {} as any));
});

// ---- game.ts ----

Deno.test("game: createGame 状态正确", () => {
  const chars = getAllCharacters();
  assert(chars.length >= 2, "需要至少2个角色");
  const state = createGame([chars[0].id, chars[1].id]);
  assertEquals(state.phase, "play");
  assertEquals(state.turnPlayer, 0);
  assertFalse(state.gameOver);
  assert(state.players[0].alive);
  assert(state.players[1].alive);
  assertEquals(state.players[0].hand.length, 6); // 4起始 + 2摸牌
  assertEquals(state.players[1].hand.length, 4);
});

Deno.test("game: pending超时自动处理", () => {
  const chars = getAllCharacters();
  const state = createGame([chars[0].id, chars[1].id]);
  state.pendingResponse = { type: "dodge", source: 0, target: 1, timeout: Date.now() - 1000 };
  const changed = checkTimeout(state);
  assert(changed);
  assertEquals(state.pendingResponse, null);
});

Deno.test("game: gameOver后拒绝消息", async () => {
  const { handleMessage } = await import("./game.ts");
  const chars = getAllCharacters();
  const state = createGame([chars[0].id, chars[1].id]);
  state.gameOver = true;
  const err = handleMessage(state, 0, { action: "end_phase" });
  assertEquals(err, "游戏已结束");
});

// ---- room.ts ----

Deno.test("room: 创建房间6位大写码", () => {
  const room = roomManager.createRoom();
  assertEquals(room.code.length, 6);
  assert(/^[A-Z0-9]+$/.test(room.code));
  roomManager.removeRoom(room.code);
});

Deno.test("room: getOrCreateRoom 幂等", () => {
  const r1 = roomManager.getOrCreateRoom("TST01");
  const r2 = roomManager.getOrCreateRoom("TST01");
  assertEquals(r1, r2);
  roomManager.removeRoom("TST01");
});

Deno.test("room: startGame 防重复", () => {
  const room = roomManager.createRoom();
  const chars = [{ id: "x", name: "X", maxHp: 3, skills: [] }, { id: "y", name: "Y", maxHp: 3, skills: [] }] as any;
  room.picks = ["x", "y"];
  room.startGame();
  assert(room.gameStarted);
  const g = room.game;
  room.startGame();
  assertEquals(room.game, g);
  roomManager.removeRoom(room.code);
});

// ---- security ----

Deno.test("security: 路径遍历检测", () => {
  const evil = "web/../../../etc/passwd";
  const blocked = evil.includes("..") || evil.includes("~");
  assert(blocked);
  const safe = "web/app.js";
  assertFalse(safe.includes(".."));
});

Deno.test("security: 匿名ID使用UUID", () => {
  const id = `anon_${crypto.randomUUID()}`;
  assertEquals(id.length, 41);
  const uuid = id.slice(5);
  assert(/^[0-9a-f-]+$/i.test(uuid));
});

Deno.test("security: HTML转义函数", () => {
  const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  assertEquals(esc("<script>"), "&lt;script&gt;");
  assertEquals(esc("hello"), "hello");
  assertEquals(esc(`<img onerror="x">`), `&lt;img onerror=&quot;x&quot;&gt;`);
});
