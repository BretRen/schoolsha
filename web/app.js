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
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: AUTH.clientId, code, redirect_uri: location.origin + "/", code_verifier: verifier }),
  });
  if (!resp.ok) { text("menu-status", "登录失败"); sessionStorage.removeItem("pkce_verifier"); return false; }
  const data = await resp.json();
  AUTH.token = data.access_token;
  sessionStorage.setItem("auth_token", data.access_token);
  sessionStorage.removeItem("pkce_verifier");
  text("menu-status", "已登录");
  return true;
}

async function initAuth() {
  try {
    const r = await fetch(`${HTTP_URL}/info`); const info = await r.json();
    if (info.auth?.mode === "zitadel_oidc") { AUTH.enabled = true; AUTH.provider = info.auth.provider; AUTH.clientId = info.auth.clientId; }
  } catch {}
  const saved = sessionStorage.getItem("auth_token"); if (saved) AUTH.token = saved;
  if (AUTH.enabled && location.search.includes("code=")) { const ok = await handleAuthCallback(); if (ok) { checkReconnect(); return; } }
  if (AUTH.token) checkReconnect();
}

// ====== 重连 ======
function addActiveRoom(code) {
  const saved = sessionStorage.getItem("active_room") || "";
  const rooms = saved.split(",").filter(Boolean);
  if (!rooms.includes(code)) rooms.push(code);
  sessionStorage.setItem("active_room", rooms.join(","));
}
function checkReconnect() {
  const saved = sessionStorage.getItem("active_room");
  if (!saved) return;
  const rooms = saved.split(",").filter(Boolean);
  if (rooms.length === 0) return;
  const code = rooms[rooms.length - 1]; // 取最后一个（最新）的房间
  createOverlay("🔌 断线重连", `活跃房间 <b style="color:#c4b5fd">${code}</b>`, 30, (t) => `${t} 秒内可重连`, () => {
    ST.roomCode = code; connect(buildWsUrl(`?room=${code}`)); text("menu-status", "");
  });
}
function createOverlay(title, body, seconds, countdownFn, onAction) {
  const el = document.createElement("div");
  el.id = "block-overlay";
  el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999";
  let remaining = seconds;
  const update = () => { el.querySelector("#bl-countdown").textContent = countdownFn(remaining); };
  el.innerHTML = `<div style="background:#1a1a1a;border:2px solid #7c3aed;border-radius:16px;padding:40px;text-align:center;max-width:360px;display:flex;flex-direction:column;gap:12px">
    <h2 style="font-size:28px">${title}</h2><div>${body}</div>
    <p id="bl-countdown" style="color:#f59e0b;font-family:monospace;font-size:16px">${countdownFn(seconds)}</p>
    <div style="display:flex;gap:12px;justify-content:center;margin-top:8px">
      <button class="btn btn-primary btn-sm" id="bl-action">${onAction ? '重新连接' : ''}</button>
      <button class="btn btn-outline btn-sm" id="bl-ignore">忽略</button>
    </div></div>`;
  document.body.appendChild(el);
  const timer = setInterval(() => { remaining--; if (remaining <= 0) { clearInterval(timer); removeOverlay(); } update(); }, 1000);
  if (onAction) el.querySelector("#bl-action").onclick = () => { clearInterval(timer); removeOverlay(); onAction(); };
  else el.querySelector("#bl-action").style.display = "none";
  el.querySelector("#bl-ignore").onclick = () => { clearInterval(timer); removeOverlay(); };
}
function removeOverlay() {
  const el = document.getElementById("block-overlay");
  if (el) el.remove();
  // 不删除 active_room — 让重连提示在刷新后仍然存在
  // active_room 只在游戏正常结束时清除
}

// ====== 状态 ======
const ST = {
  screen: "menu", ws: null, roomCode: null, mode: null, myIndex: -1, gs: null,
  selectedCards: new Set(), selectTarget: null,
  timerInterval: null, serverTimer: 60, lastHandSig: "", blocked: false,
  eloResult: null,
};

// ====== 工具 ======
const $ = id => document.getElementById(id);
const show = id => { const e = $(id); if (e) e.classList.remove("hidden"); };
const hide = id => { const e = $(id); if (e) e.classList.add("hidden"); };
const text = (id, s) => { const e = $(id); if (e) e.textContent = s; };
const html = (id, s) => { const e = $(id); if (e) e.innerHTML = s; };

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(el => el.classList.add("hidden"));
  const el = $(`screen-${name}`); if (el) el.classList.remove("hidden");
  ST.screen = name;
}
function log(msg) {
  const el = $("game-log"); if (!el) return;
  const d = document.createElement("div"); d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
}
function suitSymbol(s) { return { spade: "♠", heart: "♥", club: "♣", diamond: "♦" }[s] || "?"; }
function cardName(c) { return c?.name || "?"; }
function hpStr(hp, max) { let s = ""; for (let i = 0; i < max; i++) s += i < hp ? "♥" : "♡"; return `${s} (${hp}/${max})`; }

