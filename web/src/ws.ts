// ws.ts — WebSocket 连接和消息处理

function buildWsUrl(path) {
  let url = `${WS_URL}${path}`;
  if (AUTH.token) {
    url += (path.includes("?") ? "&" : "?") +
      `token=${encodeURIComponent(AUTH.token)}`;
  }
  return url;
}

function connect(wsUrl) {
  const store = Alpine.store("g");
  if (store.ws) store.ws.close();
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
      }, 1000);
      if (msg.opponent) {
        store.charOpponent = `对手: ${esc(msg.opponent.displayName)}${
          store.mode === "matching" ? ` (ELO ${msg.opponent.elo})` : ""
        }`;
        store.charEloPrediction = "";
        if (msg.elo?.prediction) {
          const p = msg.elo.prediction;
          store.charEloPrediction =
            `<span style="color:#22c55e">胜 +${p.win}</span> · <span style="color:#ef4444">负 ${p.lose}</span>（你的 ELO ${msg.elo.my}）`;
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

      // 检测新动作 → 触发动画
      const newLogLen = msg.state.log.length;
      if (store._lastLogLen && newLogLen > store._lastLogLen) {
        for (let i = store._lastLogLen; i < newLogLen; i++) {
          const entry = msg.state.log[i];
          const isMine = entry.player === msg.yourIndex;
          if (entry.id === "card_played" && !isMine) {
            animateCardAction(entry, "play", false);
          } else if (
            (entry.id === "card_discarded" || entry.id === "discard") && isMine
          ) {
            animateCardAction(entry, "discard", true);
          } else if (
            (entry.id === "card_discarded" || entry.id === "discard") && !isMine
          ) {
            animateCardAction(entry, "discard", false);
          }
          // 伤害/治疗闪烁
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
      // 同步服务端倒计时
      const st = msg.state;
      if (
        !st.pendingResponse && (st.phase === "play" || st.phase === "discard")
      ) {
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
        "⚠ 对手已断线",
        msg.message,
        30,
        (t) => `${t} 秒后自动判胜（剩余重连: ${msg.attemptsLeft} 次）`,
        null,
        null,
        true,
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
      store.lobbyStatus = `匹配中... 排队: ${msg.position} (已匹配 0s)`;
      store.matchInterval = setInterval(() => {
        if (store.mode !== "matching") {
          clearInterval(store.matchInterval);
          return;
        }
        const sec = Math.floor((Date.now() - store.matchStartTime) / 1000);
        store.lobbyStatus = `匹配中... 排队: ${msg.position} (已匹配 ${sec}s)`;
      }, 1000);
      break;
    case "match_found":
      if (store.matchInterval) {
        clearInterval(store.matchInterval);
        store.matchInterval = null;
      }
      store.mode = "matching";
      store.roomCode = msg.room;
      store.lobbyStatus =
        `匹配成功！${msg.opponent.displayName} (ELO ${msg.opponent.elo})`;
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
        msg.title || "🎉 对手退出",
        msg.message +
          (msg.eloResult
            ? `\nELO ${
              msg.eloResult.change > 0 ? "+" : ""
            }${msg.eloResult.change} → ${msg.eloResult.newElo}`
            : ""),
        5,
        (t) => `${t} 秒后关闭`,
        () => {
          removeOverlay();
        },
        () => {
          removeOverlay();
        },
        true,
        "确认",
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

// ====== Game actions (called from Alpine) ======
function send(msg) {
  const store = Alpine.store("g");
  if (store.blocked) return;
  if (store.ws?.readyState === WebSocket.OPEN) {
    store.ws.send(JSON.stringify(msg));
  }
}
