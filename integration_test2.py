"""
Single-threaded integration test — fetch both players' states, decide action, send.
"""
import asyncio, json, websockets

WS = "ws://localhost:8099"

async def recv(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=5))

async def send(ws, obj):
    await ws.send(json.dumps(obj))

def find_card(hand, name=None, ctype=None):
    for c in hand:
        if name and c["name"] == name:
            return c
        if ctype and c["type"] == ctype:
            return c
    return None

async def run_match(p0_char, p1_char, name, max_turns=300):
    print(f"\n{'='*60}")
    print(f"MATCH: {name}  ({p0_char} vs {p1_char})")
    print(f"{'='*60}")

    ws0 = await websockets.connect(WS)
    ws1 = await websockets.connect(WS)

    # character select — connect both first, then receive
    for ws, cid in [(ws0, p0_char), (ws1, p1_char)]:
        while True:
            m = await recv(ws)
            if m["type"] == "character_select":
                await send(ws, {"action": "pick_character", "id": cid})
                break
    print("  ✓ characters selected")

    m0 = await recv(ws0)
    m1 = await recv(ws1)
    st0, idx0 = m0["state"], m0["yourIndex"]
    st1, idx1 = m1["state"], m1["yourIndex"]
    print(f"  ✓ game started — P0(nerd)={len(st0['you']['hand'])} cards, P1={len(st1['you']['hand'])} cards")

    # Build ws lookup: player_index -> (ws, state)
    ws_map = {idx0: (ws0, st0), idx1: (ws1, st1)}

    for turn in range(max_turns):
        st0 = ws_map[idx0][1]
        st1 = ws_map[idx1][1]

        if st0.get("gameOver"):
            break

        acted = False

        # Priority: responder then current player
        for idx in [idx0, idx1]:
            ws, st = ws_map[idx]
            pending = st.get("pendingResponse")
            if pending and pending["target"] == idx:
                # Need to respond
                ptype = pending["type"]
                hand = st["you"]["hand"]
                card = None

                if ptype == "dodge":
                    card = find_card(hand, name="赦免")
                elif ptype == "near_death":
                    card = find_card(hand, name="放假") or find_card(hand, name="辣条")
                elif ptype in ("duel", "barbarian"):
                    card = find_card(hand, name="作业")
                elif ptype == "volley":
                    card = find_card(hand, name="赦免")
                elif ptype == "borrow_knife":
                    if hand:
                        card = hand[0]

                if card:
                    await send(ws, {"action": "play_card", "card_id": card["id"]})
                else:
                    await send(ws, {"action": "pass"})

                msg = await recv(ws)
                if msg["type"] == "game_state":
                    ws_map[idx] = (ws, msg["state"])
                acted = True
                break

        if acted:
            continue

        # Check current player's turn
        for idx in [idx0, idx1]:
            ws, st = ws_map[idx]
            if st["phase"] == "play" and st["turnPlayer"] == idx and not st.get("pendingResponse"):
                hand = st["you"]["hand"]
                you = st["you"]

                # Priority: equip > tricks > attack > heal > end
                card = None
                card = card or find_card(hand, ctype="weapon")
                card = card or find_card(hand, ctype="armor")
                card = card or find_card(hand, name="午饭")
                card = card or find_card(hand, name="神偷")
                card = card or find_card(hand, name="打小报告")
                card = card or find_card(hand, name="午饭留堂")
                card = card or find_card(hand, name="陷害")
                card = card or find_card(hand, name="团队项目")
                card = card or find_card(hand, name="拼作业")
                card = card or find_card(hand, name="作业检查")
                card = card or find_card(hand, name="最终测试")
                card = card or find_card(hand, name="嫁祸")
                card = card or find_card(hand, name="感冒")
                card = card or find_card(hand, name="点名")
                if you["hp"] < you["maxHp"]:
                    card = card or find_card(hand, name="辣条")
                    card = card or find_card(hand, name="放假")
                if not st.get("attackUsed"):
                    card = card or find_card(hand, name="作业")

                if card:
                    target = 1 - idx  # 1v1
                    await send(ws, {"action": "play_card", "card_id": card["id"], "target": target})
                else:
                    await send(ws, {"action": "end_phase"})

                msg = await recv(ws)
                if msg["type"] == "game_state":
                    ws_map[idx] = (ws, msg["state"])
                acted = True
                break

        if acted:
            continue

        # Check discard phase
        for idx in [idx0, idx1]:
            ws, st = ws_map[idx]
            if st["phase"] == "discard" and st["turnPlayer"] == idx:
                you = st["you"]
                limit = you["hp"]
                need = max(0, len(you["hand"]) - limit)
                if need > 0:
                    ids = [c["id"] for c in you["hand"][:need]]
                    await send(ws, {"action": "discard", "card_ids": ids})
                    msg = await recv(ws)
                    if msg["type"] == "game_state":
                        ws_map[idx] = (ws, msg["state"])
                    acted = True
                    break

        if not acted:
            # No action possible — wait for broadcasts
            for idx, (ws, st) in list(ws_map.items()):
                try:
                    msg = await asyncio.wait_for(recv(ws), timeout=2)
                    if msg["type"] == "game_state":
                        ws_map[idx] = (ws, msg["state"])
                except asyncio.TimeoutError:
                    pass

    await ws0.close()
    await ws1.close()

    final = ws_map[idx0][1]
    p0 = final["you"]
    p1_final = ws_map[idx1][1]
    p1 = p1_final["you"]
    print(f"  Game over after {turn+1} turns")
    print(f"  P0 ({p0_char}): hp={p0['hp']}/{p0['maxHp']}, alive={p0['alive']}")
    print(f"  P1 ({p1_char}): hp={p1['hp']}/{p1['maxHp']}, alive={p1['alive']}")
    print(f"  winner=P{final.get('winner','?')}")
    return True

async def main():
    print("="*60)
    print("SCHOOLSHA INTEGRATION TESTS v2")
    print("="*60)

    for c0, c1, name in [
        ("normal", "normal", "Normal v Normal"),
        ("monitor", "athlete", "Monitor v Athlete"),
        ("nerd", "normal", "Nerd v Normal"),
    ]:
        ok = await run_match(c0, c1, name)
        if not ok:
            print(f"  ❌ FAIL")

    print("\n✅ ALL DONE")

asyncio.run(main())
