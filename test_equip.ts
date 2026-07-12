// Unit test: equip mechanics (runs without WebSocket)
import { Card, CardType, GameState, Player, Suit } from "./types.ts";
import {
  getCardEffect,
  handleStealCard,
  handleTimeout,
  registerCardEffect as _registerCardEffect,
  tryUseCard,
} from "./effects.ts";

// Build a minimal game state with known cards
function makeCard(
  id: string,
  name: string,
  type: string,
  suit: string,
  num: number,
): Card {
  return { id, name, suit: suit as Suit, number: num, type: type as CardType };
}

function makeState(): GameState {
  const p0: Player = {
    hp: 3,
    maxHp: 3,
    hand: [],
    alive: true,
    characterId: "student",
    weapon: null,
    armor: null,
  };
  const p1: Player = {
    hp: 3,
    maxHp: 3,
    hand: [],
    alive: true,
    characterId: "student",
    weapon: null,
    armor: null,
  };
  return {
    phase: "play",
    turnPlayer: 0,
    players: [p0, p1],
    deck: [],
    discard: [],
    attackUsed: false,
    pendingResponse: null,
    gameOver: false,
    winner: null,
    turnStartTime: Date.now(),
    disconnectCount: [0, 0],
    disconnectedAt: [null, null],
    wineUsed: [false, false],
    skillUseCount: {},
    log: [],
  };
}

// ---------- Test 1: Equip weapon ----------
{
  const s = makeState();
  s.players[0].hand = [makeCard("C1", "钢笔", "weapon", "diamond", 1)];
  s.players[1].hand = [makeCard("C2", "豁免", "basic", "diamond", 2)];

  const err = tryUseCard(s, 0, "C1");
  if (err) throw new Error("Test 1 FAIL: equip error: " + err);
  if (s.players[0].weapon?.name !== "钢笔") {
    throw new Error(
      "Test 1 FAIL: weapon not equipped, got " + s.players[0].weapon?.name,
    );
  }
  if (s.players[0].hand.length !== 0) {
    throw new Error("Test 1 FAIL: card not removed from hand");
  }
  console.log("PASS Test 1: equip weapon");
}

// ---------- Test 2: Replace weapon ----------
{
  const s = makeState();
  s.players[0].hand = [
    makeCard("C1", "钢笔", "weapon", "diamond", 1),
    makeCard("C2", "圆规", "weapon", "diamond", 1),
  ];
  s.players[1].hand = [makeCard("C3", "豁免", "basic", "diamond", 2)];

  tryUseCard(s, 0, "C1");
  tryUseCard(s, 0, "C2");
  if (s.players[0].weapon?.name !== "圆规") {
    throw new Error("Test 2 FAIL: new weapon not equipped");
  }
  if (s.discard.length !== 1 || s.discard[0].name !== "钢笔") {
    throw new Error("Test 2 FAIL: old weapon not discarded");
  }
  console.log("PASS Test 2: replace weapon → old to discard");
}

// ---------- Test 3: Equip armor ----------
{
  const s = makeState();
  s.players[0].hand = [makeCard("C1", "校服", "armor", "club", 2)];
  s.players[1].hand = [makeCard("C2", "豁免", "basic", "diamond", 2)];

  tryUseCard(s, 0, "C1");
  if (s.players[0].armor?.name !== "校服") throw new Error("Test 3 FAIL");
  console.log("PASS Test 3: equip armor");
}

// ---------- Test 4: Weapon + armor both equipped ----------
{
  const s = makeState();
  s.players[0].hand = [
    makeCard("C1", "钢笔", "weapon", "diamond", 1),
    makeCard("C2", "校服", "armor", "club", 2),
  ];
  s.players[1].hand = [makeCard("C3", "豁免", "basic", "diamond", 2)];

  tryUseCard(s, 0, "C1");
  tryUseCard(s, 0, "C2");
  if (s.players[0].weapon?.name !== "钢笔") {
    throw new Error("Test 4 FAIL: weapon missing");
  }
  if (s.players[0].armor?.name !== "校服") {
    throw new Error("Test 4 FAIL: armor missing");
  }
  console.log("PASS Test 4: weapon + armor simultaneously");
}

// ---------- Test 5: 校服 blocks black 作业 ----------
{
  const s = makeState();
  s.players[0].hand = [makeCard("C1", "作业", "basic", "spade", 7)];
  s.players[1].hand = [makeCard("C2", "豁免", "basic", "diamond", 2)];
  s.players[1].armor = makeCard("CA", "校服", "armor", "club", 2);

  tryUseCard(s, 0, "C1", 0);
  // Card should be consumed but no pending (blocked by 校服)
  if (s.pendingResponse !== null) {
    throw new Error("Test 5 FAIL: black 作业 should be blocked by 校服");
  }
  if (s.players[0].hand.length !== 0) {
    throw new Error("Test 5 FAIL: card should be consumed");
  }
  console.log("PASS Test 5: 校服 blocks black 作业");
}

