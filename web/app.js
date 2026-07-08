// ============================================================
// app.js — 学校杀网页版客户端
// ============================================================

const WS_URL = `ws://${location.host}/ws`;
const HTTP_URL = `http://${location.host}`;

// ====== 状态 ======
const ST = {
  screen: "menu",
  ws: null,
  roomCode: null,
  mode: null,       // "room" | "matching"
  myIndex: -1,
  gs: null,         // ServerStateView
  selectedCards: new Set(),
  selectTarget: null,
};

// ====== 工具 ======
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
const text = (id, s) => { $(id).textContent = s; };
const html = (id, s) => { $(id).innerHTML = s; };

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.add("hidden"));
  const el = $(`screen-${name}`);
  if (el) el.classList.remove("hidden");
  ST.screen = name;
}

function log(msg) {
  const logEl = $("game-log");
  if (!logEl) return;
  const div = document.createElement("div");
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function suitSymbol(suit) {
  return { spade: "♠", heart: "♥", club: "♣", diamond: "♦" }[suit] || "?";
}

function cardName(c) {
  return c?.name || "?";
}

function hpStr(hp, max) {
  let s = "";
  for (let i = 0; i < max; i++) s += i < hp ? "♥" : "♡";
  return `${s} (${hp}/${max})`;
}

// ====== WebSocket ======
function connect(wsUrl) {
  if (ST.ws) ST.ws.close();
  ST.ws = new WebSocket(wsUrl);
  ST.selectedCards.clear();
  ST.selectTarget = null;

  ST.ws.onopen = () => {
    $("menu-status").textContent = "";
    console.log("[ws] connected");
  };

  ST.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    console.log("[ws] ←", msg.type, msg);
    handle(msg);
  };

  ST.ws.onclose = () => {
    console.log("[ws] closed");
    if (ST.screen === "game" || ST.screen === "char") {
      showScreen("menu");
      text("menu-status", "连接断开");
    }
  };

  ST.ws.onerror = () => {
    text("menu-status", "连接失败");
  };
}

function send(msg) {
  if (ST.ws?.readyState === WebSocket.OPEN) {
    ST.ws.send(JSON.stringify(msg));
  }
}

// ====== 消息处理 ======
function handle(msg) {
  switch (msg.type) {
    case "room_created":
      ST.roomCode = msg.code;
      ST.mode = "room";
      showScreen("lobby");
      text("lobby-code", msg.code);
      text("lobby-invite", msg.inviteUrl);
      text("lobby-status", "等待对手...");
      break;

    case "waiting":
      text("lobby-status", msg.message);
      break;

    case "character_select":
      ST.mode = "room";
      showScreen("char");
      renderCharSelect(msg.characters, msg.timeoutSec);
      break;

    case "game_state":
      ST.gs = msg.state;
      ST.myIndex = msg.yourIndex;
      if (ST.screen !== "game") showScreen("game");
      renderGame();
      if (ST.gs.gameOver) showGameOver();
      break;

    case "disconnected":
      show("opp-disconnected");
      log(`⚠ ${msg.message}`);
      break;

    case "reconnected":
      hide("opp-disconnected");
      log("✓ 对手已重连");
      break;

    case "queue_status":
      ST.mode = "matching";
      showScreen("lobby");
      text("lobby-code", "");
      text("lobby-invite", "");
      text("lobby-status", `匹配中... 排队位置: ${msg.position} (预计 ${msg.estimatedWait})`);
      break;

    case "match_found":
      ST.mode = "matching";
      ST.roomCode = msg.room;
      text("lobby-status", `匹配成功！对手: ${msg.opponent.displayName} (ELO ${msg.opponent.elo})`);
      // 切换到游戏房间
      connect(`${WS_URL}?room=${msg.room}`);
      break;

    case "queue_timeout":
      showScreen("menu");
      text("menu-status", "匹配超时，请重试");
      break;

    case "error":
      log(`错误: ${msg.message}`);
      if (ST.screen === "menu" || ST.screen === "lobby") {
        showScreen("menu");
        text("menu-status", msg.message);
      }
      break;
  }
}

// ====== 菜单操作 ======
async function createRoom() {
  try {
    const resp = await fetch(`${HTTP_URL}/room/create`);
    const info = await resp.json();
    ST.roomCode = info.code;
    connect(info.wsUrl);
    text("menu-status", "");
  } catch (e) {
    text("menu-status", "无法连接服务器");
  }
}

function joinRoom() {
  const code = $("join-code").value.trim().toUpperCase();
  if (!code || code.length < 4) {
    text("menu-status", "请输入房间码");
    return;
  }
  ST.roomCode = code;
  connect(`${WS_URL}?room=${code}`);
  text("menu-status", "");
}

