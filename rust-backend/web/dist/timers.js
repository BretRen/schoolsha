let _timerInterval = null;
let _pendingTimer = null;
let _prevPending = false;
function stopTimers() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
  if (_pendingTimer) {
    clearInterval(_pendingTimer);
    _pendingTimer = null;
  }
}
function stopTurnTimer() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
  Alpine.store("g").turnTimerText = "";
}
function startPendingTimer(timeout) {
  if (_pendingTimer) clearInterval(_pendingTimer);
  const store = Alpine.store("g");
  _pendingTimer = setInterval(() => {
    const r = Math.max(0, Math.floor((timeout - Date.now()) / 1e3));
    store.pendingTimerText = r + "s";
    if (r <= 0) {
      clearInterval(_pendingTimer);
      _pendingTimer = null;
    }
  }, 200);
}
function stopPendingTimer() {
  if (_pendingTimer) {
    clearInterval(_pendingTimer);
    _pendingTimer = null;
  }
  Alpine.store("g").pendingTimerText = "";
}
function resetTimerState() {
  _prevPending = false;
  stopTimers();
}
function startPing() {
  const store = Alpine.store("g");
  if (store._pingTimer) clearInterval(store._pingTimer);
  store._pingTimer = setInterval(() => {
    if (store.ws?.readyState === WebSocket.OPEN) {
      send({ action: "ping", ts: Date.now() });
    }
  }, 3e3);
}
function stopPing() {
  const store = Alpine.store("g");
  if (store._pingTimer) {
    clearInterval(store._pingTimer);
    store._pingTimer = null;
  }
  store._latency = -1;
}
function startTurnTicker() {
  if (_timerInterval) return;
  const store = Alpine.store("g");
  _timerInterval = setInterval(() => {
    store.serverTimer--;
    if (store.serverTimer < 0) store.serverTimer = 0;
    store.turnTimerText = `${store.serverTimer}s`;
  }, 1e3);
}
function startTurnTimer(s) {
  Alpine.store("g").serverTimer = s;
  Alpine.store("g").turnTimerText = `${s}s`;
  startTurnTicker();
}
