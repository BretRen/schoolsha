"""Quick single-match test."""
import asyncio, json, websockets, sys

WS = "ws://localhost:8099"

async def quick_test():
    ws0 = await websockets.connect(WS)
    ws1 = await websockets.connect(WS)

    # Wait for character_select
    for ws, cid in [(ws0, "nerd"), (ws1, "normal")]:
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("type") == "character_select":
                await ws.send(json.dumps({"action": "pick_character", "id": cid}))
                break
    print("chars picked")

    # Read initial state
    s0 = json.loads(await ws0.recv())
    s1 = json.loads(await ws1.recv())
    st = s0["state"]
    turn = st["turnPlayer"]
    p0_hand = st["you"]["hand"]
    p1_hand = s1["state"]["you"]["hand"]
    print(f"P0 (nerd) hand: {len(p0_hand)} cards")
    print(f"P1 (normal) hand: {len(p1_hand)} cards")
    print(f"Turn: P{turn}")

    # P0 starts. Let's auto-play a few turns manually
    # The draw phase should give P0 3 cards (base 2 + cram 1) when it's their turn

    await ws0.close()
    await ws1.close()
    print("done")

asyncio.run(quick_test())
