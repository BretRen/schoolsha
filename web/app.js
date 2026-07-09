// ============================================================
// app.js — 学校杀网页版客户端
// ============================================================

const WS_URL = `ws://${location.host}/ws`;
const HTTP_URL = `http://${location.host}`;

// ====== 认证 (PKCE) ======
const AUTH = { enabled: false, provider: "", clientId: "", token: null };

function base64url(buf) {
  const s = String.fromCharCode(...new Uint8Array(buf));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startLogin() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64url(verifierBytes);
  sessionStorage.setItem("pkce_verifier", verifier);

  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: AUTH.clientId, redirect_uri: location.origin + "/",
    response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
    scope: "openid profile email",
  });
  location.href = `${AUTH.provider}/oauth/v2/authorize?${params}`;
}

async function handleAuthCallback() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return false;
  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) return false;
  history.replaceState(null, "", location.pathname);

  const resp = await fetch(`${AUTH.provider}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: AUTH.clientId, code,
      redirect_uri: location.origin + "/", code_verifier: verifier,
    }),
  });
  if (!resp.ok) { text("menu-status", "登录失败，请重试"); sessionStorage.removeItem("pkce_verifier"); return false; }
  const data = await resp.json();
  AUTH.token = data.access_token;
  sessionStorage.setItem("auth_token", data.access_token);
  sessionStorage.removeItem("pkce_verifier");
  text("menu-status", "已登录");
  return true;
}

async function initAuth() {
  try {
    const resp = await fetch(`${HTTP_URL}/info`);
    const info = await resp.json();
    if (info.auth?.mode === "zitadel_oidc") {
      AUTH.enabled = true; AUTH.provider = info.auth.provider; AUTH.clientId = info.auth.clientId;
    }
  } catch { /* offline */ }
  const saved = sessionStorage.getItem("auth_token");
  if (saved) AUTH.token = saved;
  if (AUTH.enabled && location.search.includes("code=")) {
    const ok = await handleAuthCallback();
    if (ok) { checkReconnect(); return; }
  }
  if (AUTH.token) checkReconnect();
}

// ====== 重连 ======
function checkReconnect() {
  const savedRoom = sessionStorage.getItem("active_room");
  if (!savedRoom) return;
  showReconnectPrompt(savedRoom, 30);
}

function showReconnectPrompt(code, seconds) {
  const overlay = document.createElement("div");
  overlay.id = "reconnect-overlay";
  overlay.innerHTML = `<div style="background:#1e1b4b;border:2px solid #7c3aed;border-radius:16px;padding:40px;text-align:center;max-width:360px;display:flex;flex-direction:column;gap:12px">
    <h2>🔌 断线重连</h2>
    <p>活跃房间 <strong style="color:#c4b5fd;font-family:monospace;font-size:20px">${code}</strong></p>
    <p id="reconnect-countdown" style="color:#888">${seconds} 秒内可重连</p>
    <div style="margin-top:20px;display:flex;gap:12px;justify-content:center">
      <button class="btn btn-primary" id="btn-reconnect">重新连接</button>
      <button class="btn btn-outline" id="btn-ignore">忽略</button>
    </div></div>`;
  overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:9999";
  document.body.appendChild(overlay);

  let remaining = seconds;
  const countdownEl = overlay.querySelector("#reconnect-countdown");
  const timer = setInterval(() => {
    remaining--;
    if (remaining <= 0) { clearInterval(timer); close(); }
    if (countdownEl) countdownEl.textContent = `${remaining} 秒内可重连`;
  }, 1000);

  overlay.querySelector("#btn-reconnect").onclick = () => { clearInterval(timer); close(); ST.roomCode = code; connect(buildWsUrl(`?room=${code}`)); text("menu-status", ""); };
  overlay.querySelector("#btn-ignore").onclick = () => { clearInterval(timer); close(); };
  function close() { sessionStorage.removeItem("active_room"); if (overlay.parentNode) overlay.remove(); }
}

// ====== 全局状态 ======
const ST = {
  screen: "menu", ws: null, roomCode: null, mode: null,
  myIndex: -1, gs: null, selectedCards: new Set(), selectTarget: null,
  timerInterval: null, serverTimer: 60,  // 倒计时
  lastHandSig: "",  // 手牌签名，用于判断是否变化
};

// ====== 工具 ======
const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove("hidden");
const hide = id => $(id)?.classList.add("hidden");
const text = (id, s) => { const el = $(id); if (el) el.textContent = s; };
const html = (id, s) => { const el = $(id); if (el) el.innerHTML = s; };

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(el => el.classList.add("hidden"));
  const el = $(`screen-${name}`);
  if (el) el.classList.remove("hidden");
  ST.screen = name;
}

function log(msg) {
  const el = $("game-log");
  if (!el) return;
  const d = document.createElement("div");
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function suitSymbol(s) { return { spade: "♠", heart: "♥", club: "♣", diamond: "♦" }[s] || "?"; }
function cardName(c) { return c?.name || "?"; }
function hpStr(hp, max) { let s = ""; for (let i = 0; i < max; i++) s += i < hp ? "♥" : "♡"; return `${s} (${hp}/${max})`; }

// ====== 卡牌说明 ======
const CARD_DESC = {
  "杀": "对对手造成 1 点伤害（每回合限 1 次）",
  "闪": "响应【杀】或【万箭齐发】",
  "桃": "回复 1 点体力，或濒死时自救",
  "决斗": "双方轮流出【杀】，先不出者受 1 点伤害",
  "南蛮入侵": "对手需出【杀】，否则受 1 点伤害",
  "万箭齐发": "对手需出【闪】，否则受 1 点伤害",
  "借刀杀人": "对手需弃一张武器牌",
  "酒": "本回合下一张【杀】伤害 +1；或濒死时自救",
  "无懈可击": "抵消一张锦囊牌的效果",
  "诸葛连弩": "武器：出牌阶段可出任意张【杀】",
  "青釭剑": "武器：【杀】无视对手防具",
  "丈八蛇矛": "武器：可将两张手牌当【杀】使用",
  "贯石斧": "武器：【杀】被【闪】抵消后可弃两张牌强制命中",
  "麒麟弓": "武器：【杀】命中后可弃对手一张坐骑牌",
  "八卦阵": "防具：需要出【闪】时可判定，红色视为出【闪】",
  "仁王盾": "防具：黑色【杀】对你无效",
  "爪黄飞电": "+1 马：对手计算距离时 +1",
  "的卢": "+1 马：对手计算距离时 +1",
  "绝影": "+1 马：对手计算距离时 +1",
  "赤兔": "-1 马：计算距离时 -1",
  "大宛": "-1 马：计算距离时 -1",
  "紫骍": "-1 马：计算距离时 -1",
};

function getCardDesc(c) {
  return CARD_DESC[c.name] || `${c.name}（${suitSymbol(c.suit)}${c.number}）`;
}

// ====== 响应类型 → 需要的牌 ======
const RESPONSE_CARDS = {
  dodge: ["闪"],
  near_death: ["桃", "酒"],
  duel: ["杀"],
  barbarian: ["杀"],
  volley: ["闪"],
  borrow_knife: [], // weapon cards — need to check card name includes weapon keywords
};

// ====== WebSocket ======
function buildWsUrl(path) {
  let url = `${WS_URL}${path}`;
  if (AUTH.token) url += (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(AUTH.token)}`;
  return url;
}

