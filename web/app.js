// ============================================================
// app.js — 学校杀网页版 (Alpine.js)
// 仅 WS/Auth/工具函数，所有渲染由 Alpine 模板处理
// ============================================================

// ====== 认证 (PKCE) ======
const HTTP_URL = `http://${location.host}`;
const WS_URL = `ws://${location.host}/ws`;
const AUTH = { enabled: false, provider: "", clientId: "", token: null };

function b64(buf) { const s = String.fromCharCode(...new Uint8Array(buf)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function startLogin() {
  const vb = new Uint8Array(32); crypto.getRandomValues(vb); const verifier = b64(vb);
  sessionStorage.setItem("pkce_verifier", verifier);
  const challenge = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  location.href = `${AUTH.provider}/oauth/v2/authorize?${new URLSearchParams({ client_id: AUTH.clientId, redirect_uri: location.origin + "/", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "openid profile email" })}`;
}

async function handleAuthCallback() {
  const code = new URLSearchParams(location.search).get("code"); if (!code) return false;
  const verifier = sessionStorage.getItem("pkce_verifier"); if (!verifier) return false;
  history.replaceState(null, "", location.pathname);
  const r = await fetch(`${AUTH.provider}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: AUTH.clientId, code, redirect_uri: location.origin + "/", code_verifier: verifier }) });
  if (!r.ok) { sessionStorage.removeItem("pkce_verifier"); return false; }
  const d = await r.json(); AUTH.token = d.access_token;
  sessionStorage.setItem("auth_token", d.access_token); sessionStorage.removeItem("pkce_verifier"); return true;
}

async function initAuth() {
  try { const r = await fetch(`${HTTP_URL}/info`); const info = await r.json();
    if (info.auth?.mode === "zitadel_oidc") { AUTH.enabled = true; AUTH.provider = info.auth.provider; AUTH.clientId = info.auth.clientId; }
  } catch { /* noop */ }
  const saved = sessionStorage.getItem("auth_token"); if (saved) AUTH.token = saved;
  if (AUTH.enabled && location.search.includes("code=")) { await handleAuthCallback(); }

  const inviteRoom = sessionStorage.getItem("invite_room");
  if (inviteRoom) {
    if (AUTH.token) { sessionStorage.removeItem("invite_room"); joinRoomByCode(inviteRoom); return; }
    if (AUTH.enabled) { startLogin(); return; }
  }
  if (AUTH.token) fetchDisconnectedGames();
}

// ====== 工具函数 ======
const esc = s => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
const suitSym = s => ({ spade: "♠", heart: "♥", club: "♣", diamond: "♦" }[s] || "?");
const cn = c => c?.name || "?";
const hpStr = (hp, max) => { let s = ""; for (let i = 0; i < max; i++) s += i < hp ? "♥" : "♡"; return s; };
const isWeapon = n => WEAPON_NAMES.has(n);

// ====== 常量 ======
const CARD_DESC = {
  "作业": "对手需出【豁免】抵消，否则受 1 点伤害",
  "豁免": "响应【作业】或【点名批评】",
  "补给": "回复 1 点体力，或濒死时自救",
  "辩论": "双方轮流出【作业】，先不出者受 1 点伤害",
  "突击测验": "对手需出【作业】，否则受 1 点伤害",
  "点名批评": "对手需出【豁免】，否则受 1 点伤害",
  "告密": "盲选弃置对手一张手牌或装备",
  "小抄": "本回合下一张【作业】伤害 +1；或濒死时自救",
  "神偷": "盲选获取对手一张手牌或装备",
  "陷害": "随机弃置对手两张手牌或装备",
  "嫁祸": "对手需弃一张牌，否则受 1 点伤害",
  "午饭": "摸 2 张牌",
  "午饭留堂": "对手随机弃一张手牌或装备",
  "感冒": "造成 1 点伤害",
  "免罚券": "抵消一张锦囊牌（辩论/突击测验/最终测试/嫁祸）",
  "最终测试": "全体各抽 2 张牌",
  "钢笔": "武器：攻击未闪避时伤害 +1",
  "圆规": "武器：【作业】无视出牌次数限制",
  "尺子": "武器：对手出【豁免】后，可再出一张【作业】",
  "橡皮": "武器：【作业】被豁免后仍造成 1 点伤害",
  "校服": "防具：黑色【作业】无效",
  "黑名单": "防具：【作业】无效；受到【陷害】【点名批评】伤害+1",
  "涂改液": "防具：被【作业】时翻牌判定，翻出红色则自动闪避",
};
const SKILL_DESC = {
  class_president: "出牌阶段弃一张手牌，令对手也弃一张手牌。每回合限一次。",
  athletic: "锁定技。手牌上限+1。",
  tutoring: "锁定技。摸牌阶段多摸一张牌。",
};
const WEAPON_NAMES = new Set(["钢笔", "圆规", "尺子", "橡皮"]);
const DEFENSIVE_ONLY = ["豁免", "免罚券"];
const RESP_CARDS = { dodge: ["豁免"], near_death: ["补给", "小抄"], duel: ["作业"], barbarian: ["作业"], volley: ["豁免"], borrow_knife: null };
const RESP_NAMES = {
  dodge: "对手对你使用了【作业】，请出【豁免】",
  near_death: "你处于濒死状态，请出【补给】或【小抄】自救",
  duel: "对手发起【辩论】，请出【作业】",
  barbarian: "【突击测验】！请出【作业】",
  volley: "【点名批评】！请出【豁免】",
  borrow_knife: "【嫁祸】！请弃一张牌",
  steal: p => p.stealAction === "discard" ? "【告密】！选择对手一张牌弃掉（10秒）" : "【神偷】！选择对手一张牌获取（10秒）",
  skill_discard: "请弃一张手牌以发动技能",
  opponent_discard: "对手技能生效！请选择要弃的牌",
  judge_armor: "是否发动【涂改液】翻牌判定？（8秒）",
};
const RESP_NAMES_OPP = {
  dodge: "等待对手出【豁免】响应你的【作业】",
  near_death: "对手濒死，等待使用【补给】",
  duel: "等待对手出【作业】响应【辩论】",
  barbarian: "等待对手出【作业】响应【突击测验】",
  volley: "等待对手出【豁免】响应【点名批评】",
  borrow_knife: "等待对手弃牌响应【嫁祸】",
  steal: "对手正在盲选你的牌...",
  skill_discard: "对手正在弃牌发动技能...",
  opponent_discard: "等待对手弃牌响应你的技能...",
  judge_armor: "等待对手决定是否发动【涂改液】...",
};
const PN = { judge: "判定", draw: "摸牌", play: "出牌", discard: "弃牌", end: "结束" };

function getCardDesc(c) { return CARD_DESC[c.name] || `${c.name}（${suitSym(c.suit)}${c.number}）`; }
function getSkillDesc(s) { return SKILL_DESC[s.id] || s.name; }

// ====== 重连 ======
let _reconnectOverlayActive = false;
async function fetchDisconnectedGames() {
  if (!AUTH.token) return;
  try {
    const r = await fetch(`${HTTP_URL}/api/disconnected-games?token=${encodeURIComponent(AUTH.token)}`);
    const data = await r.json();
    if (data.games?.length) {
      const g = data.games[0];
      const elapsed = Math.floor((Date.now() - g.disconnectedAt) / 1000);
      const remain = Math.max(0, 30 - elapsed);
      if (remain <= 0) { return; }
      _reconnectOverlayActive = true;
      createOverlay("🔌 断线重连", `房间 <b style="color:#c4b5fd">${g.roomCode}</b> &nbsp; 对手: ${esc(g.opponent)}`, remain, t => `${t} 秒内可重连`, () => { _reconnectOverlayActive = false; Alpine.store("g").roomCode = g.roomCode; connect(buildWsUrl(`?room=${g.roomCode}`)); }, () => { _reconnectOverlayActive = false; }, false);
      return;
    }
  } catch { /* server unavailable, no fallback */ }
}


// ====== Overlay ======
let _overlayTimer = null;
function createOverlay(title, body, seconds, cfn, onAction, onCancel, noIgnore, buttonText) {
  removeOverlay();
  const el = document.createElement("div"); el.id = "block-overlay";
  el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999";
  let r = seconds;
  const upd = () => { const cd = el.querySelector("#bl-countdown"); if (cd) cd.textContent = cfn(r); };
  const ignoreHtml = noIgnore ? "" : '<button class="btn btn-outline btn-sm" id="bl-ignore">忽略</button>';
  el.innerHTML = `<div style="background:#1a1a1a;border:2px solid #7c3aed;border-radius:16px;padding:40px;text-align:center;max-width:360px;display:flex;flex-direction:column;gap:12px">
    <h2 style="font-size:28px">${title}</h2><div>${body}</div>
    <p id="bl-countdown" style="color:#f59e0b;font-family:monospace;font-size:16px">${cfn(seconds)}</p>
    <div style="display:flex;gap:12px;justify-content:center;margin-top:8px">
      <button class="btn btn-primary btn-sm" id="bl-action">${onAction ? (buttonText || '重新连接') : ''}</button>
      ${ignoreHtml}</div></div>`;
  document.body.appendChild(el);
  _overlayTimer = setInterval(() => { r--; if (r <= 0) { clearInterval(_overlayTimer); _overlayTimer = null; removeOverlay(); if (onCancel) onCancel(); } upd(); }, 1000);
  if (onAction) el.querySelector("#bl-action").onclick = () => { clearInterval(_overlayTimer); _overlayTimer = null; removeOverlay(); onAction(); };
  else el.querySelector("#bl-action").style.display = "none";
  if (!noIgnore) el.querySelector("#bl-ignore").onclick = () => { clearInterval(_overlayTimer); _overlayTimer = null; removeOverlay(); if (onCancel) onCancel(); };
}

function removeOverlay() {
  if (_overlayTimer) { clearInterval(_overlayTimer); _overlayTimer = null; }
  const el = document.getElementById("block-overlay"); if (el) el.remove();
}
function showToast(msg) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(220,38,38,.9);color:white;padding:8px 20px;border-radius:8px;font-size:14px;z-index:999;pointer-events:none;animation:fadeOut 3s forwards";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3100);
}
function showLoginOverlay() {
  removeOverlay();
  const el = document.createElement("div"); el.id = "block-overlay";
  el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:999";
  el.innerHTML = `<div style="background:var(--c-card);border:2px solid var(--c-accent);border-radius:16px;padding:40px 32px;text-align:center;max-width:340px;display:flex;flex-direction:column;gap:16px">
    <div style="font-size:48px">🔐</div>
    <h2 style="font-size:22px;font-weight:bold">请先登录</h2>
    <p style="opacity:.6;font-size:14px">需要登录后才能进行游戏操作</p>
    <button class="btn btn-primary w-full" id="login-overlay-btn">登录</button>
  </div>`;
  document.body.appendChild(el);
  el.querySelector("#login-overlay-btn").onclick = () => startLogin();
}
function hideLoginOverlay() { removeOverlay(); }


// ====== WebSocket ======
function buildWsUrl(path) { let url = `${WS_URL}${path}`; if (AUTH.token) url += (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(AUTH.token)}`; return url; }

function connect(wsUrl) {
  const store = Alpine.store("g");
  if (store.ws) store.ws.close();
  store.ws = new WebSocket(wsUrl);
  store.selectedCards = {};
  store.blocked = false;
  removeOverlay();
  store.ws.onopen = () => {};
  store.ws.onmessage = ev => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } handleMsg(msg); };
  store.ws.onclose = () => {
    stopTimers();
    if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
    if (store.screen === "lobby" && store.mode === "matching") {
      store.screen = "menu"; store.lobbyStatus = "";
    }
    if (store.screen === "game" || store.screen === "char") {
      if (store.roomCode && store.gs && !store.gs.gameOver) fetchDisconnectedGames();
    }
  };
  store.ws.onerror = () => {
    if (AUTH.enabled && AUTH.token) { AUTH.token = null; sessionStorage.removeItem("auth_token"); startLogin(); }
    else if (AUTH.enabled) startLogin();
  };
}

function handleMsg(msg) {
  const store = Alpine.store("g");
  switch (msg.type) {
    case "room_created":
      store.roomCode = msg.code; store.mode = "room";
      store.screen = "lobby"; store.lobbyCode = msg.code; store.lobbyInvite = msg.inviteUrl; break;
    case "waiting":
      store.lobbyStatus = msg.message; break;
    case "character_select":
      store.mode = "room"; store.screen = "char";
      store.characters = msg.characters; store.charTimeout = msg.timeoutSec;
      store.selectedChar = null; store.charLocked = false;
      store.opponentPicked = false; store.opponentLocked = false;
      if (store.charTimer) clearInterval(store.charTimer);
      let s = msg.timeoutSec; store.charTimerText = `${s}s`;
      store.charTimer = setInterval(() => { s--; if (s < 0) { clearInterval(store.charTimer); return; } store.charTimerText = `${s}s`; }, 1000);
      if (msg.opponent) {
        store.charOpponent = `对手: ${esc(msg.opponent.displayName)}${store.mode === "matching" ? ` (ELO ${msg.opponent.elo})` : ""}`;
        store.charEloPrediction = "";
        if (msg.elo?.prediction) {
          const p = msg.elo.prediction;
          store.charEloPrediction = `<span style="color:#22c55e">胜 +${p.win}</span> · <span style="color:#ef4444">负 ${p.lose}</span>（你的 ELO ${msg.elo.my}）`;
        }
      } else { store.charOpponent = ""; store.charEloPrediction = ""; }
      break;
    case "game_state":
      store.gs = msg.state; store.myIndex = msg.yourIndex;
      store._playVersion++;
      store._judgeVersion++;
      if (store.screen !== "game") { store.screen = "game"; clearInterval(store.charTimer); }
      if (msg.eloResult) store.eloResult = msg.eloResult;
      if (store.gs.gameOver) { stopTimers(); }
      break;
    case "disconnected":
      store.blocked = true; stopTimers();
      if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
      createOverlay("⚠ 对手已断线", msg.message, 30, t => `${t} 秒后自动判胜（剩余重连: ${msg.attemptsLeft} 次）`, null, null, true);
      break;
    case "reconnected":
      store.blocked = false; removeOverlay(); break;
    case "queue_status":
      store.mode = "matching"; store.screen = "lobby";
      store.lobbyCode = ""; store.lobbyInvite = "";
      store.matchStartTime = Date.now();
      if (store.matchInterval) clearInterval(store.matchInterval);
      store.lobbyStatus = `匹配中... 排队: ${msg.position} (已匹配 0s)`;
      store.matchInterval = setInterval(() => {
        if (store.mode !== "matching") { clearInterval(store.matchInterval); return; }
        const sec = Math.floor((Date.now() - store.matchStartTime) / 1000);
        store.lobbyStatus = `匹配中... 排队: ${msg.position} (已匹配 ${sec}s)`;
      }, 1000);
      break;
    case "match_found":
      if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
      store.mode = "matching"; store.roomCode = msg.room;
      store.lobbyStatus = `匹配成功！${msg.opponent.displayName} (ELO ${msg.opponent.elo})`;
      connect(buildWsUrl(`?room=${msg.room}`)); break;
    case "queue_timeout":
      if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
      store.screen = "menu"; break;
    case "opponent_picked":
      store.opponentPicked = msg.picked; break;
    case "opponent_locked":
      store.opponentLocked = msg.locked; break;
    case "opponent_left_win":
      store.screen = "menu";
      if (msg.eloResult) store.eloResult = msg.eloResult;
      createOverlay(msg.title || "🎉 对手退出",
        msg.message + (msg.eloResult ? `\nELO ${msg.eloResult.change > 0 ? '+' : ''}${msg.eloResult.change} → ${msg.eloResult.newElo}` : ""),
        5, t => `${t} 秒后关闭`, () => { removeOverlay(); }, () => { removeOverlay(); }, true, "确认");
      break;
    case "reconnected":
      store.blocked = false; removeOverlay(); break;
    case "opponent_reconnected":
      removeOverlay(); break;
    case "error":
      showToast(msg.message); break;
  }
}

// ====== Game actions (called from Alpine) ======
function send(msg) {
  const store = Alpine.store("g");
  if (store.blocked) return;
  if (store.ws?.readyState === WebSocket.OPEN) store.ws.send(JSON.stringify(msg));
}

function ensureAuth() { if (AUTH.enabled && !AUTH.token) { showLoginOverlay(); return false; } return true; }

let _creating = false;
function createRoom() {
  if (!ensureAuth() || _creating) return;
  _creating = true;
  fetch(`${HTTP_URL}/room/create`).then(r => r.json()).then(info => {
    const store = Alpine.store("g");
    store.roomCode = info.code; store.mode = "room";
    store.screen = "lobby"; store.lobbyCode = info.code; store.lobbyInvite = info.inviteUrl;
    connect(buildWsUrl(`?room=${info.code}`));
  }).finally(() => { _creating = false; });
}

function joinRoom() {
  if (!ensureAuth()) return;
  const code = document.getElementById("join-code")?.value?.trim()?.toUpperCase();
  if (!code) return;
  joinRoomByCode(code);
}
function joinRoomByCode(code) {
  const store = Alpine.store("g");
  store.roomCode = code; store.mode = "room";
  store.screen = "lobby"; connect(buildWsUrl(`?room=${code}`));
}
function quickMatch() {
  if (!ensureAuth()) return;
  const store = Alpine.store("g");
  store.mode = "matching"; connect(buildWsUrl("?mode=matching"));
}
function leaveLobby() {
  const store = Alpine.store("g");
  if (store.ws) store.ws.close();
  store.screen = "menu";
}
function backToMenu() {
  stopTimers();
  const store = Alpine.store("g");
  if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
  if (store.charTimer) { clearInterval(store.charTimer); store.charTimer = null; }
  if (store.ws) store.ws.close();
  store.ws = null; store.gs = null; store.roomCode = null; store.myIndex = -1;
  store.selectedCards = {}; store.blocked = false; store.matchStartTime = null;
  store.eloResult = null; store._lastLogLen = 0; store._lastPlayId = null; store._lastDiscardKeys = "";
  store.selectedChar = null; store.charLocked = false;
  store.opponentPicked = false; store.opponentLocked = false;
  removeOverlay(); store.screen = "menu";
}
function showLeaderboard() {
  const store = Alpine.store("g");
  fetch(`${HTTP_URL}/leaderboard` + (store.gs?.playerId ? `?userId=${store.gs.playerId}` : ""))
    .then(r => r.json()).then(data => {
      store.lbData = data; store.screen = "leaderboard";
    });
}

// ====== Timers ======
let _timerInterval = null;
let _pendingTimer = null;

function stopTimers() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  if (_pendingTimer) { clearInterval(_pendingTimer); _pendingTimer = null; }
}
function stopTurnTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  Alpine.store("g").turnTimerText = "";
}

