// ============================================================
// cli.ts — 三国杀 1v1 命令行客户端 (Cliffy)
// ============================================================
// 用法: deno run --allow-net --allow-env cli.ts [ws://localhost:8099]

import { colors, tty } from "cliffy/ansi";
import { Input } from "cliffy/prompt";
import type { Card, ServerStateView } from "./types.ts";

const WS_URL = Deno.args[0] || "ws://localhost:8099";

const C = {
  t: colors.bold.cyan,
  ph: colors.bold.yellow,
  ok: colors.green,
  na: colors.dim,
  hp: colors.red,
  lost: colors.dim,
  cb: colors.white,
  cr: colors.red,
  danger: (s: string) => colors.bgRed.white(" " + s + " "),
  success: (s: string) => colors.bgGreen.white(" " + s + " "),
  warn: (s: string) => colors.bgYellow.black(" " + s + " "),
  dim: colors.dim,
  err: colors.red,
  win: colors.bold.green,
  lose: colors.bold.red,
};

let state: ServerStateView | null = null;
let myIndex = -1;
let errorMsg = "";
const ws = new WebSocket(WS_URL);

ws.onopen = () => {
  render();
  promptLoop();
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "game_state") {
    state = msg.state;
    myIndex = msg.yourIndex;
    errorMsg = "";
    render();
  } else if (msg.type === "error") {
    errorMsg = msg.message;
    render();
  }
};
ws.onclose = () => {
  tty.cursorShow();
  console.log(C.dim("\n  连接断开"));
  Deno.exit(0);
};

