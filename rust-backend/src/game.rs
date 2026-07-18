// game.rs — 阶段机 + 游戏状态管理 + 消息处理
// Rust 复刻：对应 Deno TS 的 game.ts

use crate::cards::{create_deck, draw_cards};
use crate::effects::{
    add_log, handle_activate_armor, handle_confirm_skill,
    handle_steal_card, handle_timeout, try_use_card,
};
use crate::events::EventBus;
use crate::skills::{
    get_character, get_hand_limit, get_skill, mount_passive_skills, reset_skill_counts,
    try_use_skill,
};
use crate::types::{
    CardsConfig, ClientMsg, GameState, LogEntry, Phase, Player, PlayerView,
    ServerStateView, SkillView,
};
use rand::Rng;

pub const TURN_TIMEOUT_SEC: u64 = 45;
const TURN_TIMEOUT_MS: u64 = TURN_TIMEOUT_SEC * 1000;
const MAX_DISCONNECTS: u32 = 3;
const RECONNECT_WINDOW_MS: u64 = 30_000;

// ============================================================
// 创建新游戏
// ============================================================

pub fn create_game(bus: &mut EventBus, picks: &[String; 2], cards_config: &CardsConfig) -> GameState {
    bus.clear_all();

    let mut deck = create_deck(cards_config);
    crate::cards::shuffle(&mut deck);

    let char0 = get_character(&picks[0]);
    let char1 = get_character(&picks[1]);

    let mut players: [Player; 2] = [
        Player {
            hp: char0.as_ref().map_or(3, |c| c.max_hp),
            max_hp: char0.as_ref().map_or(3, |c| c.max_hp),
            hand: vec![],
            alive: true,
            character_id: Some(picks[0].clone()),
            weapon: None,
            armor: None,
        },
        Player {
            hp: char1.as_ref().map_or(3, |c| c.max_hp),
            max_hp: char1.as_ref().map_or(3, |c| c.max_hp),
            hand: vec![],
            alive: true,
            character_id: Some(picks[1].clone()),
            weapon: None,
            armor: None,
        },
    ];

    let r1 = draw_cards(&mut deck, &mut vec![], 4);
    players[0].hand = r1;
    let r2 = draw_cards(&mut deck, &mut vec![], 4);
    players[1].hand = r2;

    let turn_player = if rand::thread_rng().gen_bool(0.5) { 0 } else { 1 };

    let mut state = GameState {
        phase: Phase::Judge,
        turn_player,
        players,
        deck,
        discard: vec![],
        attack_used: false,
        pending_response: None,
        game_over: false,
        winner: None,
        turn_start_time: now_ms(),
        disconnect_count: [0, 0],
        disconnected_at: [None, None],
        wine_used: [false, false],
        skip_next_play: None,
        skill_use_count: std::collections::HashMap::new(),
        log: vec![],
    };

    if !picks[0].is_empty() {
        mount_passive_skills(bus, 0, &picks[0]);
    }
    if !picks[1].is_empty() {
        mount_passive_skills(bus, 1, &picks[1]);
    }

    state.log.push(LogEntry::Phase { player: turn_player, phase: "game_start".into() });

    advance_phase_full(bus, &mut state);
    state
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

// ============================================================
// 阶段流转
// ============================================================

pub fn advance_phase(state: &mut GameState) {
    // Simple advance used by effects (e.g., 熬夜复习)
    // But effects don't have EventBus, so use the simple version
    if state.game_over || state.pending_response.is_some() {
        return;
    }
    advance_phase_simple(state);
}

fn advance_phase_full(bus: &mut EventBus, state: &mut GameState) {
    if state.game_over || state.pending_response.is_some() {
        return;
    }
    advance_phase_simple(state);
    enter_phase(bus, state);
}

fn advance_phase_simple(state: &mut GameState) {
    match state.phase {
        Phase::Judge => state.phase = Phase::Draw,
        Phase::Draw => state.phase = Phase::Play,
        Phase::Play => state.phase = Phase::Discard,
        Phase::Discard => state.phase = Phase::End,
        Phase::End => {} // handled by enter_phase
    }
}

fn enter_phase(bus: &mut EventBus, state: &mut GameState) {
    match state.phase {
        Phase::Draw => {
            let drawn = draw_cards(&mut state.deck, &mut state.discard, 2);
            state.players[state.turn_player].hand.extend(drawn.clone());
            bus.emit(
                crate::events::GameEvent::DrawCard {
                    player: state.turn_player,
                    cards: drawn,
                },
                state,
            );
            advance_phase_full(bus, state);
        }
        Phase::Play => {
            // 请家长：跳过出牌阶段
            if state.skip_next_play == Some(state.turn_player) {
                state.skip_next_play = None;
                advance_phase_full(bus, state);
                return;
            }
            state.turn_start_time = now_ms();
        }
        Phase::Discard => {
            state.turn_start_time = now_ms();
            let player = &state.players[state.turn_player];
            let limit = get_hand_limit(state, state.turn_player, player.character_id.as_deref().unwrap_or(""));
            if player.hand.len() <= limit {
                advance_phase_full(bus, state);
            }
        }
        Phase::End => {
            bus.emit(
                crate::events::GameEvent::TurnEnd {
                    player: state.turn_player,
                },
                state,
            );
            state.turn_player = 1 - state.turn_player;
            state.attack_used = false;
            state.phase = Phase::Judge;
            reset_skill_counts(state);
            state.turn_start_time = now_ms();
            bus.emit(
                crate::events::GameEvent::TurnStart {
                    player: state.turn_player,
                },
                state,
            );
            // enter judge -> advance to draw -> enter draw -> advance to play
            advance_phase_full(bus, state);
        }
        Phase::Judge => {
            // Just advance immediately
            advance_phase_full(bus, state);
        }
    }
}

// ============================================================
// 消息处理
// ============================================================

pub fn handle_message(
    bus: &mut EventBus,
    state: &mut GameState,
    player_idx: usize,
    msg: &ClientMsg,
) -> Result<(), String> {
    if state.game_over {
        return Err("游戏已结束".into());
    }
    if anyone_disconnected(state) {
        return Err("等待对手重连...".into());
    }

    match msg {
        ClientMsg::PlayCard { card_id, target } => {
            handle_play_card(state, player_idx, card_id, *target)
        }
        ClientMsg::UseSkill { skill_id, target: _ } => {
            handle_use_skill(bus, state, player_idx, skill_id)
        }
        ClientMsg::EndPhase => {
            if player_idx != state.turn_player {
                return Err("不是你的回合".into());
            }
            if state.phase != Phase::Play {
                return Err("只能在出牌阶段手动结束".into());
            }
            advance_phase_full(bus, state);
            Ok(())
        }
        ClientMsg::Discard { card_ids } => {
            // 对手技能弃牌
            if let Some(ref pending) = state.pending_response {
                if pending.pending_type == crate::types::PendingType::OpponentDiscard
                    && player_idx == pending.target
                {
                    return handle_opponent_discard(state, player_idx, card_ids);
                }
            }
            if player_idx != state.turn_player {
                return Err("不是你的回合".into());
            }
            if state.phase != Phase::Discard {
                return Err("不在弃牌阶段".into());
            }
            handle_discard(bus, state, player_idx, card_ids)
        }
        ClientMsg::Pass => {
            if state.pending_response.is_none() {
                return Err("没有需要响应的".into());
            }
            if player_idx != state.pending_response.as_ref().unwrap().target {
                return Err("不是你需要响应".into());
            }
            handle_timeout(state);
            state.turn_start_time = now_ms();
            Ok(())
        }
        ClientMsg::StealCard { card_id: _, position } => {
            handle_steal_card(state, player_idx, *position)
        }
        ClientMsg::ConfirmSkill { card_ids } => {
            handle_confirm_skill(state, player_idx, card_ids)
        }
        ClientMsg::ActivateArmor => {
            handle_activate_armor(state, player_idx)
        }
        ClientMsg::Ping { .. } => Ok(()), // ping handled by server, not game
        _ => Err(format!("未知操作: {}", msg.action_name())),
    }
}

fn handle_play_card(
    state: &mut GameState,
    player_idx: usize,
    card_id: &str,
    target: Option<usize>,
) -> Result<(), String> {
    let err = try_use_card(state, player_idx, card_id, target);
    if let Err(e) = err {
        return Err(e);
    }
    state.turn_start_time = now_ms();
    Ok(())
}

fn handle_use_skill(
    bus: &mut EventBus,
    state: &mut GameState,
    player_idx: usize,
    skill_id: &str,
) -> Result<(), String> {
    let char_id = state.players[player_idx]
        .character_id
        .clone()
        .ok_or("你没有选择角色")?;
    try_use_skill(bus, state, player_idx, &char_id, skill_id)
}

fn handle_discard(
    bus: &mut EventBus,
    state: &mut GameState,
    player_idx: usize,
    card_ids: &[String],
) -> Result<(), String> {
    let char_id = state.players[player_idx].character_id.clone().unwrap_or_default();
    let limit = get_hand_limit(state, player_idx, &char_id);
    let need_discard = state.players[player_idx].hand.len().saturating_sub(limit);

    if need_discard == 0 {
        advance_phase_full(bus, state);
        return Ok(());
    }

    if card_ids.len() < need_discard {
        return Err(format!("需要弃 {} 张牌，只选了 {} 张", need_discard, card_ids.len()));
    }

    let mut discarded = Vec::new();
    for id in card_ids.iter().take(need_discard) {
        let idx = state.players[player_idx]
            .hand
            .iter()
            .position(|c| c.id == *id)
            .ok_or_else(|| format!("你没有牌 {}", id))?;
        let card = state.players[player_idx].hand.remove(idx);
        add_log(state, LogEntry::CardDiscarded {
            player: player_idx,
            card_name: card.name.clone(),
        });
        discarded.push(card);
    }

    state.discard.extend(discarded.clone());
    bus.emit(
        crate::events::GameEvent::CardDiscarded {
            player: player_idx,
            cards: discarded,
        },
        state,
    );

    advance_phase_full(bus, state);
    Ok(())
}

fn handle_opponent_discard(
    state: &mut GameState,
    player_idx: usize,
    card_ids: &[String],
) -> Result<(), String> {
    let (count, pending_type) = {
        let pending = state.pending_response.as_ref().ok_or("没有待处理的弃牌")?;
        if pending.pending_type != crate::types::PendingType::OpponentDiscard {
            return Err("没有待处理的弃牌".into());
        }
        (pending.discard_count.unwrap_or(1), pending.pending_type)
    };

    if card_ids.len() != count {
        return Err(format!("需要弃 {} 张牌", count));
    }

    for id in card_ids {
        let player = &mut state.players[player_idx];
        let idx = player.hand.iter().position(|c| c.id == *id)
            .ok_or_else(|| format!("你没有牌 {}", id))?;
        let card = player.hand.remove(idx);
        add_log(state, LogEntry::CardDiscarded {
            player: player_idx,
            card_name: card.name.clone(),
        });
        state.discard.push(card);
    }

    state.pending_response = None;
    Ok(())
}

// ============================================================
// 超时检查
// ============================================================

pub fn check_timeout(state: &mut GameState) -> bool {
    let mut changed = false;

    if anyone_disconnected(state) {
        return changed;
    }

    // Pending 超时
    if let Some(ref pending) = state.pending_response {
        if now_ms() >= pending.timeout {
            handle_timeout(state);
            changed = true;
        }
    }

    // 回合超时
    if !state.game_over
        && state.pending_response.is_none()
        && (state.phase == Phase::Play || state.phase == Phase::Discard)
        && now_ms() - state.turn_start_time > TURN_TIMEOUT_MS
    {
        // For discard, just advance phase without random discard
        state.turn_start_time = now_ms();
        // Need EventBus for advance but check_timeout runs in polling context without bus
        // Just set the phase for the next broadcast to handle
        if state.phase == Phase::Discard {
            state.phase = Phase::End;
        } else {
            advance_phase(state);
        }
        changed = true;
    }

    changed
}

// ============================================================
// 断线管理
// ============================================================

pub fn mark_disconnected(state: &mut GameState, player_idx: usize) -> bool {
    state.disconnected_at[player_idx] = Some(now_ms());
    state.disconnect_count[player_idx] += 1;

    if state.disconnect_count[player_idx] > MAX_DISCONNECTS && !state.game_over {
        state.game_over = true;
        state.winner = Some(1 - player_idx);
        return true;
    }
    false
}

pub fn mark_reconnected(state: &mut GameState, player_idx: usize) {
    state.disconnected_at[player_idx] = None;
}

pub fn check_disconnect_timeout(state: &mut GameState, player_idx: usize) -> bool {
    if let Some(at) = state.disconnected_at[player_idx] {
        if now_ms() - at > RECONNECT_WINDOW_MS && !state.game_over {
            state.game_over = true;
            state.winner = Some(1 - player_idx);
            return true;
        }
    }
    false
}

pub fn anyone_disconnected(state: &GameState) -> bool {
    state.disconnected_at[0].is_some() || state.disconnected_at[1].is_some()
}

// ============================================================
// 生成客户端视图
// ============================================================

pub fn get_player_view(
    state: &GameState,
    player_idx: usize,
    player_name: &str,
    player_id: &str,
    opponent_name: &str,
    opponent_id: &str,
) -> ServerStateView {
    let me = &state.players[player_idx];
    let opponent = &state.players[1 - player_idx];

    let opp_char = opponent.character_id.as_ref()
        .and_then(|id| get_character(id));

    let opp_skills: Vec<SkillView> = opp_char
        .as_ref()
        .map(|c| {
            c.skills.iter().map(|s| {
                let sk = get_skill(&s.id);
                SkillView {
                    id: s.id.clone(),
                    name: sk.as_ref().map_or(s.name.clone(), |sk| sk.name.clone()),
                    skill_type: sk.map_or("active".into(), |sk| match sk.skill_type {
                        crate::types::SkillType::Active => "active",
                        crate::types::SkillType::Passive => "passive",
                        crate::types::SkillType::Locked => "locked",
                    }.into()),
                }
            }).collect()
        })
        .unwrap_or_default();

    let opp_view = PlayerView {
        hp: opponent.hp,
        max_hp: opponent.max_hp,
        hand_count: opponent.hand.len(),
        alive: opponent.alive,
        character_id: opponent.character_id.clone(),
        weapon: opponent.weapon.clone(),
        armor: opponent.armor.clone(),
        skills: opp_skills,
    };

    let my_char = me.character_id.as_ref().and_then(|id| get_character(id));
    let my_skills: Vec<SkillView> = my_char
        .as_ref()
        .map(|c| {
            c.skills.iter().map(|s| {
                let sk = get_skill(&s.id);
                SkillView {
                    id: s.id.clone(),
                    name: sk.as_ref().map_or(s.name.clone(), |sk| sk.name.clone()),
                    skill_type: sk.map_or("active".into(), |sk| match sk.skill_type {
                        crate::types::SkillType::Active => "active",
                        crate::types::SkillType::Passive => "passive",
                        crate::types::SkillType::Locked => "locked",
                    }.into()),
                }
            }).collect()
        })
        .unwrap_or_default();

    let pending_view = state.pending_response.clone();

    let turn_time_left = if (state.phase == Phase::Play || state.phase == Phase::Discard)
        && state.pending_response.is_none()
    {
        let elapsed = (now_ms() - state.turn_start_time) / 1000;
        TURN_TIMEOUT_SEC.saturating_sub(elapsed)
    } else {
        TURN_TIMEOUT_SEC
    };

    let hand_limit = get_hand_limit(state, player_idx, me.character_id.as_deref().unwrap_or(""));

    ServerStateView {
        phase: state.phase,
        turn_player: state.turn_player,
        you: crate::types::PlayerYouView {
            hp: me.hp,
            max_hp: me.max_hp,
            hand: me.hand.clone(),
            alive: me.alive,
            character_id: me.character_id.clone(),
            skills: my_skills,
            weapon: me.weapon.clone(),
            armor: me.armor.clone(),
        },
        opponent: opp_view,
        attack_used: state.attack_used,
        pending_response: pending_view,
        game_over: state.game_over,
        winner: state.winner,
        deck_count: state.deck.len(),
        turn_time_left,
        opponent_disconnected: state.disconnected_at[1 - player_idx].is_some(),
        player_name: player_name.to_string(),
        player_id: player_id.to_string(),
        opponent_name: opponent_name.to_string(),
        opponent_id: opponent_id.to_string(),
        hand_limit,
        skill_use_count: state.skill_use_count.clone(),
        log: state.log.clone(),
    }
}