// ====== 卡牌说明 ======
const CARD_DESC = {
  "杀": "对对手造成 1 点伤害（每回合限 1 次）", "闪": "响应【杀】或【万箭齐发】",
  "桃": "回复 1 点体力，或濒死时自救", "决斗": "双方轮流出【杀】，先不出者受 1 点伤害",
  "南蛮入侵": "对手需出【杀】，否则受 1 点伤害", "万箭齐发": "对手需出【闪】，否则受 1 点伤害",
  "借刀杀人": "对手需弃一张武器牌", "酒": "本回合下一张【杀】伤害 +1；或濒死时自救",
  "诸葛连弩": "武器：可出任意张【杀】", "青釭剑": "武器：【杀】无视防具",
  "丈八蛇矛": "武器：可将两张手牌当【杀】", "贯石斧": "武器：【杀】被闪后可弃牌强制命中",
  "麒麟弓": "武器：【杀】命中后可弃对手坐骑", "八卦阵": "防具：需出【闪】时可判定",
  "仁王盾": "防具：黑色【杀】无效",
};
function getCardDesc(c) { return CARD_DESC[c.name] || `${c.name}（${suitSymbol(c.suit)}${c.number}）`; }

// 响应 → 允许的牌名
const RESPONSE_CARDS = {
  dodge: ["闪"], near_death: ["桃", "酒"], duel: ["杀"], barbarian: ["杀"], volley: ["闪"], borrow_knife: [],
};
function isWeapon(name) { return ["剑","刀","矛","斧","弓","弩","戟","铩","槊"].some(k => name.includes(k)); }

