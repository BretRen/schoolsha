"""
Full WebSocket game test — two bot players auto-play until game over.
Tests: character select, all phases, card play, responses, equipment, timeout.
"""
import asyncio
import json
import websockets
import sys

WS = "ws://localhost:8099"

class Player:
    def __init__(self, name, char_id):
        self.name = name
        self.char_id = char_id
        self.ws = None
        self.state = None
        self.my_index = -1
        self.log = []

    async def connect(self):
        self.ws = await websockets.connect(WS)
        self.log.append(f"[{self.name}] connected")
        return self

    async def recv(self):
        raw = await self.ws.recv()
        msg = json.loads(raw)
        self.log.append(f"[{self.name}] << {msg.get('type')} {str(msg)[:200]}")
        return msg

    async def send(self, obj):
        self.log.append(f"[{self.name}] >> {json.dumps(obj)[:200]}")
        await self.ws.send(json.dumps(obj))

    async def wait_for(self, msg_type):
        """Wait for a specific message type, return it."""
        while True:
            msg = await self.recv()
            if msg.get("type") == msg_type:
                if msg_type == "game_state":
                    self.state = msg["state"]
                    self.my_index = msg["yourIndex"]
                return msg

    async def play_until_game_over(self, opponent):
        """Auto-play loop until game over."""
        while True:
            msg = await self.recv()
            if msg.get("type") == "game_state":
                self.state = msg["state"]
                self.my_index = msg["yourIndex"]
                st = self.state

                if st.get("gameOver"):
                    self.log.append(f"[{self.name}] GAME OVER, winner={st.get('winner')}")
                    return

                # If opponent disconnected, just wait
                if st.get("opponentDisconnected"):
                    self.log.append(f"[{self.name}] opponent disconnected, waiting...")
                    await asyncio.sleep(2)
                    continue

                pending = st.get("pendingResponse")
                if pending and pending.get("target") == self.my_index:
                    await self._handle_response(pending)
                elif st.get("phase") == "play" and st["turnPlayer"] == self.my_index:
                    await self._auto_play_turn()
                elif st.get("phase") == "discard" and st["turnPlayer"] == self.my_index:
                    await self._auto_discard()

            elif msg.get("type") == "character_select":
                await self.send({"action": "pick_character", "id": self.char_id})

            elif msg.get("type") == "error":
                self.log.append(f"[{self.name}] ERROR: {msg['message']}")
                # Don't crash on errors, just log

            elif msg.get("type") in ("disconnected", "reconnected"):
                self.log.append(f"[{self.name}] {msg['type']}: {msg.get('message','')}")

    async def _handle_response(self, pending):
        """Auto-respond to pending."""
        ptype = pending["type"]
        you = self.state["you"]
        hand = you["hand"]

        self.log.append(f"[{self.name}] need to respond to {ptype}")

        if ptype == "dodge":
            # Find 赦免
            for c in hand:
                if c["name"] == "赦免":
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    return
            # Can't dodge, pass
            await self.send({"action": "pass"})

        elif ptype == "near_death":
            for c in hand:
                if c["name"] in ("放假", "辣条"):
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    return
            await self.send({"action": "pass"})

        elif ptype == "duel":
            for c in hand:
                if c["name"] == "作业":
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    return
            await self.send({"action": "pass"})

        elif ptype == "barbarian":
            for c in hand:
                if c["name"] == "作业":
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    return
            await self.send({"action": "pass"})

        elif ptype == "volley":
            for c in hand:
                if c["name"] == "赦免":
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    return
            await self.send({"action": "pass"})

        elif ptype == "borrow_knife":
            if hand:
                await self.send({"action": "play_card", "card_id": hand[0]["id"]})
            else:
                await self.send({"action": "pass"})

    async def _auto_play_turn(self):
        """Auto-play cards in play phase."""
        you = self.state["you"]
        hand = you["hand"]
        pending = self.state.get("pendingResponse")

        if pending:
            return  # Let _handle_response deal with it

        # Priority order: equip > trick > attack > heal > end
        played = False

        for c in hand:
            if c["type"] in ("weapon", "armor"):
                # Equip it
                self.log.append(f"[{self.name}] equipping {c['name']}")
                await self.send({"action": "play_card", "card_id": c["id"]})
                played = True
                break

        if not played:
            for c in hand:
                if c["name"] in ("神偷", "打小报告", "午饭留堂", "午饭"):
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    played = True
                    break

        if not played:
            for c in hand:
                if c["name"] in ("陷害", "团队项目", "点名", "感冒", "拼作业", "作业检查", "最终测试", "嫁祸"):
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    played = True
                    break

        if not played:
            # Try 作业 (attack)
            attack_ok = not self.state.get("attackUsed", True)
            if attack_ok:
                for c in hand:
                    if c["name"] == "作业":
                        await self.send({"action": "play_card", "card_id": c["id"]})
                        played = True
                        break

        if not played:
            for c in hand:
                if c["name"] == "辣条" and you["hp"] < you["maxHp"]:
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    played = True
                    break

        if not played:
            for c in hand:
                if c["name"] == "放假" and you["hp"] < you["maxHp"]:
                    await self.send({"action": "play_card", "card_id": c["id"]})
                    played = True
                    break

        if not played:
            self.log.append(f"[{self.name}] ending turn (no playable cards)")
            await self.send({"action": "end_phase"})

        # Small delay to let server process
        await asyncio.sleep(0.1)

    async def _auto_discard(self):
        """Auto-discard down to hand limit."""
        you = self.state["you"]
        limit = you["hp"]  # approximate, doesn't account for skills
        need = max(0, len(you["hand"]) - limit)
        if need > 0:
            ids = [c["id"] for c in you["hand"][:need]]
            self.log.append(f"[{self.name}] discarding {need} cards")
            await self.send({"action": "discard", "card_ids": ids})
        # Wait for server
        await asyncio.sleep(0.1)

    async def close(self):
        if self.ws:
            await self.ws.close()