function connect(wsUrl) {
  if (ST.ws) ST.ws.close();
  ST.ws = new WebSocket(wsUrl);
  ST.selectedCards.clear();
  ST.selectTarget = null;
  stopTimer();

  ST.ws.onopen = () => { $("menu-status").textContent = ""; console.log("[ws] connected"); };
  ST.ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    console.log("[ws] ←", msg.type, msg);
    handle(msg);
  };
  ST.ws.onclose = () => {
    console.log("[ws] closed");
    stopTimer();
    if (ST.screen === "game" || ST.screen === "char") {
      if (ST.roomCode && ST.gs && !ST.gs.gameOver) sessionStorage.setItem("active_room", ST.roomCode);
      showScreen("menu");
      text("menu-status", "连接断开");
      if (ST.roomCode && ST.gs && !ST.gs.gameOver) showReconnectPrompt(ST.roomCode, 30);
    }
  };
  ST.ws.onerror = () => {
    if (AUTH.enabled && AUTH.token) { text("menu-status", "令牌失效，请重新登录"); AUTH.token = null; sessionStorage.removeItem("auth_token"); startLogin(); }
    else if (AUTH.enabled && !AUTH.token) { text("menu-status", "请先登录"); startLogin(); }
    else text("menu-status", "连接失败，请检查网络");
  };
}

function send(msg) {
  if (ST.ws?.readyState === WebSocket.OPEN) ST.ws.send(JSON.stringify(msg));
}

