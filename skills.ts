// ============================================================
// skills.ts — 技能运行时（加载技能 JSON + 注册事件处理器）
// ============================================================

import type { GameState } from "./types.ts";
import { onEvent, emit } from "./events.ts";
import { drawCards } from "./cards.ts";
import { addLog } from "./effects.ts";
import charactersConfig from "./characters.json" with { type: "json" };
import skillsConfig from "./skills.json" with { type: "json" };

// ---------- JSON 配置类型 ----------

export interface CharacterDef {
  id: string;
  name: string;
  maxHp: number;
  skills: string[];
}

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  type: "active" | "passive" | "locked";
  trigger?: { event?: string; phase?: string };
  cost?: { discard?: number };
  effect: SkillEffect;
  perTurn?: number;
}

export type SkillEffect =
  | { type: "force_discard"; target: "opponent"; count: number }
  | { type: "hand_limit_bonus"; amount: number }
  | { type: "draw_cards"; count: number }
  | { type: "heal"; amount: number }
  | { type: "damage"; target: "opponent"; amount: number };

// ---------- 运行时 ----------

const charMap = new Map<string, CharacterDef>();
const skillMap = new Map<string, SkillDef>();

// 技能已使用次数（per-turn 限制）— 已迁移到 GameState.skillUseCount

(function load() {
  for (const ch of (charactersConfig as { characters: CharacterDef[] }).characters) {
    charMap.set(ch.id, ch);
  }
  for (const sk of (skillsConfig as { skills: SkillDef[] }).skills) {
    skillMap.set(sk.id, sk);
  }
})();

export function getCharacter(id: string): CharacterDef | undefined {
  return charMap.get(id);
}

export function getAllCharacters(): CharacterDef[] {
  return [...charMap.values()];
}

export function getSkill(id: string): SkillDef | undefined {
  return skillMap.get(id);
}

/** 角色被动/锁定技挂载到事件总线 */
export function mountPassiveSkills(
  _state: GameState,
  playerIdx: number,
  charId: string,
): (() => void)[] {
  const char = getCharacter(charId);
  if (!char) return [];

  const unsubs: (() => void)[] = [];

  for (const skillId of char.skills) {
    const skill = getSkill(skillId);
    if (!skill) continue;
    if (skill.type === "active") continue; // active skills don't auto-register

    if (skill.trigger?.event === "draw_card") {
      const unsub = onEvent(["draw_card"], (event, _s) => {
        if (event.type !== "draw_card") return;
        if (event.player !== playerIdx) return;
        executeSkillEffect(_s, playerIdx, skill);
      });
      unsubs.push(unsub);
    }
  }

  return unsubs;
}

/** 获取玩家当前手牌上限（含技能加成） */
export function getHandLimit(state: GameState, playerIdx: number, charId: string): number {
  const char = getCharacter(charId);
  if (!char) return state.players[playerIdx].hp;

  let bonus = 0;
  for (const skillId of char.skills) {
    const skill = getSkill(skillId);
    if (!skill) continue;
    if (skill.effect.type === "hand_limit_bonus") {
      bonus += skill.effect.amount;
    }
  }

  return state.players[playerIdx].hp + bonus;
}

/** 使用主动技能 */
export function tryUseSkill(
  state: GameState,
  playerIdx: number,
  charId: string,
  skillId: string,
): string | null {
  const char = getCharacter(charId);
  if (!char || !char.skills.includes(skillId)) return "你没有这个技能";

  const skill = getSkill(skillId);
  if (!skill) return "未知技能";

  if (skill.type !== "active") return `${skill.name} 是${skill.type === "locked" ? "锁定" : "被动"}技，不能主动使用`;

  // 检查阶段
  if (skill.trigger?.phase && state.phase !== skill.trigger.phase) {
    return "不在正确的阶段";
  }

  // per-turn 限制
  if (skill.perTurn) {
    const used = state.skillUseCount[skillId] ?? 0;
    if (used >= skill.perTurn) return "本回合已使用过";
  }

  // 支付代价：弃牌
  if (skill.cost?.discard) {
    const hand = state.players[playerIdx].hand;
    if (hand.length < skill.cost.discard) return "手牌不足";
    // 从手牌随机弃（后续可改为玩家自选）
    for (let i = 0; i < skill.cost.discard; i++) {
      const card = hand.pop()!;
      state.discard.push(card);
    }
  }

  // 标记使用
  if (skill.perTurn) {
    state.skillUseCount[skillId] = (state.skillUseCount[skillId] ?? 0) + 1;
  }

  // 执行效果
  executeSkillEffect(state, playerIdx, skill);
  addLog(state, { id: "skill_used", player: playerIdx, skillName: skill.name });

  return null;
}

function executeSkillEffect(state: GameState, playerIdx: number, skill: SkillDef) {
  const effect = skill.effect;

  switch (effect.type) {
    case "force_discard": {
      const target = 1 - playerIdx;
      const hand = state.players[target].hand;
      if (hand.length === 0) break;
      const idx = Math.floor(Math.random() * hand.length);
      const card = hand.splice(idx, 1)[0];
      state.discard.push(card);
      break;
    }
    case "draw_cards": {
      // 被动技：额外摸牌（不触发递归事件）
      const { drawn, deck, discard } = drawCards(state.deck, state.discard, effect.count);
      state.deck = deck;
      state.discard = discard;
      state.players[playerIdx].hand.push(...drawn);
      console.log(
        `[Skill] ${skill.name}: P${playerIdx} draws extra ${drawn.length} card(s)`,
      );
      break;
    }
    case "heal": {
      state.players[playerIdx].hp = Math.min(
        state.players[playerIdx].hp + effect.amount,
        state.players[playerIdx].maxHp,
      );
      break;
    }
    case "damage": {
      const target = 1 - playerIdx;
      state.players[target].hp -= effect.amount;
      if (state.players[target].hp < 0) state.players[target].hp = 0;
      emit({ type: "damage", source: playerIdx, target, amount: effect.amount }, state);
      if (state.players[target].hp <= 0 && !state.gameOver) {
        state.players[target].alive = false;
        state.gameOver = true;
        state.winner = playerIdx;
        emit({ type: "player_death", player: target }, state);
      }
      break;
    }
  }
}

/** 新回合开始时重置 per-turn 计数 */
export function resetSkillCounts(state: GameState) {
  state.skillUseCount = {};
}
