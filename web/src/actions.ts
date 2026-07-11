// actions.ts — 游戏操作

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
  store.screen = "lobby";
  const url = buildWsUrl(`?room=${code}`);
  const ws = new WebSocket(url);
  // 用临时 ws 先验证房间是否存在
  ws.onopen = () => { ws.close(); connect(url); };
  ws.onerror = () => { store.screen = "menu"; showToast("房间不存在或无法连接"); };
  setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) { ws.close(); store.screen = "menu"; } }, 5000);
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
  resetTimerState();
  const store = Alpine.store("g");
  if (store.matchInterval) { clearInterval(store.matchInterval); store.matchInterval = null; }
  if (store.charTimer) { clearInterval(store.charTimer); store.charTimer = null; }
  if (store.ws) store.ws.close();
  store.ws = null; store.gs = null; store.roomCode = null; store.myIndex = -1;
  store.selectedCards = {}; store.blocked = false; store.matchStartTime = null;
  store.eloResult = null; store._lastLogLen = 0; store._lastPlayId = null; store._lastDiscardKeys = "";
  store.selectedChar = null; store.charLocked = false;
  store.opponentPicked = false; store.opponentLocked = false;
  _creating = false;
  removeOverlay(); store.screen = "menu";
}
function showLeaderboard() {
  const store = Alpine.store("g");
  fetch(`${HTTP_URL}/leaderboard` + (store.gs?.playerId ? `?userId=${store.gs.playerId}` : ""))
    .then(r => r.json()).then(data => {
      store.lbData = data; store.screen = "leaderboard";
    });
}
