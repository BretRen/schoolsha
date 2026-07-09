// ============================================================
// cli.ts — 三国杀 1v1 命令行客户端
// ============================================================
// 用法: deno run --allow-net cli.ts [ws://localhost:8099]

import type { ServerStateView, Card } from "./types.ts";

const WS_URL = Deno.args[0] || "ws://localhost:8099";

// ─── ANSI 颜色 ──────────────────────────────────────────
const R = "\x1b[0m";    // 重置
const B = "\x1b[1m";    // 粗体
const D = "\x1b[2m";    // 暗色
const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const CYA = "\x1b[36m";
const WHITE = "\x1b[37m";
const BG_R = "\x1b[41m";
const BG_G = "\x1b[42m";
const _BG_B = "\x1b[44m";

// ─── 连接 ──────────────────────────────────────────────
const ws = new WebSocket(WS_URL);
let state: ServerStateView | null = null;
let myIndex = -1;
let errorMsg = "";

ws.onopen = () => render();
ws.onclose = () => { clear(); console.log("\n连接断开"); Deno.exit(0); };

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "game_state") {
    state = msg.state;
    myIndex = msg.yourIndex;
    render();
  } else if (msg.type === "error") {
    errorMsg = msg.message;
    render();
  }
};

// ─── 发送 ──────────────────────────────────────────────
function send(obj: Record<string, unknown>) {
  ws.send(JSON.stringify(obj));
}

// ─── 渲染 ──────────────────────────────────────────────
function clear() {
  console.clear();
}

function suitColor(s: string): string {
  return s === "spade" || s === "club" ? WHITE : RED;
}

function suitIcon(s: string): string {
  return ({ spade: "♠", heart: "♥", club: "♣", diamond: "♦" } as Record<string, string>)[s] || "?";
}

function cardStr(c: Card): string {
  const numMap: Record<number, string> = { 1: "A", 11: "J", 12: "Q", 13: "K" };
  const n = numMap[c.number] ?? String(c.number).padStart(2, " ");
  return `${suitColor(c.suit)}${suitIcon(c.suit)}${n}${R} ${c.name}`;
}

function phaseName(p: string): string {
  return ({ judge: "判定", draw: "摸牌", play: "出牌", discard: "弃牌", end: "结束" } as Record<string, string>)[p] || p;
}

function hpBar(hp: number, maxHp: number): string {
  let bar = "";
  for (let i = 0; i < maxHp; i++) {
    bar += i < hp ? RED + "♥" + R : D + "♡" + R;
  }
  return bar + `  ${YEL}${hp}${R}/${maxHp}`;
}

function box(lines: string[]): string {
  const w = Math.max(...lines.map(l => stripAnsi(l)));
  const top  = "┌" + "─".repeat(w + 2) + "┐";
  const mid  = lines.map(l => "│ " + l + " ".repeat(w - stripAnsi(l)) + " │").join("\n");
  const bot  = "└" + "─".repeat(w + 2) + "┘";
  return top + "\n" + mid + "\n" + bot;
}