function quickMatch() {
  connect(`${WS_URL}?mode=matching`);
  ST.mode = "matching";
  text("menu-status", "");
}

function leaveLobby() {
  if (ST.ws) ST.ws.close();
  showScreen("menu");
}

function backToMenu() {
  if (ST.ws) ST.ws.close();
  ST.ws = null;
  ST.gs = null;
  ST.roomCode = null;
  ST.myIndex = -1;
  ST.selectedCards.clear();
  hide("game-over-overlay");
  showScreen("menu");
}

// ====== 排行榜 ======
async function showLeaderboard() {
  try {
    const resp = await fetch(`${HTTP_URL}/leaderboard` +
      (ST.gs?.playerId ? `?userId=${ST.gs.playerId}` : ""));
    const data = await resp.json();
    renderLeaderboard(data);
    showScreen("leaderboard");
  } catch (e) {
    text("menu-status", "无法获取排行榜");
  }
}

function renderLeaderboard(data) {
  let h = `<div class="lb-header"><span class="lb-rank">#</span><span class="lb-name">玩家</span><span class="lb-elo">ELO</span><span class="lb-stats">胜/负</span></div>`;
  for (const p of data.top10) {
    h += `<div class="lb-row">
      <span class="lb-rank">${p.rank}</span>
      <span class="lb-name">${p.displayName || p.userId.slice(0, 8)}</span>
      <span class="lb-elo">${p.elo}</span>
      <span class="lb-stats">${p.wins}W ${p.losses}L</span>
    </div>`;
  }
  html("lb-table", h || '<p style="color:#888;padding:16px">暂无数据</p>');

  if (data.you) {
    const y = data.you;
    show("lb-you");
    html("lb-you", `<div class="lb-row">
      <span class="lb-rank">${y.rank}</span>
      <span class="lb-name">← 你</span>
      <span class="lb-elo">${y.elo}</span>
      <span class="lb-stats">${y.wins}W ${y.losses}L</span>
    </div>`);
  } else {
    hide("lb-you");
  }
}

// ====== 选角 ======
function renderCharSelect(chars, timeout) {
  let h = "";
  for (const c of chars) {
    h += `<div class="char-card" onclick="pickCharacter('${c.id}')">
      <h3>${c.name}</h3>
      <div class="hp">♥ × ${c.maxHp}</div>
      <div class="sk">${c.skills.length ? c.skills.join(" · ") : "无技能"}</div>
    </div>`;
  }
  html("char-list", h);
  text("char-timer", `${timeout}s`);
}

function pickCharacter(id) {
  document.querySelectorAll(".char-card").forEach((el) => {
    el.classList.toggle("selected", el.querySelector("h3")?.textContent ===
      [...document.querySelectorAll(".char-card")].find(e => e.onclick?.toString().includes(id))?.querySelector("h3")?.textContent);
  });
  send({ action: "pick_character", id });
  text("char-status", "已选择，等待对手...");
}

// ====== 游戏渲染 ======
function renderGame() {
  const gs = ST.gs;
  if (!gs) return;

  // 对手
  const opp = gs.opponent;
  text("opp-name", gs.opponentName || "对手");
  $("opp-hp").textContent = hpStr(opp.hp, opp.maxHp);
  text("opp-cards", `手牌: ${opp.handCount}`);
  text("opp-equip", opp.weapon ? `武器: ${cardName(opp.weapon)}` : "");
  if (opp.armor) text("opp-equip", $("opp-equip").textContent + ` | 防具: ${cardName(opp.armor)}`);

  if (gs.opponentDisconnected) show("opp-disconnected");
  else hide("opp-disconnected");

  // 自己
  const me = gs.you;
  text("my-name", gs.playerName || "你");
  $("my-hp").textContent = hpStr(me.hp, me.maxHp);
  let eq = "";
  if (me.weapon) eq += `武器: ${cardName(me.weapon)} `;
  if (me.armor) eq += `防具: ${cardName(me.armor)}`;
  text("my-equip", eq);

  // 阶段
  const phaseNames = { judge: "判定阶段", draw: "摸牌阶段", play: "出牌阶段", discard: "弃牌阶段", end: "结束阶段" };
  text("phase-label", phaseNames[gs.phase] || gs.phase);
  text("turn-timer", `${gs.turnTimeLeft}s`);
  text("deck-count", `牌堆: ${gs.deckCount}`);

  // 手牌
  renderHand(me.hand);

  // pending
  renderPending(gs);

  // 操作栏
  renderActions(gs);
}

function renderHand(hand) {
  ST.selectedCards.clear();
  let h = "";
  for (const c of hand) {
    const cls = `card suit-${c.suit} ${ST.selectedCards.has(c.id) ? "selected" : ""}`;
    const suit = suitSymbol(c.suit);
    h += `<div class="${cls}" id="card-${c.id}" onclick="toggleCard('${c.id}')">
      <span class="card-suit">${suit}</span>
      <span class="card-name">${c.name}</span>
      <span class="card-num">${c.number}</span>
    </div>`;
  }
  html("my-hand", h);
}