// ---------- Test 6: 黑名单 blocks 作业 ----------
{
  const s = makeState();
  s.players[0].hand = [makeCard("C1", "作业", "basic", "heart", 10)];
  s.players[1].hand = [makeCard("C2", "豁免", "basic", "diamond", 2)];
  s.players[1].armor = makeCard("CA", "黑名单", "armor", "club", 2);

  tryUseCard(s, 0, "C1", 0);
  if (s.pendingResponse !== null) {
    throw new Error("Test 6 FAIL: 作业 should be blocked by 黑名单");
  }
  console.log("PASS Test 6: 黑名单 blocks 作业");
}

// ---------- Test 7: 钢笔 +1 damage ----------
{
  const s = makeState();
  s.players[0].weapon = makeCard("CW", "钢笔", "weapon", "diamond", 1);
  s.players[0].hand = [makeCard("C1", "作业", "basic", "heart", 10)];
  s.players[1].hand = [];
  s.players[1].hp = 3;

  // Play 作业, don't respond → timeout
  tryUseCard(s, 0, "C1", 0);
  if (!s.pendingResponse || s.pendingResponse.type !== "dodge") {
    throw new Error("Test 7 FAIL: no dodge pending");
  }

  // Simulate timeout
  s.pendingResponse.timeout = 0;
  handleTimeout(s);

  if (s.players[1].hp !== 1) {
    throw new Error(
      "Test 7 FAIL: expected 2 damage (base 1 + 钢笔 1), got hp=" +
        s.players[1].hp,
    );
  }
  console.log("PASS Test 7: 钢笔 deals +1 damage (total 2)");
}

// ---------- Test 8: AI allows multiple attacks ----------
{
  const s = makeState();
  s.attackUsed = true;
  s.players[0].weapon = makeCard("CW", "圆规", "weapon", "diamond", 1);
  s.players[0].hand = [makeCard("C1", "作业", "basic", "heart", 10)];
  s.players[1].hand = [makeCard("C2", "豁免", "basic", "diamond", 2)];

  const eff = getCardEffect("作业");
  if (!eff) throw new Error("Test 8 FAIL: no 作业 effect");
  if (!eff.canUse(s, 0, s.players[0].hand[0])) {
    throw new Error(
      "Test 8 FAIL: 圆规 should allow attack even with attackUsed=true",
    );
  }
  console.log("PASS Test 8: 圆规 ignores attackUsed limit");
}

// ---------- Test 9: 告密 can discard equipment (blind steal) ----------
{
  const s = makeState();
  s.players[0].hand = [makeCard("C1", "告密", "trick", "spade", 5)];
  s.players[1].hand = [];
  s.players[1].weapon = makeCard("CW", "钢笔", "weapon", "diamond", 1);
  s.players[1].armor = makeCard("CA", "校服", "armor", "club", 2);

  tryUseCard(s, 0, "C1", 0);
  // 告密 sets steal pending — resolve it by picking position 1
  if (!s.pendingResponse || s.pendingResponse.type !== "steal") {
    throw new Error("Test 9 FAIL: no steal pending");
  }
  handleStealCard(s, 0, 1); // pick position 1 (first in pool)
  // Should have discarded from the weapon or armor pool
  if (s.players[1].weapon !== null && s.players[1].armor !== null) {
    throw new Error("Test 9 FAIL: nothing discarded from equipment pool");
  }
  console.log("PASS Test 9: 告密 can target equipment");
}

// ---------- Test 10: 神偷 can steal equipment (blind steal) ----------
{
  const s = makeState();
  s.players[0].hand = [makeCard("C1", "神偷", "trick", "spade", 3)];
  s.players[1].hand = [];
  s.players[1].weapon = makeCard("CW", "尺子", "weapon", "spade", 5);

  tryUseCard(s, 0, "C1", 0);
  // 神偷 sets steal pending — resolve by picking position 1
  if (!s.pendingResponse || s.pendingResponse.type !== "steal") {
    throw new Error("Test 10 FAIL: no steal pending");
  }
  handleStealCard(s, 0, 1);
  if (s.players[1].weapon !== null) {
    throw new Error("Test 10 FAIL: weapon not stolen");
  }
  // Should be in P0's hand now
  if (!s.players[0].hand.some((c) => c.name === "尺子")) {
    throw new Error("Test 10 FAIL: stolen card not in P0 hand");
  }
  console.log("PASS Test 10: 神偷 can steal equipment");
}

console.log("\n🎉 ALL 10 TESTS PASSED");