// ====== 倒计时 ======
function startTimer(seconds) {
  stopTimer();
  ST.serverTimer = seconds;
  const el = $("turn-timer");
  if (!el) return;
  el.textContent = `${seconds}s`;
  ST.timerInterval = setInterval(() => {
    ST.serverTimer--;
    if (ST.serverTimer < 0) ST.serverTimer = 0;
    el.textContent = `${ST.serverTimer}s`;
    if (ST.serverTimer <= 0) clearInterval(ST.timerInterval);
  }, 1000);
}
function stopTimer() {
  if (ST.timerInterval) { clearInterval(ST.timerInterval); ST.timerInterval = null; }
}

// ====== 消息处理 ======
function handle(msg) {
  switch (msg.type) {
    case "room_created":
      ST.roomCode = msg.code; ST.mode = "room";
      sessionStorage.setItem("active_room", msg.code);
      showScreen("lobby"); text("lobby-code", msg.code);
      text("lobby-invite", msg.inviteUrl); text("lobby-status", "等待对手...");
      break;
    case "waiting": text("lobby-status", msg.message); break;
    case "character_select":
      ST.mode = "room"; showScreen("char"); renderCharSelect(msg.characters, msg.timeoutSec); break;
    case "game_state":
      ST.gs = msg.state; ST.myIndex = msg.yourIndex;
      if (ST.screen !== "game") showScreen("game");
      renderGame();
      if (ST.gs.gameOver) { sessionStorage.removeItem("active_room"); stopTimer(); showGameOver(); }
      break;
    case "disconnected": show("opp-disconnected"); log(`⚠ ${msg.message}`); break;
    case "reconnected": hide("opp-disconnected"); log("✓ 对手已重连"); break;
    case "queue_status":
      ST.mode = "matching"; showScreen("lobby");
      text("lobby-code", ""); text("lobby-invite", "");
      text("lobby-status", `匹配中... 排队位置: ${msg.position} (预计 ${msg.estimatedWait})`); break;
    case "match_found":
      ST.mode = "matching"; ST.roomCode = msg.room;
      sessionStorage.setItem("active_room", msg.room);
      text("lobby-status", `匹配成功！对手: ${msg.opponent.displayName} (ELO ${msg.opponent.elo})`);
      connect(buildWsUrl(`?room=${msg.room}`)); break;
    case "queue_timeout": showScreen("menu"); text("menu-status", "匹配超时，请重试"); break;
    case "error":
      log(`错误: ${msg.message}`);
      if (ST.screen === "menu" || ST.screen === "lobby") { showScreen("menu"); text("menu-status", msg.message); }
      break;
  }
}

// ====== 菜单操作 ======
function ensureAuth() {
  if (AUTH.enabled && !AUTH.token) { text("menu-status", "请先登录"); startLogin(); return false; }
  return true;
}
async function createRoom() {
  if (!ensureAuth()) return;
  try {
    const resp = await fetch(`${HTTP_URL}/room/create`);
    const info = await resp.json();
    ST.roomCode = info.code; connect(buildWsUrl(`?room=${info.code}`)); text("menu-status", "");
  } catch (e) { text("menu-status", "无法连接服务器"); }
}
function joinRoom() {
  if (!ensureAuth()) return;
  const code = $("join-code").value.trim().toUpperCase();
  if (!code || code.length < 4) { text("menu-status", "请输入房间码"); return; }
  ST.roomCode = code; connect(buildWsUrl(`?room=${code}`)); text("menu-status", "");
}
function quickMatch() {
  if (!ensureAuth()) return;
  connect(buildWsUrl("?mode=matching")); ST.mode = "matching"; text("menu-status", "");
}
function leaveLobby() { if (ST.ws) ST.ws.close(); showScreen("menu"); }
function backToMenu() {
  stopTimer(); if (ST.ws) ST.ws.close(); ST.ws = null;
  ST.gs = null; ST.roomCode = null; ST.myIndex = -1; ST.selectedCards.clear();
  hide("game-over-overlay"); showScreen("menu");
}

// ====== 排行榜 ======
async function showLeaderboard() {
  try {
    const resp = await fetch(`${HTTP_URL}/leaderboard` + (ST.gs?.playerId ? `?userId=${ST.gs.playerId}` : ""));
    renderLeaderboard(await resp.json()); showScreen("leaderboard");
  } catch (e) { text("menu-status", "无法获取排行榜"); }
}
function renderLeaderboard(data) {
  let h = `<div class="lb-header"><span class="lb-rank">#</span><span class="lb-name">玩家</span><span class="lb-elo">ELO</span><span class="lb-stats">胜/负</span></div>`;
  for (const p of data.top10) h += `<div class="lb-row"><span class="lb-rank">${p.rank}</span><span class="lb-name">${p.displayName || p.userId.slice(0,8)}</span><span class="lb-elo">${p.elo}</span><span class="lb-stats">${p.wins}W ${p.losses}L</span></div>`;
  html("lb-table", h || '<p style="color:#888;padding:16px">暂无数据</p>');
  if (data.you) { show("lb-you"); html("lb-you", `<div class="lb-row"><span class="lb-rank">${data.you.rank}</span><span class="lb-name">← 你</span><span class="lb-elo">${data.you.elo}</span><span class="lb-stats">${data.you.wins}W ${data.you.losses}L</span></div>`); }
  else hide("lb-you");
}