function startPendingTimer(timeout) {
  if (_pendingTimer) clearInterval(_pendingTimer);
  const store = Alpine.store("g");
  _pendingTimer = setInterval(() => {
    const r = Math.max(0, Math.floor((timeout - Date.now()) / 1000));
    store.pendingTimerText = r + "s";
    if (r <= 0) { clearInterval(_pendingTimer); _pendingTimer = null; }
  }, 200);
}

function stopPendingTimer() {
  if (_pendingTimer) { clearInterval(_pendingTimer); _pendingTimer = null; }
  Alpine.store("g").pendingTimerText = "";
}

// ====== Init ======
document.addEventListener("alpine:init", () => {
  Alpine.store("g", {
    screen: "menu",
    ws: null, gs: null, myIndex: -1,
    selectedCards: {},  // {cardId: true} for Alpine reactivity
    blocked: false,
    serverTimer: 60, pendingTimerText: "",
    turnTimerText: "",
    roomCode: null, mode: null,
    matchStartTime: null, matchInterval: null,
    eloResult: null,
    charTimer: null, charTimerText: "", charStatus: "",
    charOpponent: "", charEloPrediction: "",
    characters: [], charTimeout: 0,
    selectedChar: null, charLocked: false,
    opponentPicked: false, opponentLocked: false,
    lobbyCode: "", lobbyInvite: "", lobbyStatus: "等待另一位玩家...",
    lbData: null,
    _lastLogLen: 0, _lastPlayId: null, _lastDiscardKeys: "",
    _hadPending: false,
    _playVersion: 0, _judgeVersion: 0,

    // Computed helpers
    get isMyTurn() { return this.gs?.turnPlayer === this.myIndex; },
    get opp() { return this.gs?.opponent; },
    get me() { return this.gs?.you; },
    get pending() { return this.gs?.pendingResponse; },
    get isMyResp() { return this.pending && this.pending.target === this.myIndex; },
    get phaseLabel() { return PN[this.gs?.phase] || this.gs?.phase; },
    get cardCount() { return this.selectedCards ? Object.keys(this.selectedCards).length : 0; },

    // Actions
    toggleCard(id) {
      if (this.blocked) return;
      if (this.isCardDisabled(this.me?.hand?.find(c => c.id === id))) return;
      const isDiscard = this.gs?.phase === "discard" && this.gs?.turnPlayer === this.myIndex;
      const isSkillDiscard = this.pending?.type === "skill_discard" && this.isMyResp;
      const sel = this.selectedCards;
      if (sel[id]) { delete sel[id]; }
      else {
        // 弃牌阶段限制选择数量
        if (isDiscard) {
          const need = this.needDiscard();
          if (Object.keys(sel).length >= need) return;
        }
        // 技能弃牌限制
        if (isSkillDiscard) {
          const need = this.pending?.discardCount || 1;
          if (Object.keys(sel).length >= need) return;
        }
        if (!isDiscard && !isSkillDiscard) { for (const k in sel) delete sel[k]; }
        sel[id] = true;
      }
      this.selectedCards = Object.assign({}, sel);
    },
    isCardDisabled(c) {
      const isDiscard = this.gs?.phase === "discard" && this.gs?.turnPlayer === this.myIndex;
      // 对手技能强制弃牌：所有手牌可选
      if (this.pending?.type === "opponent_discard") return false;
      // 防御牌在自己出牌阶段（非响应中）不能主动出
      if (!isDiscard && this.gs?.phase === "play" && this.isMyTurn && !this.pending && DEFENSIVE_ONLY.includes(c.name)) return true;
      // 非响应阶段所有牌可用
      if (!this.isMyResp || !this.gs || !this.pending) return false;
      if (isDiscard) return false;
      const p = this.pending;
      const selectable = RESP_CARDS[p.type];
      if (!selectable) return false; // skill_discard etc — all cards allowed
      if (selectable.includes(c.name)) return false;
      if (p.type === "borrow_knife" && isWeapon(c.name)) return false;
      if (c.name === "免罚券" && ["barbarian", "volley", "duel", "borrow_knife"].includes(p.type)) return false;
      return true;
    },
    disabledReason(c) {
      if (!this.isMyResp || !this.gs) return "";
      const p = this.pending;
      if (!p) return "";
      const selectable = RESP_CARDS[p.type];
      if (!selectable) return "";
      return `需要${selectable.join("或")}`;
    },
    isCardSelected(id) { return !!this.selectedCards[id]; },

    pickCharacter(id) {
      if (this.charLocked) return;
      this.selectedChar = id;
      send({ action: "pick_character", id });
    },
    lockCharacter() {
      if (!this.selectedChar || this.charLocked) return;
      this.charLocked = true;
      send({ action: "lock_character" });
    },
    playSelected() {
      const ids = Object.keys(this.selectedCards);
      if (ids.length === 0 || this.blocked) return;
      send({ action: "play_card", card_id: ids[0], target: this.myIndex === 0 ? 1 : 0 });
      this.selectedCards = {};
    },
    respondCard() {
      const ids = Object.keys(this.selectedCards);
      if (ids.length === 0 || this.blocked) return;
      send({ action: "play_card", card_id: ids[0] });
      this.selectedCards = {};
    },
    doDiscard() {
      const ids = Object.keys(this.selectedCards);
      if (ids.length === 0 || this.blocked) return;
      send({ action: "discard", card_ids: ids });
      this.selectedCards = {};
    },
    doConfirmSkill() {
      const ids = Object.keys(this.selectedCards);
      if (ids.length === 0 || this.blocked) return;
      send({ action: "confirm_skill", card_ids: ids });
      this.selectedCards = {};
    },
    doPass() { send({ action: "pass" }); },
    doEndPhase() { send({ action: "end_phase" }); },
    doActivateArmor() { send({ action: "activate_armor" }); },
    doUseSkill(skillId) { send({ action: "use_skill", skill_id: skillId }); },
    stealWithAnim(pos) {
      if (this.blocked) return;
      // Animate the clicked card
      const cards = document.querySelectorAll(".steal-card");
      const el = [...cards].find(c => parseInt(c.dataset.pos) === pos);
      if (el) { el.classList.add("steal-fly"); setTimeout(() => el.remove(), 500); }
      cards.forEach(c => c.style.pointerEvents = "none");
      send({ action: "steal_card", position: pos });
    },
    stealPositions() {
      if (!this.pending || this.pending.type !== "steal") return [];
      return Array.from({ length: this.pending.poolSize || 0 }, (_, i) => i + 1);
    },

    // Pending helpers
    pendingLabel() {
      const p = this.pending; if (!p) return "";
      const label = this.isMyResp ? (RESP_NAMES[p.type] || p.type) : (RESP_NAMES_OPP[p.type] || p.type);
      return typeof label === "function" ? label(p) : label;
    },
    pendingPrefix() { return this.isMyResp ? "你" : "对手"; },
    pendingRemaining() {
      const p = this.pending; if (!p || !p.timeout) return 0;
      return Math.max(0, Math.floor((p.timeout - Date.now()) / 1000));
    },

    // Game helpers
    oppNameDisplay() { return this.gs?.opponentName || "对手"; },
    myNameDisplay() { return this.gs?.playerName || "你"; },
    isOppTurn() { return this.gs?.turnPlayer !== this.myIndex; },
    needDiscard() {
      if (!this.me || !this.gs) return 0;
      return Math.max(0, this.me.hand.length - (this.gs.handLimit || this.me.hp));
    },

    // Recent play/discard for center zone
    recentPlayCard() {
      if (!this.gs?.log) return null;
      for (let i = this.gs.log.length - 1; i >= 0; i--) {
        if (this.gs.log[i].id === "card_played") return this.gs.log[i];
      }
      return null;
    },
    recentDiscards() {
      if (!this.gs?.log) return [];
      const d = [];
      for (let i = this.gs.log.length - 1; i >= 0 && d.length < 3; i--) {
        const e = this.gs.log[i];
        if (e.id === "card_discarded" || e.id === "discard") d.unshift(e);
      }
      return d;
    },
    recentSkillUsed() {
      if (!this.gs?.log) return null;
      const last = this.gs.log[this.gs.log.length - 1];
      return last?.id === "skill_used" ? last : null;
    },
    recentJudge() {
      if (!this.gs?.log) return null;
      const last = this.gs.log[this.gs.log.length - 1];
      return last?.id === "judge_result" ? last : null;
    },
    detailLog() {
      // 返回最新一条日志的详细描述（一次性显示）
      if (!this.gs?.log) return "";
      const last = this.gs.log[this.gs.log.length - 1];
      if (!last) return "";
      const who = last.player === this.myIndex ? "你" : "对手";
      switch (last.id) {
        case "card_played":
          return last.target !== undefined
            ? `${who} 对 ${last.target === this.myIndex ? "你" : "对手"} 使用了【${last.cardName}】`
            : `${who} 使用了【${last.cardName}】`;
        case "damage": return `${who} 受到 ${last.amount} 点伤害`;
        case "heal": return `${who} 回复了 ${last.amount} 点体力`;
        case "skill_used": return `${who} 发动了技能【${last.skillName}】`;
        case "draw": return `${who} 摸了 ${last.count} 张牌`;
        case "card_discarded": case "discard": return `${who} 弃置了【${last.cardName}】`;
        case "judge_result":
          return `涂改液判定：${who} 翻出 ${suitSym(last.suit)}【${last.cardName}】→ ${last.result === "success" ? "红色·闪避成功 ✅" : "黑色·判定失败 ❌"}`;
        case "death": return `${who} 阵亡`;
        default: return "";
      }
    },
    formatLogEntry(e) {
      const p = `P${e.player}`;
      switch (e.id) {
        case "card_played": return `${p} 使用了【${e.cardName}】${e.target !== undefined ? ` → P${e.target}` : ""}`;
        case "card_equipped": return `${p} 装备了【${e.cardName}】`;
        case "damage": return `${p} 受到 ${e.amount} 点伤害`;
        case "heal": return `${p} 回复了 ${e.amount} 点体力`;
        case "skill_used": return `${p} 发动了【${e.skillName}】`;
        case "draw": return `${p} 摸了 ${e.count} 张牌`;
        case "card_discarded": case "discard": return `${p} 弃置了【${e.cardName}】`;
        case "death": return `${p} 阵亡`;
        case "judge_result": return `⚖ 判定：${p} 翻出【${e.cardName}】${e.suit} → ${e.result === "success" ? "红色·闪避✅" : "黑色·生效❌"}`;
        default: return "";
      }
    },
    gameOverMsg() {
      if (!this.gs?.gameOver) return "";
      const won = this.gs.winner === this.myIndex;
      return { won, title: won ? "🎉 胜利！" : "💀 失败", cls: won ? "win" : "lose" };
    },
  });
});

// ====== Bootstrap ======
(async () => {
  await initAuth();
  if (AUTH.enabled) {
    if (AUTH.token) {
      hideLoginOverlay();
      const sec = document.getElementById("auth-section");
      if (sec) { sec.classList.remove("hidden"); }
      // Fetch user info
      fetch(`${AUTH.provider}/oidc/v1/userinfo`, { headers: { Authorization: `Bearer ${AUTH.token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            const name = data.nickname || data.name || data.preferred_username || "";
            const el = document.getElementById("auth-user");
            if (el) el.textContent = name || "已登录";
          }
        }).catch(() => {});
    } else {
      showLoginOverlay();
    }
  }
})();

// Start turn timer (called reactively)
function startTurnTimer(s) {
  stopTimers();
  const store = Alpine.store("g");
  store.serverTimer = s;
  store.turnTimerText = `${s}s`;
  _timerInterval = setInterval(() => {
    store.serverTimer--;
    if (store.serverTimer < 0) store.serverTimer = 0;
    store.turnTimerText = `${store.serverTimer}s`;
  }, 1000);
}
