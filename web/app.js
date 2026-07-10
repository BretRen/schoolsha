     1|// ============================================================
     2|// app.js — 学校杀网页版 (Alpine.js)
     3|// 仅 WS/Auth/工具函数，所有渲染由 Alpine 模板处理
     4|// ============================================================
     5|
     6|// ====== 认证 (PKCE) ======
     7|const HTTP_URL = `http://${location.host}`;
     8|const WS_URL = `ws://${location.host}/ws`;
     9|const AUTH = { enabled: false, provider: "", clientId: "", token: null };
    10|
    11|function b64(buf) { const s = String.fromCharCode(...new Uint8Array(buf)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    12|
    13|async function startLogin() {
    14|  const vb = new Uint8Array(32); crypto.getRandomValues(vb); const verifier = b64(vb);
    15|  sessionStorage.setItem("pkce_verifier", verifier);
    16|  const challenge = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    17|  location.href = `${AUTH.provider}/oauth/v2/authorize?${new URLSearchParams({ client_id: AUTH.clientId, redirect_uri: location.origin + "/", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "openid profile email" })}`;
    18|}
    19|
    20|async function handleAuthCallback() {
    21|  const code = new URLSearchParams(location.search).get("code"); if (!code) return false;
    22|  const verifier = sessionStorage.getItem("pkce_verifier"); if (!verifier) return false;
    23|  history.replaceState(null, "", location.pathname);
    24|  const r = await fetch(`${AUTH.provider}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: AUTH.clientId, code, redirect_uri: location.origin + "/", code_verifier: verifier }) });
    25|  if (!r.ok) { sessionStorage.removeItem("pkce_verifier"); return false; }
    26|  const d = await r.json(); AUTH.token = d.access_token;
    27|  sessionStorage.setItem("auth_token", d.access_token); sessionStorage.removeItem("pkce_verifier"); return true;
    28|}
    29|
    30|async function initAuth() {
    31|  try { const r = await fetch(`${HTTP_URL}/info`); const info = await r.json();
    32|    if (info.auth?.mode === "zitadel_oidc") { AUTH.enabled = true; AUTH.provider = info.auth.provider; AUTH.clientId = info.auth.clientId; }
    33|  } catch { /* noop */ }
    34|  const saved = sessionStorage.getItem("auth_token"); if (saved) AUTH.token = saved;
    35|  if (AUTH.enabled && location.search.includes("code=")) { await handleAuthCallback(); }
    36|
    37|  const inviteRoom = sessionStorage.getItem("invite_room");
    38|  if (inviteRoom) {
    39|    if (AUTH.token) { sessionStorage.removeItem("invite_room"); joinRoomByCode(inviteRoom); return; }
    40|    if (AUTH.enabled) { startLogin(); return; }
    41|  }
    42|  if (AUTH.token) fetchDisconnectedGames();
    43|}
    44|
    45|// ====== 工具函数 ======
    46|const esc = s => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
    47|const suitSym = s => ({ spade: "♠", heart: "♥", club: "♣", diamond: "♦" }[s] || "?");
    48|const cn = c => c?.name || "?";
    49|const hpStr = (hp, max) => { let s = ""; for (let i = 0; i < max; i++) s += i < hp ? "♥" : "♡"; return s; };
    50|const isWeapon = n => WEAPON_NAMES.has(n);
    51|
    52|// ====== 常量 ======
    53|const CARD_DESC = {
    54|  "作业": "对手需出【豁免】抵消，否则受 1 点伤害",
    55|  "豁免": "响应【作业】或【点名批评】",
    56|  "补给": "回复 1 点体力，或濒死时自救",
    57|  "辩论": "双方轮流出【作业】，先不出者受 1 点伤害",
    58|  "突击测验": "对手需出【作业】，否则受 1 点伤害",
    59|  "点名批评": "对手需出【豁免】，否则受 1 点伤害",
    60|  "告密": "盲选弃置对手一张手牌或装备",
    61|  "小抄": "本回合下一张【作业】伤害 +1；或濒死时自救",
    62|  "神偷": "盲选获取对手一张手牌或装备",
    63|  "陷害": "随机弃置对手两张手牌或装备",
    64|  "嫁祸": "对手需弃一张牌，否则受 1 点伤害",
    65|  "午饭": "摸 2 张牌",
    66|  "午饭留堂": "对手随机弃一张手牌或装备",
    67|  "感冒": "造成 1 点伤害",
    68|  "免罚券": "抵消一张锦囊牌（辩论/突击测验/最终测试/嫁祸）",
    69|  "最终测试": "全体各抽 2 张牌",
    70|  "钢笔": "武器：攻击未闪避时伤害 +1",
    71|  "圆规": "武器：【作业】无视出牌次数限制",
    72|  "尺子": "武器：对手出【豁免】后，可再出一张【作业】",
    73|  "橡皮": "武器：【作业】被豁免后仍造成 1 点伤害",
    74|  "校服": "防具：黑色【作业】无效",
    75|  "黑名单": "防具：【作业】无效；受到【陷害】【点名批评】伤害+1",
    76|  "涂改液": "防具：被【作业】时翻牌判定，翻出红色则自动闪避",
    77|};
    78|const SKILL_DESC = {
    79|  class_president: "出牌阶段弃一张手牌，令对手也弃一张手牌。每回合限一次。",
    80|  athletic: "锁定技。手牌上限+1。",
    81|  tutoring: "锁定技。摸牌阶段多摸一张牌。",
    82|};
    83|const WEAPON_NAMES = new Set(["钢笔", "圆规", "尺子", "橡皮"]);
    84|const DEFENSIVE_ONLY = ["豁免", "免罚券"];
    85|const RESP_CARDS = { dodge: ["豁免"], near_death: ["补给", "小抄"], duel: ["作业"], barbarian: ["作业"], volley: ["豁免"], borrow_knife: [] };
    86|const RESP_NAMES = {
    87|  dodge: "对手对你使用了【作业】，请出【豁免】",
    88|  near_death: "你处于濒死状态，请出【补给】或【小抄】自救",
    89|  duel: "对手发起【辩论】，请出【作业】",
    90|  barbarian: "【突击测验】！请出【作业】",
    91|  volley: "【点名批评】！请出【豁免】",
    92|  borrow_knife: "【嫁祸】！请弃一张牌",
    93|  steal: p => p.stealAction === "discard" ? "【告密】！选择对手一张牌弃掉（10秒）" : "【神偷】！选择对手一张牌获取（10秒）",
    94|  skill_discard: "请弃一张手牌以发动技能",
    95|};
    96|const RESP_NAMES_OPP = {
    97|  dodge: "等待对手出【豁免】响应你的【作业】",
    98|  near_death: "对手濒死，等待使用【补给】",
    99|  duel: "等待对手出【作业】响应【辩论】",
   100|  barbarian: "等待对手出【作业】响应【突击测验】",
   101|  volley: "等待对手出【豁免】响应【点名批评】",
   102|  borrow_knife: "等待对手弃牌响应【嫁祸】",
   103|  steal: "对手正在盲选你的牌...",
   104|  skill_discard: "对手正在弃牌发动技能...",
   105|};
   106|const PN = { judge: "判定", draw: "摸牌", play: "出牌", discard: "弃牌", end: "结束" };
   107|
   108|function getCardDesc(c) { return CARD_DESC[c.name] || `${c.name}（${suitSym(c.suit)}${c.number}）`; }
   109|function getSkillDesc(s) { return SKILL_DESC[s.id] || s.name; }
   110|
   111|// ====== 重连 ======
   112|let _reconnectOverlayActive = false;
   113|async function fetchDisconnectedGames() {
   114|  if (!AUTH.token) return;
   115|  try {
   116|    const r = await fetch(`${HTTP_URL}/api/disconnected-games?token=${encodeURIComponent(AUTH.token)}`);
   117|    const data = await r.json();
   118|    if (data.games?.length) {
   119|      const g = data.games[0];
   120|      const elapsed = Math.floor((Date.now() - g.disconnectedAt) / 1000);
   121|      const remain = Math.max(0, 30 - elapsed);
      if (remain <= 0) return;
      _reconnectOverlayActive = true;
      createOverlay("🔌 断线重连", `房间 <b style="color:#c4b5fd">${g.roomCode}</b> &nbsp; 对手: ${esc(g.opponent)}`, remain, t => `${t} 秒内可重连`, () => { _reconnectOverlayActive = false; Alpine.store("g").roomCode = g.roomCode; connect(buildWsUrl(`?room=${g.roomCode}`)); }, () => { _reconnectOverlayActive = false; }, false);
      return;
    }
  } catch { /* server unavailable, no fallback */ }
   132|}
   133|

// ====== Overlay ======
   138|let _overlayTimer = null;
   139|function createOverlay(title, body, seconds, cfn, onAction, onCancel, noIgnore) {
   140|  removeOverlay();
   141|  const el = document.createElement("div"); el.id = "block-overlay";
   142|  el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999";
   143|  let r = seconds;
   144|  const upd = () => { const cd = el.querySelector("#bl-countdown"); if (cd) cd.textContent = cfn(r); };
   145|  const ignoreHtml = noIgnore ? "" : '<button class="btn btn-outline btn-sm" id="bl-ignore">忽略</button>';
   146|  el.innerHTML = `<div style="background:#1a1a1a;border:2px solid #7c3aed;border-radius:16px;padding:40px;text-align:center;max-width:360px;display:flex;flex-direction:column;gap:12px">
   147|    <h2 style="font-size:28px">${title}</h2><div>${body}</div>
   148|    <p id="bl-countdown" style="color:#f59e0b;font-family:monospace;font-size:16px">${cfn(seconds)}</p>
   149|    <div style="display:flex;gap:12px;justify-content:center;margin-top:8px">
   150|      <button class="btn btn-primary btn-sm" id="bl-action">${onAction ? '重新连接' : ''}</button>
   151|      ${ignoreHtml}</div></div>`;
   152|  document.body.appendChild(el);
   153|  _overlayTimer = setInterval(() => { r--; if (r <= 0) { clearInterval(_overlayTimer); _overlayTimer = null; removeOverlay(); if (onCancel) onCancel(); } upd(); }, 1000);
   154|  if (onAction) el.querySelector("#bl-action").onclick = () => { clearInterval(_overlayTimer); _overlayTimer = null; removeOverlay(); onAction(); };
   155|  else el.querySelector("#bl-action").style.display = "none";
   156|  if (!noIgnore) el.querySelector("#bl-ignore").onclick = () => { clearInterval(_overlayTimer); _overlayTimer = null; removeOverlay(); if (onCancel) onCancel(); };
   157|}
   158|
   159|function removeOverlay() {
   160|  if (_overlayTimer) { clearInterval(_overlayTimer); _overlayTimer = null; }
   161|  const el = document.getElementById("block-overlay"); if (el) el.remove();
   162|}
   163|
   164|// ====== WebSocket ======
   165|function buildWsUrl(path) { let url = `${WS_URL}${path}`; if (AUTH.token) url += (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(AUTH.token)}`; return url; }
   166|
   167|function connect(wsUrl) {
   168|  const store = Alpine.store("g");
   169|  if (store.ws) store.ws.close();
   170|  store.ws = new WebSocket(wsUrl);
   171|  store.selectedCards = {};
   172|  store.blocked = false;
   173|  removeOverlay();
   174|  store.ws.onopen = () => {};
   175|  store.ws.onmessage = ev => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } handleMsg(msg); };
  store.ws.onclose = () => {
    stopTimers();
    if (store.screen === "game" || store.screen === "char") {
      store.screen = "menu";
      if (store.roomCode && store.gs && !store.gs.gameOver) fetchDisconnectedGames();
    }
  };
   184|  store.ws.onerror = () => {
   185|    if (AUTH.enabled && AUTH.token) { AUTH.token = null; sessionStorage.removeItem("auth_token"); startLogin(); }
   186|    else if (AUTH.enabled) startLogin();
   187|  };
   188|}
   189|
   190|function handleMsg(msg) {
   191|  const store = Alpine.store("g");
   192|  switch (msg.type) {
   193|    case "room_created":
   194|      store.roomCode = msg.code; store.mode = "room";
   195|      store.screen = "lobby"; store.lobbyCode = msg.code; store.lobbyInvite = msg.inviteUrl; break;
   196|    case "waiting":
   197|      store.lobbyStatus = msg.message; break;
   198|    case "character_select":
   199|      store.mode = "room"; store.screen = "char";
   200|      store.characters = msg.characters; store.charTimeout = msg.timeoutSec;
   201|      if (store.charTimer) clearInterval(store.charTimer);
   202|      let s = msg.timeoutSec; store.charTimerText = `${s}s`;
   203|      store.charTimer = setInterval(() => { s--; if (s < 0) { clearInterval(store.charTimer); return; } store.charTimerText = `${s}s`; }, 1000);
   204|      if (msg.opponent && store.mode === "matching") {
   205|        store.charStatus = `对手: ${esc(msg.opponent.displayName)} (ELO ${msg.opponent.elo})`;
   206|        if (msg.elo?.prediction) {
   207|          const p = msg.elo.prediction;
   208|          store.charStatus += ` — ELO ${msg.elo.my} → <span style="color:#22c55e">胜+${p.win}</span> / <span style="color:#ef4444">负${p.lose}</span>`;
   209|        }
   210|      } else { store.charStatus = ""; }
   211|      break;
   212|    case "game_state":
   213|      store.gs = msg.state; store.myIndex = msg.yourIndex;
   214|      if (store.screen !== "game") { store.screen = "game"; clearInterval(store.charTimer); }
   215|      if (msg.eloResult) store.eloResult = msg.eloResult;
   216|      if (store.gs.gameOver) { stopTimers(); }
   217|      break;
   218|    case "disconnected":
   219|      store.blocked = true; stopTimers();
   220|      if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
   221|      createOverlay("⚠ 对手已断线", msg.message, 30, t => `${t} 秒后自动判胜（剩余重连: ${msg.attemptsLeft} 次）`, null, null, true);
   222|      break;
   223|    case "reconnected":
   224|      store.blocked = false; removeOverlay(); break;
   225|    case "queue_status":
   226|      store.mode = "matching"; store.screen = "lobby";
   227|      store.lobbyCode = ""; store.lobbyInvite = "";
   228|      store.matchStartTime = Date.now();
   229|      if (store.matchInterval) clearInterval(store.matchInterval);
   230|      store.lobbyStatus = `匹配中... 排队: ${msg.position} (已匹配 0s)`;
   231|      store.matchInterval = setInterval(() => {
   232|        if (store.mode !== "matching") { clearInterval(store.matchInterval); return; }
   233|        const sec = Math.floor((Date.now() - store.matchStartTime) / 1000);
   234|        store.lobbyStatus = `匹配中... 排队: ${msg.position} (已匹配 ${sec}s)`;
   235|      }, 1000);
   236|      break;
   237|    case "match_found":
   238|      if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
   239|      store.mode = "matching"; store.roomCode = msg.room;
   240|      store.lobbyStatus = `匹配成功！${msg.opponent.displayName} (ELO ${msg.opponent.elo})`;
   241|      connect(buildWsUrl(`?room=${msg.room}`)); break;
   242|    case "queue_timeout":
   243|      if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
   244|      store.screen = "menu"; break;
   245|    case "error":
   246|      if (store.screen === "menu" || store.screen === "lobby") { store.screen = "menu"; }
   247|      break;
   248|  }
   249|}
   250|
   251|// ====== Game actions (called from Alpine) ======
   252|function send(msg) {
   253|  const store = Alpine.store("g");
   254|  if (store.blocked) return;
   255|  if (store.ws?.readyState === WebSocket.OPEN) store.ws.send(JSON.stringify(msg));
   256|}
   257|
   258|function ensureAuth() { if (AUTH.enabled && !AUTH.token) { startLogin(); return false; } return true; }
   259|
   260|let _creating = false;
   261|function createRoom() {
   262|  if (!ensureAuth() || _creating) return;
   263|  _creating = true;
   264|  fetch(`${HTTP_URL}/room/create`).then(r => r.json()).then(info => {
   265|    const store = Alpine.store("g");
   266|    store.roomCode = info.code; store.mode = "room";
   267|    store.screen = "lobby"; store.lobbyCode = info.code; store.lobbyInvite = info.inviteUrl;
   268|    connect(buildWsUrl(`?room=${info.code}`));
   269|  }).finally(() => { _creating = false; });
   270|}
   271|
   272|function joinRoom() {
   273|  if (!ensureAuth()) return;
   274|  const code = document.getElementById("join-code")?.value?.trim()?.toUpperCase();
   275|  if (!code) return;
   276|  joinRoomByCode(code);
   277|}
   278|function joinRoomByCode(code) {
   279|  const store = Alpine.store("g");
   280|  store.roomCode = code; store.mode = "room";
   281|  store.screen = "lobby"; connect(buildWsUrl(`?room=${code}`));
   282|}
   283|function quickMatch() {
   284|  if (!ensureAuth()) return;
   285|  const store = Alpine.store("g");
   286|  store.mode = "matching"; connect(buildWsUrl("?mode=matching"));
   287|}
function leaveLobby() {
  const store = Alpine.store("g");
  if (store.ws) store.ws.close();
  store.screen = "menu";
}
   293|function backToMenu() {
   294|  stopTimers();
   295|  const store = Alpine.store("g");
   296|  if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
   297|  if (store.charTimer) { clearInterval(store.charTimer); store.charTimer = null; }
   298|  if (store.ws) store.ws.close();
   299|  store.ws = null; store.gs = null; store.roomCode = null; store.myIndex = -1;
   300|  store.selectedCards = {}; store.blocked = false; store.matchStartTime = null;
   301|  store.eloResult = null; store._lastLogLen = 0; store._lastPlayId = null; store._lastDiscardKeys = "";
   302|  removeOverlay(); store.screen = "menu";
   303|}
   304|function showLeaderboard() {
   305|  const store = Alpine.store("g");
   306|  fetch(`${HTTP_URL}/leaderboard` + (store.gs?.playerId ? `?userId=${store.gs.playerId}` : ""))
   307|    .then(r => r.json()).then(data => {
   308|      store.lbData = data; store.screen = "leaderboard";
   309|    });
   310|}
   311|
   312|// ====== Timers ======
   313|let _timerInterval = null;
   314|let _pendingTimer = null;
   315|
   316|function stopTimers() {
   317|  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
   318|  if (_pendingTimer) { clearInterval(_pendingTimer); _pendingTimer = null; }
   319|}
   320|
   321|function startPendingTimer(timeout) {
   322|  if (_pendingTimer) clearInterval(_pendingTimer);
   323|  const store = Alpine.store("g");
   324|  _pendingTimer = setInterval(() => {
   325|    const r = Math.max(0, Math.floor((timeout - Date.now()) / 1000));
   326|    store.pendingTimerText = r + "s";
   327|    if (r <= 0) { clearInterval(_pendingTimer); _pendingTimer = null; }
   328|  }, 200);
   329|}
   330|
   331|function stopPendingTimer() {
   332|  if (_pendingTimer) { clearInterval(_pendingTimer); _pendingTimer = null; }
   333|  Alpine.store("g").pendingTimerText = "";
   334|}
   335|
   336|// ====== Init ======
   337|document.addEventListener("alpine:init", () => {
   338|  Alpine.store("g", {
   339|    screen: "menu",
   340|    ws: null, gs: null, myIndex: -1,
   341|    selectedCards: {},  // {cardId: true} for Alpine reactivity
   342|    blocked: false,
   343|    serverTimer: 60, pendingTimerText: "",
   344|    turnTimerText: "",
   345|    roomCode: null, mode: null,
   346|    matchStartTime: null, matchInterval: null,
   347|    eloResult: null,
   348|    charTimer: null, charTimerText: "", charStatus: "",
   349|    characters: [], charTimeout: 0,
   350|    lobbyCode: "", lobbyInvite: "", lobbyStatus: "等待另一位玩家...",
   351|    lbData: null,
   352|    _lastLogLen: 0, _lastPlayId: null, _lastDiscardKeys: "",
   353|
   354|    // Computed helpers
   355|    get isMyTurn() { return this.gs?.turnPlayer === this.myIndex; },
   356|    get opp() { return this.gs?.opponent; },
   357|    get me() { return this.gs?.you; },
   358|    get pending() { return this.gs?.pendingResponse; },
   359|    get isMyResp() { return this.pending && this.pending.target === this.myIndex; },
   360|    get phaseLabel() { return PN[this.gs?.phase] || this.gs?.phase; },
   361|    get cardCount() { return this.selectedCards ? Object.keys(this.selectedCards).length : 0; },
   362|
   363|    // Actions
   364|    toggleCard(id) {
   365|      if (this.blocked) return;
   366|      const isDiscard = this.gs?.phase === "discard" && this.gs?.turnPlayer === this.myIndex;
   367|      const isSkillDiscard = this.pending?.type === "skill_discard" && this.isMyResp;
   368|      const sel = this.selectedCards;
   369|      if (sel[id]) { delete sel[id]; }
   370|      else {
   371|        if (!isDiscard && !isSkillDiscard) { for (const k in sel) delete sel[k]; }
   372|        sel[id] = true;
   373|      }
   374|      this.selectedCards = Object.assign({}, sel); // trigger reactivity
   375|    },
   376|    isCardDisabled(c) {
   377|      if (!this.isMyResp || !this.gs) return false;
   378|      const isDiscard = this.gs.phase === "discard" && this.gs.turnPlayer === this.myIndex;
   379|      if (isDiscard) return false;
   380|      const p = this.pending;
   381|      if (!p) return false;
   382|      // 防御牌在出牌阶段不能主动出
   383|      if (!this.isMyResp && !isDiscard && this.gs.phase === "play" && DEFENSIVE_ONLY.includes(c.name) && this.isMyTurn) return true;
   384|      // 响应阶段检查
   385|      const selectable = RESP_CARDS[p.type];
   386|      if (!selectable) return false; // skill_discard etc — all cards allowed
   387|      if (selectable.includes(c.name)) return false;
   388|      if (p.type === "borrow_knife" && isWeapon(c.name)) return false;
   389|      if (c.name === "免罚券" && ["barbarian", "volley", "duel", "borrow_knife"].includes(p.type)) return false;
   390|      return true;
   391|    },
   392|    disabledReason(c) {
   393|      if (!this.isMyResp || !this.gs) return "";
   394|      const p = this.pending;
   395|      if (!p) return "";
   396|      const selectable = RESP_CARDS[p.type];
   397|      if (!selectable) return "";
   398|      return `需要${selectable.join("或")}`;
   399|    },
   400|    isCardSelected(id) { return !!this.selectedCards[id]; },
   401|
   402|    pickCharacter(id) { send({ action: "pick_character", id }); },
   403|    playSelected() {
   404|      const ids = Object.keys(this.selectedCards);
   405|      if (ids.length === 0 || this.blocked) return;
   406|      send({ action: "play_card", card_id: ids[0], target: this.myIndex === 0 ? 1 : 0 });
   407|      this.selectedCards = {};
   408|    },
   409|    respondCard() {
   410|      const ids = Object.keys(this.selectedCards);
   411|      if (ids.length === 0 || this.blocked) return;
   412|      send({ action: "play_card", card_id: ids[0] });
   413|      this.selectedCards = {};
   414|    },
   415|    doDiscard() {
   416|      const ids = Object.keys(this.selectedCards);
   417|      if (ids.length === 0 || this.blocked) return;
   418|      send({ action: "discard", card_ids: ids });
   419|      this.selectedCards = {};
   420|    },
   421|    doConfirmSkill() {
   422|      const ids = Object.keys(this.selectedCards);
   423|      if (ids.length === 0 || this.blocked) return;
   424|      send({ action: "confirm_skill", card_ids: ids });
   425|      this.selectedCards = {};
   426|    },
   427|    doPass() { send({ action: "pass" }); },
   428|    doEndPhase() { send({ action: "end_phase" }); },
   429|    doUseSkill(skillId) { send({ action: "use_skill", skill_id: skillId }); },
   430|    stealWithAnim(pos) {
   431|      if (this.blocked) return;
   432|      // Animate the clicked card
   433|      const cards = document.querySelectorAll(".steal-card");
   434|      const el = [...cards].find(c => parseInt(c.dataset.pos) === pos);
   435|      if (el) { el.classList.add("steal-fly"); setTimeout(() => el.remove(), 500); }
   436|      cards.forEach(c => c.style.pointerEvents = "none");
   437|      send({ action: "steal_card", position: pos });
   438|    },
   439|    stealPositions() {
   440|      if (!this.pending || this.pending.type !== "steal") return [];
   441|      return Array.from({ length: this.pending.poolSize || 0 }, (_, i) => i + 1);
   442|    },
   443|
   444|    // Pending helpers
   445|    pendingLabel() {
   446|      const p = this.pending; if (!p) return "";
   447|      const label = this.isMyResp ? (RESP_NAMES[p.type] || p.type) : (RESP_NAMES_OPP[p.type] || p.type);
   448|      return typeof label === "function" ? label(p) : label;
   449|    },
   450|    pendingPrefix() { return this.isMyResp ? "你" : "对手"; },
   451|    pendingRemaining() {
   452|      const p = this.pending; if (!p || !p.timeout) return 0;
   453|      return Math.max(0, Math.floor((p.timeout - Date.now()) / 1000));
   454|    },
   455|
   456|    // Game helpers
   457|    oppNameDisplay() { return this.gs?.opponentName || "对手"; },
   458|    myNameDisplay() { return this.gs?.playerName || "你"; },
   459|    isOppTurn() { return this.gs?.turnPlayer !== this.myIndex; },
   460|    needDiscard() {
   461|      if (!this.me || !this.gs) return 0;
   462|      return Math.max(0, this.me.hand.length - (this.gs.handLimit || this.me.hp));
   463|    },
   464|
   465|    // Recent play/discard for center zone
   466|    recentPlayCard() {
   467|      if (!this.gs?.log) return null;
   468|      for (let i = this.gs.log.length - 1; i >= 0; i--) {
   469|        if (this.gs.log[i].id === "card_played") return this.gs.log[i];
   470|      }
   471|      return null;
   472|    },
   473|    recentDiscards() {
   474|      if (!this.gs?.log) return [];
   475|      const d = [];
   476|      for (let i = this.gs.log.length - 1; i >= 0 && d.length < 3; i--) {
   477|        const e = this.gs.log[i];
   478|        if (e.id === "card_discarded" || e.id === "discard") d.unshift(e);
   479|      }
   480|      return d;
   481|    },
   482|    recentSkillUsed() {
   483|      if (!this.gs?.log) return null;
   484|      const last = this.gs.log[this.gs.log.length - 1];
   485|      return last?.id === "skill_used" ? last : null;
   486|    },
   487|    formatLogEntry(e) {
   488|      const p = `P${e.player}`;
   489|      switch (e.id) {
   490|        case "card_played": return `${p} 使用了【${e.cardName}】${e.target !== undefined ? ` → P${e.target}` : ""}`;
   491|        case "card_equipped": return `${p} 装备了【${e.cardName}】`;
   492|        case "damage": return `${p} 受到 ${e.amount} 点伤害`;
   493|        case "heal": return `${p} 回复了 ${e.amount} 点体力`;
   494|        case "skill_used": return `${p} 发动了【${e.skillName}】`;
   495|        case "draw": return `${p} 摸了 ${e.count} 张牌`;
   496|        case "card_discarded": case "discard": return `${p} 弃置了【${e.cardName}】`;
   497|        case "death": return `${p} 阵亡`;
   498|        default: return "";
   499|      }
   500|    },
   501|    gameOverMsg() {
   502|      if (!this.gs?.gameOver) return "";
   503|      const won = this.gs.winner === this.myIndex;
   504|      return { won, title: won ? "🎉 胜利！" : "💀 失败", cls: won ? "win" : "lose" };
   505|    },
   506|  });
   507|});
   508|
   509|// ====== Bootstrap ======
   510|(async () => {
   511|  await initAuth();
   512|  if (AUTH.enabled) { document.getElementById("auth-section")?.classList.remove("hidden"); }
   513|})();
   514|
   515|// Start turn timer (called reactively)
   516|function startTurnTimer(s) {
   517|  stopTimers();
   518|  const store = Alpine.store("g");
   519|  store.serverTimer = s;
   520|  store.turnTimerText = `${s}s`;
   521|  _timerInterval = setInterval(() => {
   522|    store.serverTimer--;
   523|    if (store.serverTimer < 0) store.serverTimer = 0;
   524|    store.turnTimerText = `${store.serverTimer}s`;
   525|  }, 1000);
   526|}
   527|