// ====== 选角 ======
function renderCharSelect(chars, timeout) {
  let h = "";
  for (const c of chars) h += `<div class="chcard" onclick="pickCharacter('${c.id}')"><h3>${c.name}</h3><div class="hp">♥ × ${c.maxHp}</div><div class="sk">${c.skills.length ? c.skills.join(" · ") : "无技能"}</div></div>`;
  html("char-list", h); text("char-timer", `${timeout}s`);
}
function pickCharacter(id) {
  document.querySelectorAll(".chcard").forEach(el => el.classList.remove("selected"));
  const card = [...document.querySelectorAll(".chcard")].find(e => e.querySelector("h3")?.textContent && e.innerHTML.includes(id));
  if (card) card.classList.add("selected");
  send({ action: "pick_character", id }); text("char-status", "已选择，等待对手...");
}

// ====== 游戏渲染 ======
function handSig(hand) { return hand.map(c => c.id).join(","); }

function renderGame() {
  const gs = ST.gs;
  if (!gs) return;

  // 对手
  const opp = gs.opponent;
  text("opp-name", gs.opponentName || "对手");
  $("opp-hp").textContent = hpStr(opp.hp, opp.maxHp);
  text("opp-cards", `手牌: ${opp.handCount}`);
  let oppEq = "";
  if (opp.weapon) oppEq += `武器: ${cardName(opp.weapon)} `;
  if (opp.armor) oppEq += `防具: ${cardName(opp.armor)}`;
  text("opp-equip", oppEq);
  if (gs.opponentDisconnected) show("opp-disconnected"); else hide("opp-disconnected");

  // 自己
  const me = gs.you;
  text("my-name", gs.playerName || "你");
  $("my-hp").textContent = hpStr(me.hp, me.maxHp);
  let myEq = "";
  if (me.weapon) myEq += `武器: ${cardName(me.weapon)} `;
  if (me.armor) myEq += `防具: ${cardName(me.armor)}`;
  text("my-equip", myEq);

  // 阶段
  const phaseNames = { judge: "判定阶段", draw: "摸牌阶段", play: "出牌阶段", discard: "弃牌阶段", end: "结束阶段" };
  text("phase-label", phaseNames[gs.phase] || gs.phase);
  text("deck-count", `牌堆: ${gs.deckCount}`);

  // 倒计时：服务端推送时同步
  startTimer(gs.turnTimeLeft);

  // 手牌 — 只在手牌变化时清空选中
  const sig = handSig(me.hand);
  const handChanged = sig !== ST.lastHandSig;
  if (handChanged) { ST.lastHandSig = sig; ST.selectedCards.clear(); }
  renderHand(me.hand);

  // pending
  renderPending(gs);

  // 操作栏
  renderActions(gs);

  // 卡牌说明（选中时）
  renderCardInfo();
}

function renderHand(hand) {
  const gs = ST.gs;
  const pending = gs?.pendingResponse;
  const isMyTurn = gs?.turnPlayer === ST.myIndex;
  const isDiscard = gs?.phase === "discard";

  // 确定哪些牌可选
  let selectable = null; // null = 全部可选
  if (pending && pending.target === ST.myIndex) {
    selectable = RESPONSE_CARDS[pending.type] || [];
  }

  let h = "";
  for (const c of hand) {
    const selected = ST.selectedCards.has(c.id);
    let disabled = false;
    if (selectable && !isDiscard) {
      disabled = !selectable.includes(c.name);
      // 借刀杀人特殊处理：武器牌
      if (pending?.type === "borrow_knife" && (c.name.includes("剑") || c.name.includes("刀") || c.name.includes("矛") || c.name.includes("斧") || c.name.includes("弓") || c.name.includes("弩") || c.name.includes("戟"))) disabled = false;
    }
    const cls = `gcard ${c.suit} ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`;
    h += `<div class="${cls}" onclick="toggleCard('${c.id}')">
      <span class="gsuit">${suitSymbol(c.suit)}</span>
      <span class="gname">${c.name}</span>
      <span class="gnum">${c.number}</span>
    </div>`;
  }
  html("my-hand", h);
}