function renderPending(gs) {
  const p = gs.pendingResponse;
  if (!p) { hide("pending-msg"); return; }

  const names = {
    dodge: "对手使用【杀】，请出【闪】响应",
    near_death: "你处于濒死状态，请出【桃】自救",
    duel: "对手发起决斗，请出【杀】",
    barbarian: "南蛮入侵！请出【杀】",
    volley: "万箭齐发！请出【闪】",
    borrow_knife: "借刀杀人，请出武器牌",
  };
  const isMe = p.target === ST.myIndex;
  const who = isMe ? "你" : "对手";
  html("pending-msg", `<strong>${who}需要响应</strong>: ${names[p.type] || p.type}`);
  show("pending-msg");
}

function renderActions(gs) {
  let btns = "";
  const isMyTurn = gs.turnPlayer === ST.myIndex;
  const p = gs.pendingResponse;

  if (p && p.target === ST.myIndex) {
    // 我需要响应
    btns += `<button class="btn-secondary btn-sm" onclick="send({action:'pass'})">不响应</button>`;
    if (ST.selectedCards.size > 0) {
      btns += `<button class="btn-primary btn-sm" onclick="respondCard()">出牌响应</button>`;
    }
  } else if (isMyTurn && gs.phase === "play" && !p) {
    // 出牌阶段
    if (ST.selectedCards.size > 0) {
      btns += `<button class="btn-primary btn-sm" onclick="playSelected()">出牌</button>`;
    }
    if (gs.you.skills?.length) {
      for (const s of gs.you.skills) {
        btns += `<button class="btn-secondary btn-sm" onclick="send({action:'use_skill',skill_id:'${s}'})">技能: ${s}</button>`;
      }
    }
    btns += `<button class="btn-secondary btn-sm" onclick="send({action:'end_phase'})">结束出牌</button>`;
  } else if (isMyTurn && gs.phase === "discard" && !p) {
    // 弃牌阶段
    const needDiscard = gs.you.hand.length - gs.you.hp;
    if (needDiscard > 0 && ST.selectedCards.size > 0) {
      btns += `<button class="btn-danger btn-sm" onclick="doDiscard()">
        弃牌 (${ST.selectedCards.size}/${needDiscard})
      </button>`;
    }
    if (needDiscard <= 0) {
      btns += `<span style="color:#888;font-size:13px">无需弃牌</span>`;
    }
  }

  html("action-bar", btns);
}

// ====== 卡牌选择 ======
function toggleCard(id) {
  const gs = ST.gs;
  if (!gs) return;

  // 如果是弃牌阶段以外的出牌阶段且 pending 为空
  // 或者有 pendingResponse 且 target 是自己
  const p = gs.pendingResponse;

  if (ST.selectedCards.has(id)) {
    ST.selectedCards.delete(id);
  } else {
    // 出牌阶段最多选 1 张（大部分牌），弃牌阶段多选
    if (gs.phase === "discard" && gs.turnPlayer === ST.myIndex) {
      ST.selectedCards.add(id);
    } else {
      ST.selectedCards.clear();
      ST.selectedCards.add(id);
    }
  }
  renderHand(gs.you.hand);
  renderActions(gs);
}

function playSelected() {
  const ids = [...ST.selectedCards];
  if (ids.length === 0) return;
  // 目前只支持单选出牌
  send({ action: "play_card", card_id: ids[0], target: ST.myIndex === 0 ? 1 : 0 });
  ST.selectedCards.clear();
}

function respondCard() {
  const ids = [...ST.selectedCards];
  if (ids.length === 0) return;
  send({ action: "play_card", card_id: ids[0] });
  ST.selectedCards.clear();
}

function doDiscard() {
  const ids = [...ST.selectedCards];
  if (ids.length === 0) return;
  send({ action: "discard", card_ids: ids });
  ST.selectedCards.clear();
}

// ====== 游戏结束 ======
function showGameOver() {
  const gs = ST.gs;
  if (!gs?.gameOver) return;
  show("game-over-overlay");
  const won = gs.winner === ST.myIndex;
  const el = $("go-title");
  el.textContent = won ? "🎉 胜利！" : "💀 失败";
  el.className = won ? "win" : "lose";
  text("go-subtitle",
    `${gs.playerName || "你"} vs ${gs.opponentName || "对手"}\n` +
    `你: ♥${gs.you.hp}/${gs.you.maxHp}  对手: ♥${gs.opponent.hp}/${gs.opponent.maxHp}`);
}

// ====== 快捷键 ======
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && ST.screen === "menu") {
    joinRoom();
  }
});