// ====== WebSocket ======
function buildWsUrl(path) {
  let url = `${WS_URL}${path}`;
  if (AUTH.token) url += (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(AUTH.token)}`;
  return url;
}
function connect(wsUrl) {
  if (ST.ws) ST.ws.close();
  ST.ws = new WebSocket(wsUrl);
  ST.selectedCards.clear(); ST.selectTarget = null; stopTimer(); ST.blocked = false; removeOverlay();
  ST.ws.onopen = () => { $("menu-status").textContent = ""; };
  ST.ws.onmessage = ev => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } handle(msg); };
  ST.ws.onclose = () => {
    stopTimer();
    if (ST.screen === "game" || ST.screen === "char") {
      if (ST.roomCode && ST.gs && !ST.gs.gameOver) addActiveRoom(ST.roomCode);
      showScreen("menu"); text("menu-status", "连接断开");
      if (ST.roomCode && ST.gs && !ST.gs.gameOver) checkReconnect();
    }
  };
  ST.ws.onerror = () => {
    if (AUTH.enabled && AUTH.token) { text("menu-status", "令牌失效"); AUTH.token = null; sessionStorage.removeItem("auth_token"); startLogin(); }
    else if (AUTH.enabled && !AUTH.token) { text("menu-status", "请先登录"); startLogin(); }
    else text("menu-status", "连接失败");
  };
}
function send(msg) { if (ST.ws?.readyState === WebSocket.OPEN) ST.ws.send(JSON.stringify(msg)); }

// ====== 倒计时 ======
function startTimer(seconds) {
  stopTimer(); ST.serverTimer = seconds;
  const el = $("turn-timer"); if (!el) return;
  el.textContent = `${seconds}s`;
  ST.timerInterval = setInterval(() => { ST.serverTimer--; if (ST.serverTimer < 0) ST.serverTimer = 0; el.textContent = `${ST.serverTimer}s`; }, 1000);
}
function stopTimer() { if (ST.timerInterval) { clearInterval(ST.timerInterval); ST.timerInterval = null; } }

// ====== 消息处理 ======
function handle(msg) {
  switch (msg.type) {
    case "room_created": ST.roomCode = msg.code; ST.mode = "room"; addActiveRoom(msg.code);
      showScreen("lobby"); text("lobby-code", msg.code); text("lobby-invite", msg.inviteUrl); break;
    case "waiting": text("lobby-status", msg.message); break;
    case "character_select":
      ST.mode = "room"; showScreen("char");
      renderCharSelect(msg.characters, msg.timeoutSec);
      // 显示对手信息和 ELO 预测
      if (msg.opponent) {
        const op = msg.opponent;
        const p = msg.elo?.prediction;
        const eloLine = p ? ` (ELO ${msg.elo.my} → 胜+${p.win} / 负${p.lose})` : '';
        text("char-status", `对手: ${op.displayName} (ELO ${op.elo})${eloLine}`);
      }
      break;
    case "game_state":
      ST.gs = msg.state; ST.myIndex = msg.yourIndex;
      if (ST.screen !== "game") showScreen("game");
      renderGame();
      if (ST.gs.gameOver) {
        // 保存 ELO 结果用于显示
        if (msg.eloResult) ST.eloResult = msg.eloResult;
        sessionStorage.removeItem("active_room"); stopTimer(); showGameOver();
      }
      break;
    case "disconnected":
      show("opp-disconnected");
      blockGame(msg.message, msg.attemptsLeft);
      log(`⚠ ${msg.message}`);
      break;
    case "reconnected":
      hide("opp-disconnected"); removeOverlay(); ST.blocked = false;
      log("✓ 对手已重连");
      break;
    case "queue_status": ST.mode = "matching"; showScreen("lobby"); text("lobby-code", ""); text("lobby-invite", "");
      text("lobby-status", `匹配中... 排队: ${msg.position} (预计 ${msg.estimatedWait})`); break;
    case "match_found": ST.mode = "matching"; ST.roomCode = msg.room; addActiveRoom(msg.room);
      text("lobby-status", `匹配成功！${msg.opponent.displayName} (ELO ${msg.opponent.elo})`); connect(buildWsUrl(`?room=${msg.room}`)); break;
    case "queue_timeout": showScreen("menu"); text("menu-status", "匹配超时"); break;
    case "error": log(`错误: ${msg.message}`);
      if (ST.screen === "menu" || ST.screen === "lobby") { showScreen("menu"); text("menu-status", msg.message); } break;
  }
}

function blockGame(message, attempts) {
  ST.blocked = true;
  createOverlay("⚠ 对手已断线", message, 30, t => `${t} 秒后自动判胜（剩余重连: ${attempts} 次）`, null);
}

// ====== 菜单操作 ======
function ensureAuth() { if (AUTH.enabled && !AUTH.token) { text("menu-status", "请先登录"); startLogin(); return false; } return true; }
async function createRoom() { if (!ensureAuth()) return; try { const r = await fetch(`${HTTP_URL}/room/create`); const info = await r.json(); ST.roomCode = info.code; connect(buildWsUrl(`?room=${info.code}`)); } catch { text("menu-status", "无法连接服务器"); } }
function joinRoom() { if (!ensureAuth()) return; const code = $("join-code").value.trim().toUpperCase(); if (!code) return; ST.roomCode = code; connect(buildWsUrl(`?room=${code}`)); }
function quickMatch() { if (!ensureAuth()) return; connect(buildWsUrl("?mode=matching")); ST.mode = "matching"; }
function leaveLobby() { if (ST.ws) ST.ws.close(); showScreen("menu"); }
function backToMenu() { stopTimer(); if (ST.ws) ST.ws.close(); ST.ws = null; ST.gs = null; ST.roomCode = null; ST.myIndex = -1; ST.selectedCards.clear(); ST.blocked = false; removeOverlay(); hide("game-over-overlay"); showScreen("menu"); }
async function showLeaderboard() { try { const r = await fetch(`${HTTP_URL}/leaderboard` + (ST.gs?.playerId ? `?userId=${ST.gs.playerId}` : "")); renderLeaderboard(await r.json()); showScreen("leaderboard"); } catch { text("menu-status", "无法获取排行榜"); } }
function renderLeaderboard(data) {
  let h = `<div class="lb-header"><span class="lb-rank">#</span><span class="lb-name">玩家</span><span class="lb-elo">ELO</span><span class="lb-stats">胜/负</span></div>`;
  for (const p of data.top10) h += `<div class="lb-row"><span class="lb-rank">${p.rank}</span><span class="lb-name">${p.displayName || p.userId.slice(0,8)}</span><span class="lb-elo">${p.elo}</span><span class="lb-stats">${p.wins}W ${p.losses}L</span></div>`;
  html("lb-table", h || '<p style="color:#888;padding:16px">暂无数据</p>');
  if (data.you) { show("lb-you"); html("lb-you", `<div class="lb-row"><span class="lb-rank">${data.you.rank}</span><span class="lb-name">← 你</span><span class="lb-elo">${data.you.elo}</span><span class="lb-stats">${data.you.wins}W ${data.you.losses}L</span></div>`); } else hide("lb-you");
}