async def run_match(p0_char, p1_char, match_name):
    print(f"\n{'='*60}")
    print(f"MATCH: {match_name}")
    print(f"P0={p0_char}, P1={p1_char}")
    print(f"{'='*60}")

    p0 = Player("P0", p0_char)
    p1 = Player("P1", p1_char)

    await asyncio.gather(p0.connect(), p1.connect())

    # Run both players
    try:
        await asyncio.wait_for(
            asyncio.gather(
                p0.play_until_game_over(p1),
                p1.play_until_game_over(p0),
            ),
            timeout=120  # 2 min max
        )
    except asyncio.TimeoutError:
        print("⏰ TIMEOUT after 120s")

    await asyncio.gather(p0.close(), p1.close())

    # Summary
    print(f"\n--- {match_name} result ---")
    print(f"P0 ({p0_char}) final state: gameOver={p0.state.get('gameOver') if p0.state else '?'}, hp={p0.state['you']['hp'] if p0.state else '?'}")
    print(f"P1 ({p1_char}) final state: gameOver={p1.state.get('gameOver') if p1.state else '?'}, hp={p1.state['you']['hp'] if p1.state else '?'}")

    # Check for errors
    for player in [p0, p1]:
        errors = [l for l in player.log if "ERROR" in l]
        if errors:
            print(f"  {player.name} ERRORS: {errors}")

    return p0, p1


async def main():
    print("=" * 60)
    print("SCHOOLSHA FULL WS GAME TEST")
    print("=" * 60)

    # Test 1: Basic match (normal students)
    print("\n>>> Test 1: Normal vs Normal")
    await run_match("normal", "normal", "Normal vs Normal")

    # Test 2: With characters and skills
    print("\n>>> Test 2: Monitor vs Athlete")
    await run_match("monitor", "athlete", "Monitor vs Athlete")

    # Test 3: Nerd vs Athlete
    print("\n>>> Test 3: Nerd vs Monitor")
    await run_match("nerd", "monitor", "Nerd vs Monitor")

    print("\n" + "=" * 60)
    print("ALL WS TESTS COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