function stripAnsi(s: string): number {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function isMyTurn(): boolean {
  if (!state) return false;
  return state.turnPlayer === myIndex && state.phase === "play";
}

function needResponse(): boolean {
  if (!state) return false;
  return state.pendingResponse?.target === myIndex;
}

function needDiscard(): boolean {
  if (!state) return false;
  if (state.phase !== "discard" || state.turnPlayer !== myIndex) return false;
  return state.you.hand.length > state.you.hp;
}

function render() {
  clear();

  if (!state) {
    console.log(box([`${YEL}⏳ 等待连接...${R}`, ``, `${D}${WS_URL}${R}`]));
    return;
  }

  // ── 标题栏 ──
  const title = `${B}三国杀${R}  ${D}1v1${R}`;
  const turnTag = state.gameOver
    ? `${BG_R} GAME OVER ${R}`
    : isMyTurn() ? `${BG_G} 你的回合 ${R}`
    : needResponse() ? `${BG_R} 需要响应 ${R}`
    : needDiscard() ? `${YEL} 需要弃牌 ${R}`
    : `${D}等待中${R}`;

  console.log(box([
    `${title}                     ${turnTag}`,
    `${D}${WS_URL}${R}  ${D}你是玩家 ${myIndex}${R}`,
  ]));

  // ── 游戏结束 ──
  if (state.gameOver) {
    const win = state.winner === myIndex;
    console.log("");
    console.log(box([
      win ? `${GRN}🎉 你赢了！${R}` : `${RED}💀 你输了${R}`,
    ]));
    return;
  }

  // ── 状态栏 ──
  const phaseInfo = `${YEL}${B}${phaseName(state.phase)}阶段${R}`;
  const deckInfo = `${D}牌堆: ${state.deckCount}${R}`;
  const atkInfo = state.phase === "play" && state.turnPlayer === myIndex
    ? (state.attackUsed ? `${D}出作业: 已用${R}` : `${GRN}出作业: 可用${R}`)
    : "";

  console.log(`  ${phaseInfo}    ${deckInfo}    ${atkInfo}`);

  // ── 对手 ──
  const opp = state.opponent;
  const oppLine = `${D}对手${R}  ${hpBar(opp.hp, opp.maxHp)}  ${D}手牌: ${opp.handCount}${R}`;
  console.log("");
  console.log(`  ${oppLine}`);

  // ── 等待响应提示 ──
  if (state.pendingResponse) {
    const pr = state.pendingResponse;
    const cardInfo = pr.card ? ` (${cardStr(pr.card)})` : "";
    if (pr.target === myIndex) {
      const hints: Record<string, string> = {
        dodge: "⚠ 对手对你出了作业！请出【赦免】响应",
        near_death: "⚠ 你濒死！请出【放假】或【辣条】",
        duel: "⚠ 拼作业！请出【作业】响应",
        barbarian: "⚠ 作业检查！请出【作业】响应",
        volley: "⚠ 最终测试！请出【赦免】响应",
        borrow_knife: "⚠ 嫁祸！请弃一张牌响应",
      };
      const hint = hints[pr.type] || `⚠ 需要响应: ${pr.type}`;
      console.log(`\n  ${RED}${hint}${R}${cardInfo}`);
    } else if (pr.source === myIndex) {
      const waitHints: Record<string, string> = {
        dodge: "⌛ 等待对手出赦免...",
        near_death: "⌛ 等待对手自救...",
        duel: "⌛ 等待对手出作业...",
        barbarian: "⌛ 等待对手出作业...",
        volley: "⌛ 等待对手出赦免...",
        borrow_knife: "⌛ 等待对手弃牌...",
      };
      const hint = waitHints[pr.type] || `⌛ 等待对手响应...`;
      console.log(`\n  ${D}${hint}${R}`);
    }
  }

  // ── 你的手牌 ──
  console.log("");
  console.log(`  ${B}你的手牌${R}  (HP: ${hpBar(state.you.hp, state.you.maxHp)})`);

  if (state.you.hand.length === 0) {
    console.log(`  ${D}(空)${R}`);
  } else {
    const cards = state.you.hand;
    // 分行显示，每行最多 5 张
    const perRow = 5;
    for (let r = 0; r < Math.ceil(cards.length / perRow); r++) {
      const row = cards.slice(r * perRow, (r + 1) * perRow);
      const line = row.map((c, i) => {
        const idx = r * perRow + i + 1;
        const num = String(idx).padStart(2);
        return `${D}[${num}]${R} ${cardStr(c)}`;
      }).join("    ");
      console.log(`  ${line}`);
    }
  }

  // ── 指令帮助 ──
  console.log("");
  if (needResponse()) {
    const pending = state.pendingResponse!;
    const helpHints: Record<string, string> = {
      dodge: `  ${YEL}出 <编号>${R}  — 出【赦免】响应`,
      near_death: `  ${YEL}出 <编号>${R}  — 出【放假】或【辣条】`,
      duel: `  ${YEL}出 <编号>${R}  — 出【作业】响应`,
      barbarian: `  ${YEL}出 <编号>${R}  — 出【作业】响应`,
      volley: `  ${YEL}出 <编号>${R}  — 出【赦免】响应`,
      borrow_knife: `  ${YEL}出 <编号>${R}  — 弃牌响应`,
    };
    const hint = helpHints[pending.type] || `  ${YEL}出 <编号>${R}  — 响应`;
    console.log(hint);
    console.log(`  ${YEL}pass${R}  — 放弃响应（承受伤害）`);
  } else if (needDiscard()) {
    const n = state.you.hand.length - state.you.hp;
    console.log(`  ${YEL}弃 <编号> [编号]...${R}  — 需要弃 ${n} 张牌`);
  } else if (isMyTurn()) {
    console.log(`  ${GRN}出 <编号>${R}  — 出牌    ${GRN}结束${R}  — 结束出牌`);
  } else {
    console.log(`  ${D}等待对手操作...${R}`);
  }

  // ── 错误提示 ──
  if (errorMsg) {
    console.log(`\n  ${RED}✗ ${errorMsg}${R}`);
    errorMsg = "";
  }

  // ── 输入提示 ──
  console.log("");
  awaitInput();
}

// ─── 输入处理 ──────────────────────────────────────────────
let _inputBuf = "";

async function awaitInput() {
  await Deno.stdout.write(new TextEncoder().encode(`  ${CYA}>${R} `));
}

async function readLoop() {
  const isWindows = Deno.build.os === "windows";
  const encoding = isWindows ? "gbk" : "utf-8";
  const decoder = new TextDecoder(encoding);
  const reader = Deno.stdin.readable.getReader();
  let leftover = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      const lines = (leftover + text).split("\n");
      leftover = lines.pop() || "";

      for (const line of lines) {
        if (!state || state.gameOver) continue;
        const cmd = line.trim();
        if (!cmd) continue;
        handleCmd(cmd);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function handleCmd(cmd: string) {
  const parts = cmd.split(/\s+/);
  const action = parts[0];

  if (action === "出" || action === "play") {
    const n = parseInt(parts[1]);
    if (isNaN(n) || !state || n < 1 || n > state.you.hand.length) {
      errorMsg = `无效编号: ${parts[1]}`;
      render();
      return;
    }
    const card = state.you.hand[n - 1];
    const target = state.pendingResponse ? undefined : 1 - myIndex;
    send({ action: "play_card", card_id: card.id, target });

  } else if (action === "pass" || action === "跳过") {
    send({ action: "pass" });

  } else if (action === "结束" || action === "end") {
    send({ action: "end_phase" });

  } else if (action === "弃" || action === "discard") {
    const nums = parts.slice(1).map(Number);
    if (nums.some(isNaN) || !state) {
      errorMsg = "格式: 弃 <编号> [编号]...";
      render();
      return;
    }
    const ids = nums.map(n => state!.you.hand[n - 1]?.id).filter(Boolean);
    if (ids.length === 0) {
      errorMsg = "无效编号";
      render();
      return;
    }
    send({ action: "discard", card_ids: ids });

  } else if (action === "q" || action === "quit") {
    console.log("\n👋 再见");
    ws.close();
    Deno.exit(0);

  } else {
    errorMsg = `未知指令: ${action}`;
    render();
  }
}

// ─── 启动 ──────────────────────────────────────────────
console.log(box([
  `${B}三国杀 CLI${R}`,
  ``,
  `${D}连接到 ${WS_URL}...${R}`,
]));

readLoop();