// ====== 选角 ======
function renderCharSelect(chars, timeout) {
  let h = ""; for (const c of chars) h += `<div class="chcard" onclick="pickCharacter('${c.id}')"><h3>${c.name}</h3><div class="hp">♥ × ${c.maxHp}</div><div class="sk">${c.skills.length ? c.skills.join(" · ") : "无技能"}</div></div>`;
  html("char-list", h); text("char-timer", `${timeout}s`);
}
function pickCharacter(id) {
  document.querySelectorAll(".chcard").forEach(el => el.classList.remove("selected"));
  const card = [...document.querySelectorAll(".chcard")].find(e => e.innerHTML.includes(id));
  if (card) card.classList.add("selected");
  send({ action: "pick_character", id }); text("char-status", "已选择");
}

// ====== 游戏渲染 ======
function handSig(hand) { return hand.map(c => c.id).join(","); }

function renderGame() {
  const gs = ST.gs; if (!gs) return;
  const opp = gs.opponent;
  text("opp-name", gs.opponentName || "对手"); $("opp-hp").textContent = hpStr(opp.hp, opp.maxHp);
  text("opp-cards", `手牌: ${opp.handCount}`);
  let oe = ""; if (opp.weapon) oe += `武器: ${cardName(opp.weapon)} `; if (opp.armor) oe += `防具: ${cardName(opp.armor)}`; text("opp-equip", oe);
  if (gs.opponentDisconnected) show("opp-disconnected"); else hide("opp-disconnected");

  const me = gs.you;
  text("my-name", gs.playerName || "你"); $("my-hp").textContent = hpStr(me.hp, me.maxHp);
  let meq = ""; if (me.weapon) meq += `武器: ${cardName(me.weapon)} `; if (me.armor) meq += `防具: ${cardName(me.armor)}`; text("my-equip", meq);

  const phaseNames = { judge: "判定", draw: "摸牌", play: "出牌", discard: "弃牌", end: "结束" };
  text("phase-label", phaseNames[gs.phase] || gs.phase);
  text("deck-count", `牌堆: ${gs.deckCount}`);

  startTimer(gs.turnTimeLeft);

  const sig = handSig(me.hand);
  if (sig !== ST.lastHandSig) { ST.lastHandSig = sig; ST.selectedCards.clear(); }
  renderHand(me.hand);
  renderPending(gs);
  renderActions(gs);
  renderCardInfo();
}

function renderHand(hand) {
  const gs = ST.gs; const pending = gs?.pendingResponse;
  const isMyResponse = pending && pending.target === ST.myIndex;
  const isDiscard = gs?.phase === "discard" && gs?.turnPlayer === ST.myIndex;

  let selectable = null;
  if (isMyResponse) selectable = RESPONSE_CARDS[pending.type] || [];

  let h = "";
  for (const c of hand) {
    const sel = ST.selectedCards.has(c.id);
    let disabled = false, reason = "";
    if (selectable && !isDiscard) {
      const allowed = selectable.includes(c.name) || (pending?.type === "borrow_knife" && isWeapon(c.name));
      if (!allowed) { disabled = true; reason = `需要${selectable.join("或")}`; }
    }
    const cls = `gcard ${c.suit} ${sel ? "selected" : ""} ${disabled ? "disabled" : ""}`;
    h += `<div class="${cls}" onclick="${disabled ? '' : `toggleCard('${c.id}')`}" ${reason ? `title="${reason}"` : ''}>
      <span class="gsuit">${suitSymbol(c.suit)}</span><span class="gname">${c.name}</span><span class="gnum">${c.number}</span></div>`;
  }
  html("my-hand", h);
}

function renderCardInfo() {
  const el = $("card-info"); if (!el) return;
  if (ST.selectedCards.size === 0) { el.textContent = ""; return; }
  const id = [...ST.selectedCards][0];
  const hand = ST.gs?.you?.hand || [];
  const card = hand.find(c => c.id === id);
  el.textContent = card ? getCardDesc(card) : "";
}

const RESPONSE_NAMES = {
  dodge: "对手对你使用了【杀】，请出【闪】",
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
  if (isMe) html("pending-msg", `<strong>⚠ 你需要响应</strong>：${RESPONSE_NAMES[p.type] || p.type}`);
  else html("pending-msg", `<strong>对手需要响应</strong>：${RESPONSE_NAMES[p.type] || p.type}`);
  show("pending-msg");
}

