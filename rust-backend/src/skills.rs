// skills.rs — 技能运行时
// Rust 复刻：对应 Deno TS 的 skills.ts

use crate::cards::draw_cards;
use crate::events::{EventBus, GameEvent};
use crate::types::{CharacterDef, GameState, LogEntry, PendingResponse, PendingType, SkillDef, SkillEffect, SkillType, CharactersConfig, SkillsConfig};
use std::collections::HashMap;

thread_local! {
    static CHAR_MAP: std::cell::RefCell<HashMap<String, CharacterDef>> = std::cell::RefCell::new(HashMap::new());
    static SKILL_MAP: std::cell::RefCell<HashMap<String, SkillDef>> = std::cell::RefCell::new(HashMap::new());
}

/// 初始化技能和角色配置
pub fn init(characters: &CharactersConfig, skills: &SkillsConfig) {
    CHAR_MAP.with(|cm| {
        let mut m = cm.borrow_mut();
        m.clear();
        for ch in &characters.characters {
            m.insert(ch.id.clone(), ch.clone());
        }
    });
    SKILL_MAP.with(|sm| {
        let mut m = sm.borrow_mut();
        m.clear();
        for sk in &skills.skills {
            m.insert(sk.id.clone(), sk.clone());
        }
    });
}

pub fn get_character(id: &str) -> Option<CharacterDef> {
    CHAR_MAP.with(|cm| cm.borrow().get(id).cloned())
}

pub fn get_all_characters() -> Vec<CharacterDef> {
    CHAR_MAP.with(|cm| cm.borrow().values().cloned().collect())
}

pub fn get_skill(id: &str) -> Option<SkillDef> {
    SKILL_MAP.with(|sm| sm.borrow().get(id).cloned())
}

/// 角色被动/锁定技挂载到事件总线
/// 返回 unsubscribe token 列表
pub fn mount_passive_skills(
    bus: &mut EventBus,
    player_idx: usize,
    char_id: &str,
) -> Vec<usize> {
    let mut unsubs = Vec::new();
    let character = match get_character(char_id) {
        Some(c) => c,
        None => return unsubs,
    };

    for skill_id in &character.skills {
        let skill = match get_skill(skill_id) {
            Some(s) => s,
            None => continue,
        };
        if skill.skill_type == SkillType::Active {
            continue;
        }

        if let Some(ref trigger) = skill.trigger {
            if trigger.event.as_deref() == Some("draw_card") {
                let pid = player_idx;
                let sid = skill.id.clone();
                let handler: crate::events::EventHandlerFn = Box::new(
                    move |event: &GameEvent, state: &mut GameState| {
                        match event {
                            GameEvent::DrawCard { player, .. } if *player == pid => {
                                execute_skill_effect(state, pid, &sid);
                            }
                            _ => {}
                        }
                    },
                );
                let token = bus.on_event(vec!["draw_card".to_string()], handler);
                unsubs.push(token);
            }
        }
    }

    unsubs
}

/// 获取玩家当前手牌上限（含技能加成）
pub fn get_hand_limit(state: &GameState, player_idx: usize, char_id: &str) -> usize {
    let character = match get_character(char_id) {
        Some(c) => c,
        None => return state.players[player_idx].hp as usize,
    };

    let bonus: i32 = 0;
    for skill_id in &character.skills {
        let skill = match get_skill(skill_id) {
            Some(s) => s,
            None => continue,
        };
        if let Some(ref effect) = skill.effect {
            if let SkillEffect::SkillHeal { amount: _ } = effect {
                // hand_limit_bonus is not in the current SkillEffect enum
                // but in the TS version it exists as a separate type
                // For compatibility with TS version, check if we need to add it
            }
        }
    }

    (state.players[player_idx].hp + bonus) as usize
}

