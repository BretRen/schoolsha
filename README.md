# SchoolSha

**English** | [Chinese](./README.zh.md)

"School Sha" is a 1v1 card game inspired by _Three Kingdoms Kill_ (Sanguosha),
co-created by Stoller students.

> Full Name: Stoller SchoolSha

---

## Documentation

- **[卡牌图鉴](./docs/CARDS.md)** — 全部 88 张牌的效果与花色
- **[角色与技能](./docs/CHARACTERS.md)** — 4 个角色及技能说明
- **[PKCE 认证流程](./docs/PKCE_FLOW.md)** — 客户端接入指南（Godot / 浏览器 /
  Deno）

---

## Tech Stack

- **Backend**: Deno + TypeScript (WebSocket server)
- **Auth**: Zitadel OIDC + PKCE (S256)
- **Frontend**: Godot 4 (in development)
- **Config**: JSON-driven (cards, characters, skills)

## Architecture

```
main.ts      WebSocket server + lobby + auth
game.ts      Phase engine + turn timeout + disconnect
effects.ts   25 card effects + equipment + response system
events.ts    Event bus (skill hook point)
skills.ts    Skill runtime (JSON → event handlers)
cards.ts     Deck creation / shuffle / draw
types.ts     All type definitions + WS protocol
auth.ts      Zitadel JWT validation (JWKS)
```

### Config files

```
cards.json        88 cards
characters.json    4 characters
skills.json        3 skills
```

---

## Quick Start

```bash
# Server
deno run --allow-net --allow-env --env-file=.env main.ts

# CLI client (for testing)
deno run --allow-net cli.ts

# Tests
deno run --allow-env test_equip.ts
```

---

## Credits

> In no particular order

- Development: [Pidan](https://github.com/bretren)
- Characters & Game Design: NieCi, CottonBunny,
  [Pidan](https://github.com/bretren)
- Review: NieCi, Tim

## Origins

One day, while playing _Three Kingdoms Kill_ at school, the idea struck: why not
create a school-themed version? Although a physical paper version was initially
attempted, it was abandoned due to the summer break and other factors; the
project subsequently shifted to a software-based version.

## Disclaimer & Statement

- This project has no affiliation with Stoller Middle School.
- This project is not part of the Beaverton School District.
- The characters in this project (including students, teachers, etc.) are not
  connected to real-life individuals; please do not over-interpret them.
- **This software is provided "as-is."**
- This project is open-source under the MIT License, covering all code. However,
  this excludes:
  - Artwork copyrights
  - Characters
- Code Copyright: Bret Ren
- Character & Artwork Copyright: The production team
