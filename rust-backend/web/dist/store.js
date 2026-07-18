document.addEventListener("alpine:init", () => {
  Alpine.store("g", {
    screen: "menu",
    ws: null,
    gs: null,
    myIndex: -1,
    selectedCards: {},
    // {cardId: true} for Alpine reactivity
    blocked: false,
    serverTimer: 60,
    pendingTimerText: "",
    turnTimerText: "",
    roomCode: null,
    mode: null,
    matchStartTime: null,
    matchInterval: null,
    eloResult: null,
    charTimer: null,
    charTimerText: "",
    charStatus: "",
    charOpponent: "",
    charEloPrediction: "",
    characters: [],
    charTimeout: 0,
    selectedChar: null,
    charLocked: false,
    opponentPicked: false,
    opponentLocked: false,
    lobbyCode: "",
    lobbyInvite: "",
    lobbyStatus: "\u7B49\u5F85\u53E6\u4E00\u4F4D\u73A9\u5BB6...",
    lbData: null,
    _lastLogLen: 0,
    _lastPlayId: null,
    _lastDiscardKeys: "",
    _playVersion: 0,
    _judgeVersion: 0,
    _pickSelections: {},
    _flashMy: "",
    _flashOpp: "",
    _latency: -1,
    _pingTimer: null,
    // Computed helpers
    get isMyTurn() {
      return this.gs?.turnPlayer === this.myIndex;
    },
    get opp() {
      return this.gs?.opponent;
    },
    get me() {
      return this.gs?.you;
    },
    get pending() {
      return this.gs?.pendingResponse;
    },
    get isMyResp() {
      return this.pending && this.pending.target === this.myIndex;
    },
    get phaseLabel() {
      return PN[this.gs?.phase] || this.gs?.phase;
    },
    get cardCount() {
      return this.selectedCards ? Object.keys(this.selectedCards).length : 0;
    },
    get latency() {
      return this._latency < 0 ? "\u2026" : this._latency + "ms";
    },
    // Actions
    toggleCard(id) {
      if (this.blocked) return;
      if (this.isCardDisabled(this.me?.hand?.find((c) => c.id === id))) return;
      const isDiscard = this.gs?.phase === "discard" && this.gs?.turnPlayer === this.myIndex;
      const isSkillDiscard = this.pending?.type === "skill_discard" && this.isMyResp;
      const sel = this.selectedCards;
      if (sel[id]) delete sel[id];
      else {
        if (isDiscard) {
          const need = this.needDiscard();
          if (Object.keys(sel).length >= need) return;
        }
        if (isSkillDiscard) {
          const need = this.pending?.discardCount || 1;
          if (Object.keys(sel).length >= need) return;
        }
        if (!isDiscard && !isSkillDiscard) {
          for (const k in sel) delete sel[k];
        }
        sel[id] = true;
      }
      this.selectedCards = Object.assign({}, sel);
    },
    isCardDisabled(c) {
      const isDiscard = this.gs?.phase === "discard" && this.gs?.turnPlayer === this.myIndex;
      if (this.pending?.type === "opponent_discard") return false;
      if (!isDiscard && this.gs?.phase === "play" && this.isMyTurn && !this.pending && DEFENSIVE_ONLY.includes(c.name)) return true;
      if (!this.isMyResp || !this.gs || !this.pending) return false;
      if (isDiscard) return false;
      const p = this.pending;
      const selectable = RESP_CARDS[p.type];
      if (!selectable) return false;
      if (selectable.includes(c.name)) return false;
      if (p.type === "borrow_knife" && isWeapon(c.name)) return false;
      if (c.name === "\u514D\u7F5A\u5238" && ["barbarian", "volley", "duel", "borrow_knife"].includes(p.type)) return false;
      return true;
    },
    disabledReason(c) {
      if (!this.isMyResp || !this.gs) return "";
      const p = this.pending;
      if (!p) return "";
      const selectable = RESP_CARDS[p.type];
      if (!selectable) return "";
      return `\u9700\u8981${selectable.join("\u6216")}`;
    },
    isCardSelected(id) {
      return !!this.selectedCards[id];
    },
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
      const sel = this.selectedCards;
      this.selectedCards = {};
      animateCardFly(ids, "#play-discard-zone", () => {
        send({
          action: "play_card",
          card_id: ids[0],
          target: this.myIndex === 0 ? 1 : 0
        });
      });
    },
    respondCard() {
      const ids = Object.keys(this.selectedCards);
      if (ids.length === 0 || this.blocked) return;
      const sel = this.selectedCards;
      this.selectedCards = {};
      animateCardFly(ids, "#play-discard-zone", () => {
        send({ action: "play_card", card_id: ids[0] });
      });
    },
    doDiscard() {
      const ids = Object.keys(this.selectedCards);
      if (ids.length === 0 || this.blocked) return;
      const sel = this.selectedCards;
      this.selectedCards = {};
      animateCardFly(ids, "#play-discard-zone", () => {
        send({ action: "discard", card_ids: ids });
      });
    },
    doConfirmSkill() {
      const ids = Object.keys(this.selectedCards);
      if (ids.length === 0 || this.blocked) return;
      const sel = this.selectedCards;
      this.selectedCards = {};
      animateCardFly(ids, "#play-discard-zone", () => {
        send({ action: "confirm_skill", card_ids: ids });
      });
    },
    doPass() {
      send({ action: "pass" });
    },
    doEndPhase() {
      send({ action: "end_phase" });
    },
    doActivateArmor() {
      send({ action: "activate_armor" });
    },
    // pick_discard（陷害/午饭留堂 — 盲选）
    pickDiscardPoolSize() {
      if (!this.pending || this.pending.type !== "pick_discard") return 0;
      return this.pending.poolSize || 0;
    },
    pickDiscardExposed() {
      if (!this.pending || this.pending.type !== "pick_discard") return [];
      return this.pending.exposedCards || [];
    },
    pickDiscardCount() {
      if (!this.pending || this.pending.type !== "pick_discard") return 0;
      return Object.keys(this._pickSelections).length;
    },
    pickDiscardNeed() {
      return this.pending?.discardCount || 1;
    },
    togglePickCard(pos) {
      if (this.blocked) return;
      const sel = this._pickSelections;
      const need = this.pickDiscardNeed();
      if (sel[pos]) delete sel[pos];
      else {
        if (Object.keys(sel).length >= need) return;
        sel[pos] = true;
      }
      this._pickSelections = Object.assign({}, sel);
    },
    isPickSelected(pos) {
      return !!this._pickSelections[pos];
    },
    doPickDiscard() {
      const positions = Object.keys(this._pickSelections).map(Number);
      if (positions.length !== this.pickDiscardNeed()) return;
      const sel = Object.assign({}, this._pickSelections);
      this._pickSelections = {};
      const cards = positions.map(
        (p) => document.querySelector(`.pick-card[data-pos="${p}"]`)
      ).filter(Boolean);
      const destEl = document.querySelector("#play-discard-zone");
      if (cards.length && destEl) {
        animatePickDiscardFly(cards, destEl, () => {
          send({ action: "pick_discard", positions });
        });
      } else {
        send({ action: "pick_discard", positions });
      }
    },
    doUseSkill(skillId) {
      send({ action: "use_skill", skill_id: skillId });
    },
    stealWithAnim(pos) {
      if (this.blocked) return;
      const cards = document.querySelectorAll(".steal-card");
      cards.forEach((c) => c.style.pointerEvents = "none");
      animateStealFly(pos, () => {
        send({ action: "steal_card", position: pos });
      });
    },
    stealPositions() {
      if (!this.pending || this.pending.type !== "steal") return [];
      return Array.from(
        { length: this.pending.poolSize || 0 },
        (_, i) => i + 1
      );
    },
    // Pending helpers
    pendingLabel() {
      const p = this.pending;
      if (!p) return "";
      const label = this.isMyResp ? RESP_NAMES[p.type] || p.type : RESP_NAMES_OPP[p.type] || p.type;
      return typeof label === "function" ? label(p) : label;
    },
    pendingPrefix() {
      return this.isMyResp ? "\u4F60" : "\u5BF9\u624B";
    },
    pendingRemaining() {
      const p = this.pending;
      if (!p || !p.timeout) return 0;
      return Math.max(0, Math.floor((p.timeout - Date.now()) / 1e3));
    },
    // Game helpers
    oppNameDisplay() {
      return this.gs?.opponentName || "\u5BF9\u624B";
    },
    myNameDisplay() {
      return this.gs?.playerName || "\u4F60";
    },
    isOppTurn() {
      return this.gs?.turnPlayer !== this.myIndex;
    },
    needDiscard() {
      if (!this.me || !this.gs) return 0;
      return Math.max(
        0,
        this.me.hand.length - (this.gs.handLimit || this.me.hp)
      );
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
      if (!this.gs?.log) return "";
      const last = this.gs.log[this.gs.log.length - 1];
      if (!last) return "";
      const who = last.player === this.myIndex ? "\u4F60" : "\u5BF9\u624B";
      switch (last.id) {
        case "card_played":
          return last.target !== void 0 ? `${who} \u5BF9 ${last.target === this.myIndex ? "\u4F60" : "\u5BF9\u624B"} \u4F7F\u7528\u4E86\u3010${last.cardName}\u3011` : `${who} \u4F7F\u7528\u4E86\u3010${last.cardName}\u3011`;
        case "damage":
          return `${who} \u53D7\u5230 ${last.amount} \u70B9\u4F24\u5BB3`;
        case "heal":
          return `${who} \u56DE\u590D\u4E86 ${last.amount} \u70B9\u4F53\u529B`;
        case "skill_used":
          return `${who} \u53D1\u52A8\u4E86\u6280\u80FD\u3010${last.skillName}\u3011`;
        case "draw":
          return `${who} \u6478\u4E86 ${last.count} \u5F20\u724C`;
        case "card_discarded":
        case "discard":
          return `${who} \u5F03\u7F6E\u4E86\u3010${last.cardName}\u3011`;
        case "card_equipped":
          return `${who} \u88C5\u5907\u4E86\u3010${last.cardName}\u3011`;
        case "judge_result":
          return `\u6D82\u6539\u6DB2\u5224\u5B9A\uFF1A${who} \u7FFB\u51FA ${suitSym(last.suit)}\u3010${last.cardName}\u3011\u2192 ${last.result === "success" ? "\u7EA2\u8272\xB7\u95EA\u907F\u6210\u529F \u2705" : "\u9ED1\u8272\xB7\u5224\u5B9A\u5931\u8D25 \u274C"}`;
        case "death":
          return `${who} \u9635\u4EA1`;
        default:
          return "";
      }
    },
    formatLogEntry(e) {
      const p = `P${e.player}`;
      switch (e.id) {
        case "card_played":
          return `${p} \u4F7F\u7528\u4E86\u3010${e.cardName}\u3011${e.target !== void 0 ? ` \u2192 P${e.target}` : ""}`;
        case "card_equipped":
          return `${p} \u88C5\u5907\u4E86\u3010${e.cardName}\u3011`;
        case "damage":
          return `${p} \u53D7\u5230 ${e.amount} \u70B9\u4F24\u5BB3`;
        case "heal":
          return `${p} \u56DE\u590D\u4E86 ${e.amount} \u70B9\u4F53\u529B`;
        case "skill_used":
          return `${p} \u53D1\u52A8\u4E86\u3010${e.skillName}\u3011`;
        case "draw":
          return `${p} \u6478\u4E86 ${e.count} \u5F20\u724C`;
        case "card_discarded":
        case "discard":
          return `${p} \u5F03\u7F6E\u4E86\u3010${e.cardName}\u3011`;
        case "death":
          return `${p} \u9635\u4EA1`;
        case "judge_result":
          return `\u2696 \u5224\u5B9A\uFF1A${p} \u7FFB\u51FA\u3010${e.cardName}\u3011${e.suit} \u2192 ${e.result === "success" ? "\u7EA2\u8272\xB7\u95EA\u907F\u2705" : "\u9ED1\u8272\xB7\u751F\u6548\u274C"}`;
        default:
          return "";
      }
    },
    gameOverMsg() {
      if (!this.gs?.gameOver) return "";
      const won = this.gs.winner === this.myIndex;
      return {
        won,
        title: won ? "\u{1F389} \u80DC\u5229\uFF01" : "\u{1F480} \u5931\u8D25",
        cls: won ? "win" : "lose"
      };
    },
    // 卡牌悬浮提示
    cardTooltip(entry) {
      if (!entry) return "";
      const name = entry.cardName || entry.name || "?";
      const desc = CARD_DESC[name] || "";
      return `${name}${desc ? "\uFF1A" + desc : ""}`;
    }
  });
});