function renderCardInfo() {
  const el = $("card-info");
  if (!el) return;
  if (ST.selectedCards.size === 0) { el.textContent = ""; return; }
  const id = [...ST.selectedCards][0];
  const hand = ST.gs?.you?.hand || [];
  const card = hand.find(c => c.id === id);
  if (card) el.textContent = getCardDesc(card);
}

const RESPONSE_NAMES = {
  dodge: "对手使用【杀】，请出【闪】响应",
  near_death: "你处于濒死状态，请出【桃】自救",
  duel: "对手发起决斗，请出【杀】",
  barbarian: "南蛮入侵！请出【杀】",
  volley: "万箭齐发！请出【闪】",
  borrow_knife: "借刀杀人，请出武器牌",
};

function renderPending(gs) {
  const p = gs.pendingResponse;
  if (!p) { hide("pending-msg"); return; }
  const isMe = p.target === ST.myIndex;
  const who = isMe ? "你" : "对手";
  html("pending-msg", `<strong>${who}需要响应</strong>: ${RESPONSE_NAMES[p.type] || p.type}`);
  show("pending-msg");
}

function renderActions(gs) {
  let btns = "";
  const isMyTurn = gs.turnPlayer === ST.myIndex;
  const p = gs.pendingResponse;

  if (p && p.target === ST.myIndex) {
    btns += `<button class="btn btn-outline btn-sm" onclick="send({action:'pass'})">不响应</button>`;
    if (ST.selectedCards.size > 0) btns += `<button class="btn btn-primary btn-sm" onclick="respondCard()">出牌响应</button>`;
  } else if (isMyTurn && gs.phase === "play" && !p) {
    if (ST.selectedCards.size > 0) btns += `<button class="btn btn-primary btn-sm" onclick="playSelected()">出牌</button>`;
    if (gs.you.skills?.length) {
      for (const s of gs.you.skills) btns += `<button class="btn btn-outline btn-sm" onclick="send({action:'use_skill',skill_id:'${s}'})">技能: ${s}</button>`;
    }
    btns += `<button class="btn btn-outline btn-sm" onclick="send({action:'end_phase'})">结束出牌</button>`;
  } else if (isMyTurn && gs.phase === "discard" && !p) {
    const needDiscard = gs.you.hand.length - gs.you.hp;
    if (needDiscard > 0 && ST.selectedCards.size > 0) btns += `<button class="btn btn-error btn-sm" onclick="doDiscard()">弃牌 (${ST.selectedCards.size}/${needDiscard})</button>`;
    if (needDiscard <= 0) btns += `<span style="color:#888;font-size:13px">无需弃牌</span>`;
  }
  html("action-bar", btns);
}

// ====== 卡牌选择 ======
function toggleCard(id) {
  const gs = ST.gs;
  if (!gs) return;
  const p = gs.pendingResponse;
  const isDiscard = gs.phase === "discard" && gs.turnPlayer === ST.myIndex;

  if (ST.selectedCards.has(id)) {
    ST.selectedCards.delete(id);
  } else {
    if (isDiscard) ST.selectedCards.add(id);
    else { ST.selectedCards.clear(); ST.selectedCards.add(id); }
  }
  renderHand(gs.you.hand);
  renderActions(gs);
  renderCardInfo();
}

function playSelected() {
  const ids = [...ST.selectedCards];
  if (ids.length === 0) return;
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
  text("go-subtitle", `${gs.playerName || "你"} vs ${gs.opponentName || "对手"}\n你: ♥${gs.you.hp}/${gs.you.maxHp}  对手: ♥${gs.opponent.hp}/${gs.opponent.maxHp}`);
}

// ====== 初始化 ======
(async () => {
  await initAuth();
  if (AUTH.enabled) {
    show("auth-section");
    if (AUTH.token) {
      text("auth-user", "已登录");
      $("auth-btn").textContent = "退出";
      $("auth-btn").onclick = () => {
        AUTH.token = null; sessionStorage.removeItem("auth_token"); sessionStorage.removeItem("active_room");
        text("auth-user", "未登录"); $("auth-btn").textContent = "登录"; $("auth-btn").onclick = startLogin;
        if (ST.ws) { ST.ws.close(); backToMenu(); }
      };
    }
  }
})();
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && ST.screen === "menu") joinRoom(); });