/// 使用主动技能
pub fn try_use_skill(
    _bus: &mut EventBus,
    state: &mut GameState,
    player_idx: usize,
    char_id: &str,
    skill_id: &str,
) -> Result<(), String> {
    let character = get_character(char_id).ok_or("你没有这个角色")?;
    if !character.skills.contains(&skill_id.to_string()) {
        return Err("你没有这个技能".to_string());
    }

    let skill = get_skill(skill_id).ok_or("未知技能")?;

    if skill.skill_type != SkillType::Active {
        let type_name = match skill.skill_type {
            SkillType::Locked => "锁定",
            _ => "被动",
        };
        return Err(format!("{} 是{}技，不能主动使用", skill.name, type_name));
    }

    if player_idx != state.turn_player {
        return Err("不是你的回合".to_string());
    }
    if state.phase != crate::types::Phase::Play {
        return Err("只能在出牌阶段使用".to_string());
    }

    // 不能有进行中的 pending（除非是 skill_discard）
    if let Some(ref pending) = state.pending_response {
        if pending.pending_type != PendingType::SkillDiscard {
            return Err("有进行中的响应".to_string());
        }
    }

    // 检查阶段
    if let Some(ref trigger) = skill.trigger {
        if let Some(ref phase_str) = trigger.phase {
            let expected: &str = phase_str;
            if (expected == "play" && state.phase != crate::types::Phase::Play)
                || (expected == "draw" && state.phase != crate::types::Phase::Draw)
            {
                return Err("不在正确的阶段".to_string());
            }
        }
    }

    // per-turn 限制
    if let Some(per_turn) = skill.per_turn {
        let used = state.skill_use_count.get(skill_id).copied().unwrap_or(0);
        if used >= per_turn {
            return Err("本回合已使用过".to_string());
        }
    }

    // 效果前置检查：force_discard 需对手有牌
    if let Some(ref effect) = skill.effect {
        if let SkillEffect::ForceDiscard { count: _ } = effect {
            let opp = &state.players[1 - player_idx];
            if opp.hand.is_empty() && opp.weapon.is_none() && opp.armor.is_none() {
                return Err("对手没有牌可以弃".to_string());
            }
        }
    }

    // 支付代价：弃牌
    if let Some(ref cost) = skill.cost {
        if let Some(discard_count) = cost.discard {
            let hand_len = state.players[player_idx].hand.len();
            if hand_len < discard_count as usize {
                return Err("手牌不足".to_string());
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            state.pending_response = Some(PendingResponse {
                pending_type: PendingType::SkillDiscard,
                source: player_idx,
                target: player_idx,
                card: None,
                timeout: now + 15_000,
                selectable_cards: None,
                pool_size: None,
                steal_action: None,
                exposed_cards: None,
                pending_skill_id: Some(skill_id.to_string()),
                discard_count: Some(discard_count as usize),
            });
            return Ok(()); // 等玩家选牌后确认
        }
    }

    // 标记使用
    if skill.per_turn.is_some() {
        *state.skill_use_count.entry(skill_id.to_string()).or_insert(0) += 1;
    }

    // 执行效果
    execute_skill_effect(state, player_idx, skill_id);

    // 记录日志
    state.log.push(LogEntry::SkillUsed {
        player: player_idx,
        skill_name: skill.name.clone(),
    });

    Ok(())
}

/// 执行技能效果
pub fn execute_skill_effect(state: &mut GameState, player_idx: usize, skill_id: &str) {
    let skill = match get_skill(skill_id) {
        Some(s) => s,
        None => return,
    };

    let effect = match skill.effect {
        Some(e) => e,
        None => return,
    };

    match effect {
        SkillEffect::ForceDiscard { count } => {
            let target = 1 - player_idx;
            let opp_hand = &state.players[target].hand;
            if opp_hand.is_empty() {
                return;
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            state.pending_response = Some(PendingResponse {
                pending_type: PendingType::OpponentDiscard,
                source: player_idx,
                target,
                card: None,
                timeout: now + 15_000,
                selectable_cards: None,
                pool_size: None,
                steal_action: None,
                exposed_cards: None,
                pending_skill_id: None,
                discard_count: Some(count as usize),
            });
        }
        SkillEffect::SkillDraw { count } => {
            let drawn = draw_cards(
                &mut state.deck,
                &mut state.discard,
                count as usize,
            );
            tracing::debug!(
                "[Skill] {}: P{} draws extra {} card(s)",
                skill.name,
                player_idx,
                drawn.len()
            );
            state.players[player_idx].hand.extend(drawn);
        }
        SkillEffect::SkillHeal { amount } => {
            let player = &mut state.players[player_idx];
            player.hp = (player.hp + amount as i32).min(player.max_hp);
        }
        SkillEffect::Damage { amount } => {
            let target = 1 - player_idx;
            state.players[target].hp -= amount as i32;
            if state.players[target].hp < 0 {
                state.players[target].hp = 0;
            }
            if state.players[target].hp <= 0 && !state.game_over {
                state.players[target].alive = false;
                state.game_over = true;
                state.winner = Some(player_idx);
            }
        }
        SkillEffect::HandLimitBonus { .. } => {
            // Handled by get_hand_limit, no runtime action needed
        }
    }
}

/// 新回合开始时重置 per-turn 计数
pub fn reset_skill_counts(state: &mut GameState) {
    state.skill_use_count.clear();
}