function send(obj: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function pn(p: string) {
  return ({
    judge: "判定",
    draw: "摸牌",
    play: "出牌",
    discard: "弃牌",
    end: "结束",
  } as Record<string, string>)[p] || p;
}
function si(s: string) {
  return ({ spade: "♠", heart: "♥", club: "♣", diamond: "♦" } as Record<
    string,
    string
  >)[s] || "?";
}
function cs(c: Card) {
  const clr = (c.suit === "spade" || c.suit === "club") ? C.cb : C.cr;
  const n = ({ 1: "A", 11: "J", 12: "Q", 13: "K" } as Record<number, string>)[
    c.number
  ] ?? String(c.number).padStart(2, " ");
  return `${clr(si(c.suit) + n)} ${c.name}`;
}
function hpBar(hp: number, max: number) {
  let s = "";
  for (let i = 0; i < max; i++) s += i < hp ? C.hp("♥") : C.lost("♡");
  return s + ` ${colors.yellow(String(hp))}/${max}`;
}
function br() {
  return C.dim("─".repeat(44));
}

function render() {
  tty.cursorHide();
  console.clear();
  if (!state) {
    console.log(
      C.t("\n  ⏳ 三国杀 CLI\n") + C.dim(`  ${WS_URL} — 等待对手...\n`),
    );
    return;
  }

  const me = state.you, opp = state.opponent;
  let tag = "";
  if (state.gameOver) tag = C.danger("GAME OVER");
  else if (state.turnPlayer === myIndex && state.phase === "play") {
    tag = C.success("你的回合");
  } else if (state.pendingResponse?.target === myIndex) {
    tag = C.danger("需要响应");
  } else if (
    state.phase === "discard" && state.turnPlayer === myIndex &&
    me.hand.length > me.hp
  ) {
    tag = C.warn("需要弃牌");
  }

  console.log(C.t("\n  SchoolSha") + C.dim(`  玩家${myIndex}`) + "  " + tag);

  if (state.gameOver) {
    console.log(
      (state.winner === myIndex
        ? C.win("\n  🎉 你赢了！")
        : C.lose("\n  💀 你输了")) + "\n",
    );
    return;
  }

  const atk = (state.phase === "play" && state.turnPlayer === myIndex)
    ? (state.attackUsed ? C.na("杀:已用") : C.ok("杀:可用"))
    : "";
  console.log(
    `  ${C.ph(pn(state.phase))}  │  ${
      C.dim("牌堆:" + state.deckCount)
    }  │  ${atk}`,
  );
  console.log(`  ${br()}`);

  console.log(
    `  ${C.dim("对手")}  ${hpBar(opp.hp, opp.maxHp)}  ${
      C.dim("手牌:" + opp.handCount)
    }`,
  );

  if (state.pendingResponse) {
    if (state.pendingResponse.target === myIndex) {
      console.log(C.danger("\n  ⚠ 对方出了杀！请出【闪】"));
    } else if (state.pendingResponse.source === myIndex) {
      console.log(C.dim("\n  ⌛ 等待对手出闪..."));
    }
  }

  console.log(
    colors.bold(`\n  你的手牌`) + `  (HP: ${hpBar(me.hp, me.maxHp)})`,
  );
  if (me.hand.length === 0) console.log(`  ${C.dim("(空)")}`);
  else {
    for (let r = 0; r < Math.ceil(me.hand.length / 4); r++) {
      const row = me.hand.slice(r * 4, (r + 1) * 4);
      console.log(
        "  " +
          row.map((c, i) =>
            C.dim(`[${String(r * 4 + i + 1).padStart(2)}]`) + " " + cs(c)
          ).join("  "),
      );
    }
  }

  console.log(`\n  ${br()}`);
  if (state.pendingResponse?.target === myIndex) {
    console.log(`  ${colors.yellow("闪 <编号>")}    出闪响应`);
  } else if (
    state.phase === "discard" && state.turnPlayer === myIndex &&
    me.hand.length > me.hp
  ) {
    console.log(
      `  ${colors.yellow("弃 <编号> ...")}    需要弃 ${
        me.hand.length - me.hp
      } 张`,
    );
  } else if (state.turnPlayer === myIndex && state.phase === "play") {
    console.log(
      `  ${colors.green("出 <编号>")}    出牌  │  ${
        colors.green("结束")
      }    结束出牌`,
    );
  } else console.log(`  ${C.dim("等待对手操作...")}`);

  if (errorMsg) {
    console.log(`\n  ${C.err("✗")} ${colors.red(errorMsg)}`);
    errorMsg = "";
  }
  console.log("");
}

async function promptLoop() {
  while (ws.readyState === WebSocket.OPEN) {
    const raw = await Input.prompt({ message: "", prefix: colors.cyan(">") });
    if (!raw || !state || state.gameOver) continue;
    const cmd = raw.trim();
    if (!cmd) continue;
    handleCmd(cmd);
  }
}

function handleCmd(cmd: string) {
  const parts = cmd.split(/\s+/);
  const a = parts[0];
  if (a === "出" || a === "play") {
    const n = parseInt(parts[1]);
    if (isNaN(n) || !state || n < 1 || n > state.you.hand.length) {
      errorMsg = `无效编号: ${parts[1]}`;
      render();
      return;
    }
    send({
      action: "play_card",
      card_id: state.you.hand[n - 1].id,
      target: state.pendingResponse ? undefined : 1 - myIndex,
    });
  } else if (a === "闪" || a === "dodge") {
    const n = parseInt(parts[1]);
    if (isNaN(n) || !state || n < 1 || n > state.you.hand.length) {
      errorMsg = `无效编号: ${parts[1]}`;
      render();
      return;
    }
    if (state.you.hand[n - 1].name !== "闪") {
      errorMsg = "不是闪";
      render();
      return;
    }
    send({ action: "play_card", card_id: state.you.hand[n - 1].id });
  } else if (a === "结束" || a === "end") {
    send({ action: "end_phase" });
  } else if (a === "弃" || a === "discard") {
    const nums = parts.slice(1).map(Number);
    if (nums.some(isNaN) || !state) {
      errorMsg = "格式: 弃 1 3";
      render();
      return;
    }
    send({
      action: "discard",
      card_ids: nums.map((n) => state!.you.hand[n - 1]?.id).filter(Boolean),
    });
  } else if (a === "q" || a === "quit") {
    console.log(C.dim("\n  再见\n"));
    ws.close();
    Deno.exit(0);
  } else if (a === "不出" || a === "pass") {
    send({ action: "pass" });
  } else {
    errorMsg = `未知指令: ${a}`;
    render();
  }
}

console.log(C.t("\n  SchoolSha CLI"));
console.log(C.dim(`  连接 ${WS_URL}...\n`));
