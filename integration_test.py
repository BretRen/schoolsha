"""
Integration test — single WS bot pair, properly targets, handles all flow.
"""
import asyncio
import json
import websockets

WS = "ws://localhost:8099"

async def run_match(p0_char, p1_char, name, timeout=60):
    print(f"\n{'='*60}")
    print(f"MATCH: {name}  ({p0_char} vs {p1_char})")
    print(f"{'='*60}")

    ws0 = await websockets.connect(WS)
    ws1 = await websockets.connect(WS)

    async def recv(ws, label):
        raw = await ws.recv()
        return json.loads(raw)

    async def send(ws, obj):
        await ws.send(json.dumps(obj))

    # phase: "select" | "play"
    phase = "select"
    state0 = state1 = None
    idx0 = idx1 = -1
    turn = 0  # track consecutive game_state msgs

    # wait for character_select
    for ws, char_id in [(ws0, p0_char), (ws1, p1_char)]:
        while True:
            msg = await recv(ws, "")
            if msg.get("type") == "character_select":
                await send(ws, {"action": "pick_character", "id": char_id})
                break
            elif msg.get("type") == "waiting":
                continue

    print("  ✓ characters selected")

    # Now both get game_state
    msg0 = await recv(ws0, "P0")
    msg1 = await recv(ws1, "P1")

    assert msg0["type"] == "game_state", f"P0 expected game_state, got {msg0['type']}"
    assert msg1["type"] == "game_state", f"P1 expected game_state, got {msg1['type']}"
    state0, idx0 = msg0["state"], msg0["yourIndex"]
    state1, idx1 = msg1["state"], msg1["yourIndex"]
    print(f"  ✓ game started, P{idx0} vs P{idx1}")

    # Helper to find a card by name/type in hand
    def find_card(state, name=None, ctype=None):
        for c in state["you"]["hand"]:
            if name and c["name"] == name:
                return c
            if ctype and c["type"] == ctype:
                return c
        return None

    # Helper: send play_card with proper target
    async def play_card(ws, state, idx, card_id):
        """Send play_card. For 1v1, if not pending, target=opponent."""
        target = None
        pending = state.get("pendingResponse")
        if not pending:
            target = 1 - idx
        await send(ws, {"action": "play_card", "card_id": card_id, "target": target})

    async def auto_respond(ws, state, idx):
        """Respond to pending request."""
        pending = state["pendingResponse"]
        if not pending or pending["target"] != idx:
            return False

        ptype = pending["type"]
        hand = state["you"]["hand"]

        if ptype == "dodge":
            card = find_card(state, name="赦免")
            if card:
                await play_card(ws, state, idx, card["id"])
                return True

        elif ptype == "near_death":
            card = find_card(state, name="放假") or find_card(state, name="辣条")
            if card:
                await play_card(ws, state, idx, card["id"])
                return True

        elif ptype == "duel":
            card = find_card(state, name="作业")
            if card:
                await play_card(ws, state, idx, card["id"])
                return True

        elif ptype == "barbarian":
            card = find_card(state, name="作业")
            if card:
                await play_card(ws, state, idx, card["id"])
                return True

        elif ptype == "volley":
            card = find_card(state, name="赦免")
            if card:
                await play_card(ws, state, idx, card["id"])
                return True

        elif ptype == "borrow_knife":
            if hand:
                await play_card(ws, state, idx, hand[0]["id"])
                return True

        # Can't respond → pass
        await send(ws, {"action": "pass"})
        return True

    async def auto_play(ws, state, idx):
        """Play one card in play phase."""
        you = state["you"]
        hand = you["hand"]
        pending = state.get("pendingResponse")

        if pending:
            if pending["target"] == idx:
                return await auto_respond(ws, state, idx)
            return False  # opponent needs to respond, wait

        if state["phase"] != "play" or state["turnPlayer"] != idx:
            return False

        # Priority: equip > self-buff > trick > attack > heal > end
        priorities = [
            (lambda c: c["type"] in ("weapon", "armor"), "equip"),
            (lambda c: c["name"] in ("午饭",), "draw"),
            (lambda c: c["name"] in ("神偷", "打小报告", "午饭留堂"), "steal/discard"),
            (lambda c: c["name"] in ("陷害", "团队项目", "点名", "感冒", "拼作业", "作业检查", "最终测试", "嫁祸"), "attack trick"),
            (lambda c: c["name"] == "辣条" and you["hp"] < you["maxHp"], "buff"),
            (lambda c: c["name"] == "放假" and you["hp"] < you["maxHp"], "heal"),
            (lambda c: c["name"] == "作业" and not state.get("attackUsed", True), "attack"),
        ]

        for pred, _ in priorities:
            for c in hand:
                if pred(c):
                    await play_card(ws, state, idx, c["id"])
                    return True

        # Nothing to play → end turn
        await send(ws, {"action": "end_phase"})
        return True

    async def auto_discard(ws, state, idx):
        if state["phase"] != "discard" or state["turnPlayer"] != idx:
            return False
        you = state["you"]
        limit = you["hp"]
        need = max(0, len(you["hand"]) - limit)
        if need > 0:
            ids = [c["id"] for c in you["hand"][:need]]
            await send(ws, {"action": "discard", "card_ids": ids})
            return True
        # hp >= hand count, no discard needed — but we need to tell server to advance
        # Actually the server handles this in enterPhase: if hand <= limit, auto-advances
        return False

    # ---- Main loop ----
    game_over = False
    turns = 0
    while not game_over and turns < 200:
        turns += 1

        # Check players in order: first the responder if pending, then current player
        # P0 always gets priority in processing
        for ws, state, idx in [(ws0, state0, idx0), (ws1, state1, idx1)]:
            if state["gameOver"]:
                game_over = True
                continue

            pending = state.get("pendingResponse")
            if pending and pending["target"] == idx:
                acted = await auto_respond(ws, state, idx)
                if acted:
                    # Get response from server
                    try:
                        msg = await asyncio.wait_for(recv(ws, ""), timeout=3)
                    except asyncio.TimeoutError:
                        continue
                    if msg.get("type") == "game_state":
                        if idx == idx0: state0 = msg["state"]
                        else: state1 = msg["state"]
                    continue

            if state["phase"] == "play" and state["turnPlayer"] == idx:
                acted = await auto_play(ws, state, idx)
                if acted:
                    try:
                        msg = await asyncio.wait_for(recv(ws, ""), timeout=3)
                    except asyncio.TimeoutError:
                        continue
                    if msg.get("type") == "game_state":
                        if idx == idx0: state0 = msg["state"]
                        else: state1 = msg["state"]
                    continue

            if state["phase"] == "discard" and state["turnPlayer"] == idx:
                acted = await auto_discard(ws, state, idx)
                if acted:
                    try:
                        msg = await asyncio.wait_for(recv(ws, ""), timeout=3)
                    except asyncio.TimeoutError:
                        continue
                    if msg.get("type") == "game_state":
                        if idx == idx0: state0 = msg["state"]
                        else: state1 = msg["state"]
                    continue

        # Wait for broadcasts that might have gone to both
        # Drain any pending messages
        for ws, label in [(ws0, "P0"), (ws1, "P1")]:
            try:
                msg = await asyncio.wait_for(recv(ws, label), timeout=1)
                if msg.get("type") == "game_state":
                    if label == "P0": state0 = msg["state"]
                    else: state1 = msg["state"]
                    if msg["state"].get("gameOver"):
                        game_over = True
            except asyncio.TimeoutError:
                pass

        await asyncio.sleep(0.05)

    await ws0.close()
    await ws1.close()

    print(f"  Game over after {turns} turns")
    p0 = state0["you"] if state0 else {}
    p1 = state1["you"] if state1 else {}
    print(f"  P0 ({p0_char}): hp={p0.get('hp','?')}/{p0.get('maxHp','?')}, alive={p0.get('alive','?')}")
    print(f"  P1 ({p1_char}): hp={p1.get('hp','?')}/{p1.get('maxHp','?')}, alive={p1.get('alive','?')}")
    print(f"  winner={state0.get('winner','?') if state0 else '?'}")
    return game_over


async def main():
    print("=" * 60)
    print("SCHOOLSHA INTEGRATION TESTS")
    print("=" * 60)

    results = []

    # Test 1: Normal vs Normal
    r = await run_match("normal", "normal", "Normal v Normal")
    results.append(("Normal v Normal", r))

    # Test 2: With skills
    r = await run_match("monitor", "athlete", "Monitor v Athlete")
    results.append(("Monitor v Athlete", r))

    # Test 3
    r = await run_match("nerd", "normal", "Nerd v Normal")
    results.append(("Nerd v Normal", r))

    print("\n" + "=" * 60)
    print("RESULTS SUMMARY")
    print("=" * 60)
    for name, ok in results:
        status = "✅ PASS" if ok else "❌ FAIL (timeout)"
        print(f"  {status}  {name}")

if __name__ == "__main__":
    asyncio.run(main())
