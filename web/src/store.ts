// store.ts — Alpine.js 全局状态

// Alpine 从 CDN 异步加载；直接调用 Alpine.store() 会在 Alpine 未就绪时报错
// 用 alpine:init 事件确保 Alpine 初始化后再创建 store
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
    _playVersion: 0, _judgeVersion: 0,
    _pickSelections: {},
    _flashMy: "", _flashOpp: "",
    _latency: -1,
    _pingTimer: null,

    // Computed helpers
    get isMyTurn() { return this.gs?.turnPlayer === this.myIndex; },
    get opp() { return this.gs?.opponent; },
    get me() { return this.gs?.you; },
    get pending() { return this.gs?.pendingResponse; },
    get isMyResp() { return this.pending && this.pending.target === this.myIndex; },
    get phaseLabel() { return PN[this.gs?.phase] || this.gs?.phase; },
    get cardCount() { return this.selectedCards ? Object.keys(this.selectedCards).length : 0; },
    get latency() { return this._latency < 0 ? "…" : this._latency + "ms"; },

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
      const sel = this.selectedCards;
      this.selectedCards = {};
      animateCardFly(ids, "#play-discard-zone", () => {
        send({ action: "play_card", card_id: ids[0], target: this.myIndex === 0 ? 1 : 0 });
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
    doPass() { send({ action: "pass" }); },
    doEndPhase() { send({ action: "end_phase" }); },
    doActivateArmor() { send({ action: "activate_armor" }); },
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
      if (sel[pos]) { delete sel[pos]; }
      else { if (Object.keys(sel).length >= need) return; sel[pos] = true; }
      this._pickSelections = Object.assign({}, sel);
    },
    isPickSelected(pos) { return !!this._pickSelections[pos]; },
    doPickDiscard() {
      const positions = Object.keys(this._pickSelections).map(Number);
      if (positions.length !== this.pickDiscardNeed()) return;
      const sel = Object.assign({}, this._pickSelections);
      this._pickSelections = {};
      // 动画：从选中的盲选牌飞向弃牌区
      const cards = positions.map(p => document.querySelector(`.pick-card[data-pos="${p}"]`)).filter(Boolean);
      const destEl = document.querySelector("#play-discard-zone");
      if (cards.length && destEl) {
        animatePickDiscardFly(cards, destEl, () => {
          send({ action: "pick_discard", positions });
        });
      } else {
        send({ action: "pick_discard", positions });
      }
    },
    doUseSkill(skillId) { send({ action: "use_skill", skill_id: skillId }); },
    stealWithAnim(pos) {
      if (this.blocked) return;
      const cards = document.querySelectorAll(".steal-card");
      cards.forEach(c => c.style.pointerEvents = "none");
      animateStealFly(pos, () => {
        send({ action: "steal_card", position: pos });
      });
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
        case "card_equipped": return `${who} 装备了【${last.cardName}】`;
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
    // 卡牌悬浮提示
    cardTooltip(entry) {
      if (!entry) return "";
      const name = entry.cardName || entry.name || "?";
      const desc = CARD_DESC[name] || "";
      return `${name}${desc ? "：" + desc : ""}`;
    },
  });
});