function renderActions(gs) {
  let btns = "";
  const isMyTurn = gs.turnPlayer === ST.myIndex;
  const p = gs.pendingResponse;

  if (ST.blocked) { html("action-bar", ""); return; }

  if (p && p.target === ST.myIndex) {
    btns += `<button class="btn btn-outline btn-sm" onclick="send({action:'pass'})">不响应</button>`;
    if (ST.selectedCards.size > 0) btns += `<button class="btn btn-primary btn-sm" onclick="respondCard()">出牌响应</button>`;
  } else if (isMyTurn && gs.phase === "play" && !p) {
    if (ST.selectedCards.size > 0) btns += `<button class="btn btn-primary btn-sm" onclick="playSelected()">出牌</button>`;
    if (gs.you.skills?.length) for (const s of gs.you.skills) btns += `<button class="btn btn-outline btn-sm" onclick="send({action:'use_skill',skill_id:'${s}'})">技能: ${s}</button>`;
    btns += `<button class="btn btn-outline btn-sm" onclick="send({action:'end_phase'})">结束出牌</button>`;
  } else if (isMyTurn && gs.phase === "discard" && !p) {
    const need = gs.you.hand.length - gs.you.hp;
    if (need > 0 && ST.selectedCards.size > 0) btns += `<button class="btn btn-error btn-sm" onclick="doDiscard()">弃牌 (${ST.selectedCards.size}/${need})</button>`;
    if (need <= 0) btns += `<span class="text-sm opacity-60">无需弃牌</span>`;
  }
  html("action-bar", btns);
}

// ====== 卡牌选择 ======
function toggleCard(id) {
  if (ST.blocked) return;
  const gs = ST.gs; if (!gs) return;
  const isDiscard = gs.phase === "discard" && gs.turnPlayer === ST.myIndex;
  if (ST.selectedCards.has(id)) ST.selectedCards.delete(id);
  else { if (isDiscard) ST.selectedCards.add(id); else { ST.selectedCards.clear(); ST.selectedCards.add(id); } }
  renderHand(gs.you.hand); renderActions(gs); renderCardInfo();
}
function playSelected() { const ids = [...ST.selectedCards]; if (ids.length === 0 || ST.blocked) return; send({ action: "play_card", card_id: ids[0], target: ST.myIndex === 0 ? 1 : 0 }); ST.selectedCards.clear(); }
function respondCard() { const ids = [...ST.selectedCards]; if (ids.length === 0 || ST.blocked) return; send({ action: "play_card", card_id: ids[0] }); ST.selectedCards.clear(); }
function doDiscard() { const ids = [...ST.selectedCards]; if (ids.length === 0 || ST.blocked) return; send({ action: "discard", card_ids: ids }); ST.selectedCards.clear(); }

function showGameOver() {
  const gs = ST.gs; if (!gs?.gameOver) return; show("game-over-overlay");
  const won = gs.winner === ST.myIndex; const el = $("go-title");
  el.textContent = won ? "🎉 胜利！" : "💀 失败"; el.className = won ? "win" : "lose";
  let subtitle = `${gs.playerName||"你"} vs ${gs.opponentName||"对手"}\n你: ♥${gs.you.hp}/${gs.you.maxHp}  对手: ♥${gs.opponent.hp}/${gs.opponent.maxHp}`;
  if (ST.eloResult) {
    const er = ST.eloResult;
    subtitle += `\n\nELO ${won ? "+" : ""}${er.change} → ${er.newElo} (对手 ${er.opponentChange > 0 ? "+" : ""}${er.opponentChange})`;
  }
  text("go-subtitle", subtitle); ST.eloResult = null;
}

// ====== 初始化 ======
(async () => {
  await initAuth();
  if (AUTH.enabled) {
    show("auth-section");
    if (AUTH.token) { text("auth-user", "已登录"); $("auth-btn").textContent = "退出"; $("auth-btn").onclick = () => { AUTH.token = null; sessionStorage.removeItem("auth_token"); sessionStorage.removeItem("active_room"); text("auth-user", "未登录"); $("auth-btn").textContent = "登录"; $("auth-btn").onclick = startLogin; if (ST.ws) { ST.ws.close(); backToMenu(); } }; }
  }
})();
document.addEventListener("keydown", e => { if (e.key === "Enter" && ST.screen === "menu") joinRoom(); });
