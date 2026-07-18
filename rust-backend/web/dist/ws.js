function buildWsUrl(path) {
  let url = `${WS_URL}${path}`;
  if (AUTH.token) {
    url += (path.includes("?") ? "&" : "?") + `token=${encodeURIComponent(AUTH.token)}`;
  }
  return url;
}
function connect(wsUrl) {
  const store = Alpine.store("g");
  if (store.ws) {
    if (store.ws.readyState === WebSocket.OPEN) store.ws.close();
    store.ws = null;
  }
  store.ws = new WebSocket(wsUrl);
  store.selectedCards = {};
  store.blocked = false;
  removeOverlay();
  store.ws.onopen = () => {
    startPing();
  };
  store.ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMsg(msg);
  };
  store.ws.onclose = () => {
    stopPing();
    stopTimers();
    if (store.matchInterval) {
      clearInterval(store.matchInterval);
      store.matchInterval = null;
    }
    if (store.screen === "lobby" && store.mode === "matching") {
      store.screen = "menu";
      store.lobbyStatus = "";
    }
    if (store.screen === "game" || store.screen === "char") {
      if (store.roomCode && store.gs && !store.gs.gameOver) {
        fetchDisconnectedGames();
      }
    }
  };
  store.ws.onerror = () => {
    if (AUTH.enabled && AUTH.token) {
      AUTH.token = null;
      sessionStorage.removeItem("auth_token");
      startLogin();
    } else if (AUTH.enabled) startLogin();
  };
}
function handleMsg(msg) {
  const store = Alpine.store("g");
  switch (msg.type) {
    case "room_created":
      store.roomCode = msg.code;
      store.mode = "room";
      store.screen = "lobby";
      store.lobbyCode = msg.code;
      store.lobbyInvite = msg.inviteUrl;
      break;
    case "waiting":
      store.lobbyStatus = msg.message;
      break;
    case "character_select":
      store.mode = store.mode || "room";
      store.screen = "char";
      store.characters = msg.characters;
      store.charTimeout = msg.timeoutSec;
      store.selectedChar = null;
      store.charLocked = false;
      store.opponentPicked = false;
      store.opponentLocked = false;
      if (store.charTimer) clearInterval(store.charTimer);
      let s = msg.timeoutSec;
      store.charTimerText = `${s}s`;
      store.charTimer = setInterval(() => {
        s--;
        if (s < 0) {
          clearInterval(store.charTimer);
          return;
        }
        store.charTimerText = `${s}s`;
      }, 1e3);
      if (msg.opponent) {
        store.charOpponent = `\u5BF9\u624B: ${esc(msg.opponent.displayName)}${store.mode === "matching" ? ` (ELO ${msg.opponent.elo})` : ""}`;
        store.charEloPrediction = "";
        if (msg.elo?.prediction) {
          const p = msg.elo.prediction;
          store.charEloPrediction = `<span style="color:#22c55e">\u80DC +${p.win}</span> \xB7 <span style="color:#ef4444">\u8D1F ${p.lose}</span>\uFF08\u4F60\u7684 ELO ${msg.elo.my}\uFF09`;
        }
      } else {
        store.charOpponent = "";
        store.charEloPrediction = "";
      }
      break;
    case "game_state":
      store.gs = msg.state;
      store.myIndex = msg.yourIndex;
      store._playVersion++;
      store._judgeVersion++;
      if (store._lastTurnPlayer !== void 0 && store._lastTurnPlayer !== msg.state.turnPlayer) {
        showTurnBanner(msg.state.turnPlayer === msg.yourIndex);
      }
      store._lastTurnPlayer = msg.state.turnPlayer;
      const newLogLen = msg.state.log.length;
      if (store._lastLogLen && newLogLen > store._lastLogLen) {
        for (let i = store._lastLogLen; i < newLogLen; i++) {
          const entry = msg.state.log[i];
          const isMine = entry.player === msg.yourIndex;
          if (entry.id === "card_played" && !isMine) {
            animateCardAction(entry, "play", false);
          } else if ((entry.id === "card_discarded" || entry.id === "discard") && isMine) {
            animateCardAction(entry, "discard", true);
          } else if ((entry.id === "card_discarded" || entry.id === "discard") && !isMine) {
            animateCardAction(entry, "discard", false);
          }
          if (entry.id === "damage") {
            const targetMe = entry.player === msg.yourIndex;
            if (targetMe) {
              store._flashMy = "dmg";
              setTimeout(() => {
                store._flashMy = "";
              }, 700);
            } else {
              store._flashOpp = "dmg";
              setTimeout(() => {
                store._flashOpp = "";
              }, 700);
            }
          } else if (entry.id === "heal") {
            const targetMe = entry.player === msg.yourIndex;
            if (targetMe) {
              store._flashMy = "heal";
              setTimeout(() => {
                store._flashMy = "";
              }, 700);
            } else {
              store._flashOpp = "heal";
              setTimeout(() => {
                store._flashOpp = "";
              }, 700);
            }
          }
        }
      }
      store._lastLogLen = newLogLen;
      const st = msg.state;
      if (!st.pendingResponse && (st.phase === "play" || st.phase === "discard")) {
        store.serverTimer = st.turnTimeLeft;
        store.turnTimerText = `${st.turnTimeLeft}s`;
        if (!_timerInterval) startTurnTicker();
      }
      if (store.gs?.pendingResponse?.type !== "pick_discard") {
        store._pickSelections = {};
      }
      if (store.screen !== "game") {
        store.screen = "game";
        clearInterval(store.charTimer);
      }
      if (msg.eloResult) store.eloResult = msg.eloResult;
      if (store.gs.gameOver) {
        resetTimerState();
        store._pickSelections = {};
      }
      break;
    case "disconnected":
      store.blocked = true;
      stopTimers();
      if (store.matchInterval) {
        clearInterval(store.matchInterval);
        store.matchInterval = null;
      }
      createOverlay(
        "\u26A0 \u5BF9\u624B\u5DF2\u65AD\u7EBF",
        msg.message,
        30,
        (t) => `${t} \u79D2\u540E\u81EA\u52A8\u5224\u80DC\uFF08\u5269\u4F59\u91CD\u8FDE: ${msg.attemptsLeft} \u6B21\uFF09`,
        null,
        null,
        true
      );
      break;
    case "reconnected":
      store.blocked = false;
      removeOverlay();
      break;
    case "queue_status":
      store.mode = "matching";
      store.screen = "lobby";
      store.lobbyCode = "";
      store.lobbyInvite = "";
      store.matchStartTime = Date.now();
      if (store.matchInterval) clearInterval(store.matchInterval);
      store.lobbyStatus = `\u5339\u914D\u4E2D... \u6392\u961F: ${msg.position} (\u5DF2\u5339\u914D 0s)`;
      store.matchInterval = setInterval(() => {
        if (store.mode !== "matching") {
          clearInterval(store.matchInterval);
          return;
        }
        const sec = Math.floor((Date.now() - store.matchStartTime) / 1e3);
        store.lobbyStatus = `\u5339\u914D\u4E2D... \u6392\u961F: ${msg.position} (\u5DF2\u5339\u914D ${sec}s)`;
      }, 1e3);
      break;
    case "match_found":
      if (store.matchInterval) {
        clearInterval(store.matchInterval);
        store.matchInterval = null;
      }
      store.mode = "matching";
      store.roomCode = msg.room;
      store.lobbyStatus = `\u5339\u914D\u6210\u529F\uFF01${msg.opponent.displayName} (ELO ${msg.opponent.elo})`;
      connect(buildWsUrl(`?room=${msg.room}`));
      break;
    case "queue_timeout":
      if (store.matchInterval) {
        clearInterval(store.matchInterval);
        store.matchInterval = null;
      }
      store.screen = "menu";
      break;
    case "opponent_picked":
      store.opponentPicked = msg.picked;
      break;
    case "opponent_locked":
      store.opponentLocked = msg.locked;
      break;
    case "opponent_left_win":
      store.screen = "menu";
      if (msg.eloResult) store.eloResult = msg.eloResult;
      createOverlay(
        msg.title || "\u{1F389} \u5BF9\u624B\u9000\u51FA",
        msg.message + (msg.eloResult ? `
ELO ${msg.eloResult.change > 0 ? "+" : ""}${msg.eloResult.change} \u2192 ${msg.eloResult.newElo}` : ""),
        5,
        (t) => `${t} \u79D2\u540E\u5173\u95ED`,
        () => {
          removeOverlay();
        },
        () => {
          removeOverlay();
        },
        true,
        "\u786E\u8BA4"
      );
      break;
    case "opponent_reconnected":
      removeOverlay();
      break;
    case "error":
      showToast(msg.message);
      break;
    case "pong":
      store._latency = Date.now() - msg.ts;
      break;
  }
}
function send(msg) {
  const store = Alpine.store("g");
  if (store.blocked) return;
  if (store.ws?.readyState === WebSocket.OPEN) {
    store.ws.send(JSON.stringify(msg));
  }
}
