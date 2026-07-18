// effects.rs — 卡牌效果注册表 + 装备系统 + 响应系统
// Rust 复刻：对应 Deno TS 的 effects.ts

use crate::cards::{draw_cards, has_card, remove_card};
use crate::skills::execute_skill_effect;
use crate::types::{
    Card, CardType, ExposedCard, GameState, LogEntry, PendingResponse, PendingType, Phase, StealAction, Suit,
};
use std::collections::HashMap;

use std::sync::OnceLock;
static EFFECT_MAP: OnceLock<HashMap<String, CardEffect>> = OnceLock::new();

// 效果类型
type CardConditionFn = Box<dyn Fn(&GameState, usize, &Card) -> bool + Send + Sync>;
type OnUseFn = Box<dyn Fn(&mut GameState, usize, &Card, Option<usize>) + Send + Sync>;
type CanRespondFn = Box<dyn Fn(&GameState, usize, &Card) -> bool + Send + Sync>;

pub struct CardEffect {
    pub can_use: CardConditionFn,
    pub needs_target: bool,
    pub on_use: OnUseFn,
    pub can_respond: Option<CanRespondFn>,
}

pub fn get_card_effect(name: &str) -> Option<&CardEffect> {
    EFFECT_MAP.get()?.get(name)
}

// ============================================================
// 公开的效果原语
// ============================================================

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

pub fn set_dodge_pending(s: &mut GameState, source: usize, card: &Card) {
    let opponent = 1 - source;
    s.pending_response = Some(PendingResponse {
        pending_type: PendingType::Dodge,
        source,
        target: opponent,
        card: Some(card.clone()),
        timeout: now_ms() + 15_000,
        selectable_cards: None, pool_size: None, steal_action: None,
        exposed_cards: None, pending_skill_id: None, discard_count: None,
    });
}

pub fn set_near_death_pending(s: &mut GameState, source: usize) {
    let target = 1 - source;
    s.pending_response = Some(PendingResponse {
        pending_type: PendingType::NearDeath,
        source,
        target,
        card: None,
        timeout: now_ms() + 15_000,
        selectable_cards: None, pool_size: None, steal_action: None,
        exposed_cards: None, pending_skill_id: None, discard_count: None,
    });
}

pub fn add_log(s: &mut GameState, entry: LogEntry) {
    s.log.push(entry);
    if s.log.len() > 50 {
        s.log.remove(0);
    }
}

fn deal_damage(s: &mut GameState, source: usize, target: usize, mut amount: u32, reason: Option<&str>) {
    if s.players[target].armor.as_ref().map_or(false, |a| a.name == "黑名单" && reason == Some("volley")) {
        amount += 1;
    }
    s.players[target].hp -= amount as i32;
    if s.players[target].hp < 0 { s.players[target].hp = 0; }
    add_log(s, LogEntry::Damage { player: target, amount });
    if s.players[target].hp <= 0 && !s.game_over {
        set_near_death_pending(s, source);
    }
}

fn equip_card(s: &mut GameState, player_idx: usize, card: &Card) {
    let mut old_weapon_name: Option<String> = None;
    let mut old_armor_name: Option<String> = None;
    {
        let player = &mut s.players[player_idx];
        match card.card_type {
            CardType::Weapon => {
                old_weapon_name = player.weapon.as_ref().map(|w| w.name.clone());
                if let Some(old) = player.weapon.take() {
                    s.discard.push(old);
                }
                player.weapon = Some(card.clone());
            }
            CardType::Armor => {
                old_armor_name = player.armor.as_ref().map(|a| a.name.clone());
                if let Some(old) = player.armor.take() {
                    s.discard.push(old);
                }
                player.armor = Some(card.clone());
            }
            _ => return,
        }
    }
    if let Some(name) = old_weapon_name {
        add_log(s, LogEntry::CardDiscarded { player: player_idx, card_name: name });
    }
    if let Some(name) = old_armor_name {
        add_log(s, LogEntry::CardDiscarded { player: player_idx, card_name: name });
    }
    add_log(s, LogEntry::CardEquipped { player: player_idx, card_name: card.name.clone() });
}

fn pending_is(pt: PendingType) -> Box<dyn Fn(&GameState, usize) -> bool + Send + Sync> {
    Box::new(move |s, p| s.pending_response.as_ref().map_or(false, |pr| pr.pending_type == pt && pr.target == p))
}

// ============================================================
// 卡牌效果注册
// ============================================================

pub fn init_effects() {
    let mut map: HashMap<String, CardEffect> = HashMap::new();

    macro_rules! reg {
        ($name:expr, $can_use:expr, $needs_target:expr, $on_use:expr $(, $can_respond:expr)?) => {
            map.insert($name.to_string(), CardEffect {
                can_use: Box::new($can_use),
                needs_target: $needs_target,
                on_use: Box::new($on_use),
                can_respond: None $(.or(Some(Box::new($can_respond))))?,
            });
        };
    }

    // --- 基本牌 ---

    reg!("作业",
        move |s, p, card: &Card| {
            if p != s.turn_player || s.phase != Phase::Play || s.pending_response.is_some() { return false; }
            if s.attack_used && s.players[p].weapon.as_ref().map_or(true, |w| w.name != "圆规") { return false; }
            let opp = &s.players[1 - p];
            if opp.armor.as_ref().map_or(false, |a| a.name == "黑名单") { return false; }
            if let Some(ref a) = opp.armor {
                if a.name == "校服" && (card.suit == Suit::Spade || card.suit == Suit::Club) { return false; }
            }
            true
        },
        true,
        |s, player_idx, card, _target| {
            let opponent = 1 - player_idx;
            let has_eraser = s.players[opponent].armor.as_ref().map_or(false, |a| a.name == "涂改液");
            let can_judge = !s.deck.is_empty() || !s.discard.is_empty();
            if has_eraser && can_judge {
                s.pending_response = Some(PendingResponse {
                    pending_type: PendingType::JudgeArmor, source: player_idx, target: opponent,
                    card: Some(card.clone()), timeout: now_ms() + 8000,
                    selectable_cards: None, pool_size: None, steal_action: None,
                    exposed_cards: None, pending_skill_id: None, discard_count: None,
                });
                add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "作业".into(), target: Some(opponent) });
                return;
            }
            s.attack_used = true;
            set_dodge_pending(s, player_idx, card);
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "作业".into(), target: Some(opponent) });
        }
    );

    reg!("豁免",
        |_, _, _| false,
        false,
        |_, _, _, _| {},
        |s, p, _card| s.pending_response.as_ref().map_or(false, |pr| pr.target == p && pr.pending_type == PendingType::Dodge)
    );

    reg!("补给",
        move |s, p, _card| {
            if s.pending_response.as_ref().map_or(false, |pr| pr.pending_type == PendingType::NearDeath && pr.target == p) { return true; }
            p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none() && s.players[p].hp < s.players[p].max_hp
        },
        false,
        |s, player_idx, _card, _target| {
            let p = &mut s.players[player_idx];
            p.hp = (p.hp + 1).min(p.max_hp);
            add_log(s, LogEntry::Heal { player: player_idx, amount: 1 });
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "补给".into(), target: None });
        }
    );

    reg!("小抄",
        move |s, p, _card| {
            if s.pending_response.as_ref().map_or(false, |pr| pr.pending_type == PendingType::NearDeath && pr.target == p) { return true; }
            p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none()
        },
        false,
        |s, player_idx, _card, _target| {
            let is_near_death = s.pending_response.as_ref().map_or(false, |pr| pr.pending_type == PendingType::NearDeath);
            if is_near_death { s.players[player_idx].hp = 1; s.pending_response = None; }
            else { s.wine_used[player_idx] = true; }
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "小抄".into(), target: None });
        }
    );

    // --- 效果牌 ---

    reg!("熬夜复习",
        move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none() && s.players[p].hp <= s.players[1 - p].hp,
        false,
        |s, player_idx, _card, _target| {
            s.wine_used[player_idx] = true;
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "熬夜复习".into(), target: None });
            crate::game::advance_phase(s);
        }
    );

    reg!("请家长",
        move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none() && s.players[p].hand.len() >= 2,
        false,
        |s, player_idx, _card, _target| {
            use rand::Rng;
            let p = &mut s.players[player_idx];
            if !p.hand.is_empty() {
                let idx = rand::thread_rng().gen_range(0..p.hand.len());
                let discarded = p.hand.remove(idx);
                add_log(s, LogEntry::CardDiscarded { player: player_idx, card_name: discarded.name.clone() });
                s.discard.push(discarded);
            }
            let drawn = draw_cards(&mut s.deck, &mut s.discard, 1);
            if let Some(judge) = drawn.first() {
                s.discard.push(judge.clone());
                let is_red = judge.suit == Suit::Heart || judge.suit == Suit::Diamond;
                add_log(s, LogEntry::JudgeResult {
                    player: player_idx, card_name: judge.name.clone(),
                    suit: format!("{:?}", judge.suit),
                    result: if is_red { "success" } else { "fail" }.into(),
                });
                if is_red { s.skip_next_play = Some(1 - player_idx); }
            }
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "请家长".into(), target: None });
        }
    );

    // --- 锦囊牌 -- 需要响应 ---

    for (name, ptype, can_respond_pt) in [
        ("辩论", PendingType::Duel, PendingType::Duel),
        ("突击测验", PendingType::Barbarian, PendingType::Barbarian),
    ] {
        let pending_type = ptype;
        let resp_pt = can_respond_pt;
        reg!(name,
            move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none()
                && s.players[1 - p].armor.as_ref().map_or(true, |a| a.name != "黑名单"),
            true,
            move |s, player_idx, card, _target| {
                let opponent = 1 - player_idx;
                s.pending_response = Some(PendingResponse {
                    pending_type, source: player_idx, target: opponent,
                    card: Some(card.clone()), timeout: now_ms() + 15_000,
                    selectable_cards: None, pool_size: None, steal_action: None,
                    exposed_cards: None, pending_skill_id: None, discard_count: None,
                });
                add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: name.into(), target: Some(opponent) });
            },
            move |s, p, _card| pending_is(resp_pt)(s, p)
        );
    }

    reg!("最终测试",
        move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none(),
        false,
        |s, player_idx, _card, _target| {
            for p in [player_idx, 1 - player_idx] {
                let drawn = draw_cards(&mut s.deck, &mut s.discard, 2);
                let count = drawn.len() as u32;
                s.players[p].hand.extend(drawn);
                add_log(s, LogEntry::Draw { player: p, count });
            }
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "最终测试".into(), target: None });
        }
    );

    reg!("嫁祸",
        move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none(),
        true,
        |s, player_idx, card, _target| {
            let opponent = 1 - player_idx;
            s.pending_response = Some(PendingResponse {
                pending_type: PendingType::BorrowKnife, source: player_idx, target: opponent,
                card: Some(card.clone()), timeout: now_ms() + 15_000,
                selectable_cards: None, pool_size: None, steal_action: None,
                exposed_cards: None, pending_skill_id: None, discard_count: None,
            });
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "嫁祸".into(), target: Some(opponent) });
        },
        move |s, p, _card| pending_is(PendingType::BorrowKnife)(s, p)
    );

    // --- 锦囊牌 -- 即刻 ---

    for (name, steal_action) in [("神偷", None), ("告密", Some(StealAction::Discard))] {
        let action = steal_action;
        reg!(name,
            move |s, p, _card| {
                if p != s.turn_player || s.phase != Phase::Play || s.pending_response.is_some() { return false; }
                let opp = &s.players[1 - p];
                !opp.hand.is_empty() || opp.weapon.is_some() || opp.armor.is_some()
            },
            true,
            move |s, player_idx, card, _target| {
                let opponent = 1 - player_idx;
                let opp = &s.players[opponent];
                let mut exposed = Vec::new();
                let mut pos = opp.hand.len() + 1;
                if let Some(ref w) = opp.weapon { exposed.push(ExposedCard { card: w.clone(), position: pos }); pos += 1; }
                if let Some(ref a) = opp.armor { exposed.push(ExposedCard { card: a.clone(), position: pos }); }
                s.pending_response = Some(PendingResponse {
                    pending_type: PendingType::Steal, source: player_idx, target: player_idx,
                    pool_size: Some(opp.hand.len()), steal_action: action, exposed_cards: Some(exposed),
                    card: Some(card.clone()), timeout: now_ms() + 10_000,
                    selectable_cards: None, pending_skill_id: None, discard_count: None,
                });
                add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: name.into(), target: Some(opponent) });
            }
        );
    }

    for (name, count) in [("陷害", 2usize), ("午饭留堂", 1)] {
        reg!(name,
            move |s, p, _card| {
                if p != s.turn_player || s.phase != Phase::Play || s.pending_response.is_some() { return false; }
                let opp = &s.players[1 - p];
                opp.hand.len() + opp.weapon.is_some() as usize + opp.armor.is_some() as usize >= count
            },
            true,
            move |s, player_idx, card, _target| {
                let opp = &s.players[1 - player_idx];
                let mut exposed = Vec::new();
                let mut pos = opp.hand.len() + 1;
                if let Some(ref w) = opp.weapon { exposed.push(ExposedCard { card: w.clone(), position: pos }); pos += 1; }
                if let Some(ref a) = opp.armor { exposed.push(ExposedCard { card: a.clone(), position: pos }); }
                s.pending_response = Some(PendingResponse {
                    pending_type: PendingType::PickDiscard, source: player_idx, target: player_idx,
                    pool_size: Some(opp.hand.len()), exposed_cards: Some(exposed), discard_count: Some(count),
                    card: Some(card.clone()), timeout: now_ms() + 15_000,
                    selectable_cards: None, steal_action: None, pending_skill_id: None,
                });
                add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: name.into(), target: Some(1 - player_idx) });
            }
        );
    }

    reg!("点名批评",
        move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none(),
        true,
        |s, player_idx, card, _target| {
            let opponent = 1 - player_idx;
            s.pending_response = Some(PendingResponse {
                pending_type: PendingType::Volley, source: player_idx, target: opponent,
                card: Some(card.clone()), timeout: now_ms() + 15_000,
                selectable_cards: None, pool_size: None, steal_action: None,
                exposed_cards: None, pending_skill_id: None, discard_count: None,
            });
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "点名批评".into(), target: Some(opponent) });
        },
        move |s, p, _card| pending_is(PendingType::Volley)(s, p)
    );

    reg!("午饭",
        move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none(),
        false,
        |s, player_idx, _card, _target| {
            let drawn = draw_cards(&mut s.deck, &mut s.discard, 2);
            s.players[player_idx].hand.extend(drawn);
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "午饭".into(), target: None });
        }
    );

    reg!("感冒",
        move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none(),
        true,
        |s, player_idx, _card, _target| {
            deal_damage(s, player_idx, 1 - player_idx, 1, None);
            add_log(s, LogEntry::CardPlayed { player: player_idx, card_name: "感冒".into(), target: Some(1 - player_idx) });
        }
    );

    reg!("免罚券",
        |_, _, _| false,
        false,
        |_, _, _, _| {},
        |s, p, _card| {
            let pr = match s.pending_response.as_ref() { Some(x) => x, None => return false };
            pr.target == p && matches!(pr.pending_type, PendingType::Barbarian | PendingType::Volley | PendingType::BorrowKnife | PendingType::Duel)
        }
    );

    // --- 装备牌 ---
    for name in ["钢笔", "圆规", "尺子", "橡皮", "校服", "黑名单", "涂改液"] {
        reg!(name,
            move |s, p, _card| p == s.turn_player && s.phase == Phase::Play && s.pending_response.is_none(),
            false,
            |s, player_idx, card, _target| equip_card(s, player_idx, card)
        );
    }

    let _ = EFFECT_MAP.set(map);
}

// ============================================================
// tryUseCard / tryRespond
// ============================================================

pub fn try_use_card(state: &mut GameState, player_idx: usize, card_id: &str, target: Option<usize>) -> Result<(), String> {
    if state.pending_response.is_some() {
        return try_respond(state, player_idx, card_id);
    }
    if player_idx != state.turn_player { return Err("不是你的回合".into()); }
    if state.phase != Phase::Play { return Err("只能在出牌阶段使用".into()); }

    if !has_card(&state.players[player_idx].hand, card_id) { return Err("你没有这张牌".into()); }

    let card = state.players[player_idx].hand.iter().find(|c| c.id == card_id).unwrap().clone();
    let card_type = card.card_type;
    let effect = get_card_effect(&card.name).ok_or_else(|| format!("未知卡牌: {}", card.name))?;

    if !(effect.can_use)(state, player_idx, &card) { return Err(format!("不能使用【{}】", card.name)); }
    if effect.needs_target && target.is_none() { return Err("请选择目标".into()); }

    remove_card(&mut state.players[player_idx].hand, card_id);

    if card_type == CardType::Weapon || card_type == CardType::Armor {
        equip_card(state, player_idx, &card);
    } else {
        state.discard.push(card.clone());
        (effect.on_use)(state, player_idx, &card, target.or(Some(1 - player_idx)));
    }
    Ok(())
}

pub fn try_respond(state: &mut GameState, player_idx: usize, card_id: &str) -> Result<(), String> {
    let pending = state.pending_response.as_ref().ok_or("没有需要响应的")?.clone();
    if player_idx != pending.target { return Err("不是你需要响应".into()); }

    if !has_card(&state.players[player_idx].hand, card_id) { return Err("你没有这张牌".into()); }
    let card = state.players[player_idx].hand.iter().find(|c| c.id == card_id).unwrap().clone();
    let card_name = card.name.clone();

    remove_card(&mut state.players[player_idx].hand, card_id);
    state.discard.push(card.clone());

    match pending.pending_type {
        PendingType::Dodge | PendingType::Volley => {
            if card_name != "豁免" {
                state.players[player_idx].hand.push(state.discard.pop().unwrap());
                return Err("需要出【豁免】".into());
            }
            let source = pending.source;
            let source_weapon = state.players[source].weapon.as_ref().map(|w| w.name.clone());
            state.pending_response = None;
            add_log(state, LogEntry::CardPlayed { player: player_idx, card_name: "豁免".into(), target: None });
            if pending.pending_type == PendingType::Dodge && source_weapon.as_deref() == Some("尺子") {
                state.attack_used = false;
            }
            if pending.pending_type == PendingType::Dodge && source_weapon.as_deref() == Some("橡皮") {
                deal_damage(state, source, player_idx, 1, None);
            }
        }
        PendingType::NearDeath => {
            if card_name != "补给" && card_name != "小抄" {
                state.players[player_idx].hand.push(state.discard.pop().unwrap());
                return Err("需要出【补给】或【小抄】".into());
            }
            state.players[player_idx].hp = 1;
            state.pending_response = None;
            add_log(state, LogEntry::CardPlayed { player: player_idx, card_name: card_name.clone(), target: None });
        }
        PendingType::Duel | PendingType::Barbarian => {
            if card_name != "作业" {
                state.players[player_idx].hand.push(state.discard.pop().unwrap());
                return Err("需要出【作业】".into());
            }
            add_log(state, LogEntry::CardPlayed { player: player_idx, card_name: "作业".into(), target: None });
            if pending.pending_type == PendingType::Duel {
                state.pending_response = Some(PendingResponse {
                    pending_type: PendingType::Duel,
                    source: pending.target, target: pending.source,
                    card: pending.card.clone(), timeout: now_ms() + 15_000,
                    selectable_cards: None, pool_size: None, steal_action: None,
                    exposed_cards: None, pending_skill_id: None, discard_count: None,
                });
            } else {
                state.pending_response = None;
            }
        }
        PendingType::BorrowKnife => {
            state.pending_response = None;
            add_log(state, LogEntry::CardPlayed { player: player_idx, card_name: card_name.clone(), target: None });
        }
        _ => {
            if card_name == "免罚券" && matches!(pending.pending_type, PendingType::Barbarian | PendingType::Volley | PendingType::BorrowKnife | PendingType::Duel) {
                state.pending_response = None;
                add_log(state, LogEntry::CardPlayed { player: player_idx, card_name: "免罚券".into(), target: None });
            } else {
                state.players[player_idx].hand.push(state.discard.pop().unwrap());
                return Err(match pending.pending_type {
                    PendingType::Dodge => "需要出【豁免】",
                    PendingType::NearDeath => "需要出【补给】或【小抄】",
                    PendingType::Duel | PendingType::Barbarian => "需要出【作业】",
                    PendingType::Volley => "需要出【豁免】",
                    PendingType::Steal => "请选择要偷的牌",
                    PendingType::SkillDiscard => "需要选择要弃置的牌",
                    PendingType::BorrowKnife => "需要弃一张牌",
                    _ => "无效响应",
                }.into());
            }
        }
    }
    Ok(())
}

// ============================================================
// steal 选牌处理
// ============================================================

pub fn handle_steal_card(state: &mut GameState, player_idx: usize, position: Option<usize>) -> Result<(), String> {
    let pending = state.pending_response.clone().ok_or("没有正在进行的偷牌")?;
    if pending.pending_type != PendingType::Steal { return Err("没有正在进行的偷牌".into()); }
    if player_idx != pending.target { return Err("不是你在选择".into()); }

    let opponent = 1 - player_idx;
    let mut pool: Vec<Card> = state.players[opponent].hand.clone();
    if let Some(ref w) = state.players[opponent].weapon { pool.push(w.clone()); }
    if let Some(ref a) = state.players[opponent].armor { pool.push(a.clone()); }
    if pool.is_empty() { return Err("无可选牌".into()); }

    let pos = match position {
        Some(p) if p >= 1 && p <= pool.len() => p,
        _ => { use rand::Rng; rand::thread_rng().gen_range(1..=pool.len()) }
    };
    let chosen = &pool[pos - 1];

    let opp = &mut state.players[opponent];
    if let Some(idx) = opp.hand.iter().position(|c| c.id == chosen.id) { opp.hand.remove(idx); }
    else if opp.weapon.as_ref().map_or(false, |w| w.id == chosen.id) { opp.weapon = None; }
    else if opp.armor.as_ref().map_or(false, |a| a.id == chosen.id) { opp.armor = None; }

    let is_discard = pending.steal_action == Some(StealAction::Discard);
    let pending_card = pending.card;

    if is_discard {
        state.discard.push(chosen.clone());
        state.discard.push(pending_card.unwrap());
        state.pending_response = None;
        add_log(state, LogEntry::CardDiscarded { player: opponent, card_name: chosen.name.clone() });
    } else {
        state.players[player_idx].hand.push(chosen.clone());
        state.discard.push(pending_card.unwrap());
        state.pending_response = None;
        add_log(state, LogEntry::CardPlayed { player: player_idx, card_name: chosen.name.clone(), target: None });
    }
    Ok(())
}

// ============================================================
// handleTimeout
// ============================================================

pub fn handle_timeout(state: &mut GameState) {
    let Some(pending) = state.pending_response.clone() else { return };

    match pending.pending_type {
        PendingType::Dodge => {
            let target = pending.target;
            let mut dmg: u32 = 1;
            if state.wine_used[pending.source] { dmg += 1; state.wine_used[pending.source] = false; }
            if state.players[pending.source].weapon.as_ref().map_or(false, |w| w.name == "钢笔") { dmg += 1; }
            state.pending_response = None;
            deal_damage(state, pending.source, target, dmg, None);
        }
        PendingType::NearDeath => {
            let target = pending.target;
            state.players[target].alive = false;
            state.players[target].hp = 0;
            state.pending_response = None;
            state.game_over = true;
            state.winner = Some(1 - target);
        }
        PendingType::Duel | PendingType::Barbarian | PendingType::Volley | PendingType::BorrowKnife => {
            let ptype = pending.pending_type;
            state.pending_response = None;
            deal_damage(state, pending.source, pending.target, 1, if ptype == PendingType::Volley { Some("volley") } else { None });
        }
        PendingType::Steal => { let target = pending.target; let _ = handle_steal_card(state, target, None); }
        PendingType::SkillDiscard => { state.pending_response = None; }
        PendingType::OpponentDiscard => { state.pending_response = None; }
        PendingType::JudgeArmor => {
            state.pending_response = None;
            if let Some(ref card) = pending.card { set_dodge_pending(state, pending.source, card); }
        }
        PendingType::PickDiscard => { state.pending_response = None; }
    }
}

// ============================================================
// 涂改液主动技
// ============================================================

pub fn handle_activate_armor(state: &mut GameState, player_idx: usize) -> Result<(), String> {
    let pending = state.pending_response.clone().ok_or("没有需要响应的判定")?;
    if pending.pending_type != PendingType::JudgeArmor { return Err("没有需要响应的判定".into()); }
    if player_idx != pending.target { return Err("不是你需要响应".into()); }

    let drawn = draw_cards(&mut state.deck, &mut state.discard, 1);
    state.pending_response = None;

    if let Some(judge) = drawn.first() {
        state.discard.push(judge.clone());
        let is_red = judge.suit == Suit::Heart || judge.suit == Suit::Diamond;
        add_log(state, LogEntry::JudgeResult {
            player: player_idx, card_name: judge.name.clone(),
            suit: format!("{:?}", judge.suit),
            result: if is_red { "success" } else { "fail" }.into(),
        });
        if !is_red {
            set_dodge_pending(state, pending.source, pending.card.as_ref().unwrap());
        }
    } else {
        set_dodge_pending(state, pending.source, pending.card.as_ref().unwrap());
    }
    Ok(())
}

// ============================================================
// handlePickDiscard
// ============================================================

pub fn handle_pick_discard(state: &mut GameState, player_idx: usize, positions: &[usize]) -> Result<(), String> {
    let (discard_count, source) = {
        let pending = state.pending_response.as_ref().ok_or("没有待选择的弃牌")?;
        if pending.pending_type != PendingType::PickDiscard { return Err("没有待选择的弃牌".into()); }
        if player_idx != pending.target { return Err("不是你需要选择".into()); }
        (pending.discard_count.unwrap_or(1), pending.source)
    };
    if positions.len() != discard_count { return Err(format!("需要选 {} 张牌", discard_count)); }

    let opp_idx = 1 - source;
    let mut pool: Vec<Card> = state.players[opp_idx].hand.clone();
    if let Some(ref w) = state.players[opp_idx].weapon { pool.push(w.clone()); }
    if let Some(ref a) = state.players[opp_idx].armor { pool.push(a.clone()); }

    for &pos in positions {
        if pos < 1 || pos > pool.len() { return Err(format!("无效位置 {}", pos)); }
        let c = &pool[pos - 1];
        let opp = &mut state.players[opp_idx];
        if let Some(idx) = opp.hand.iter().position(|h| h.id == c.id) { opp.hand.remove(idx); }
        else if opp.weapon.as_ref().map_or(false, |w| w.id == c.id) { opp.weapon = None; }
        else if opp.armor.as_ref().map_or(false, |a| a.id == c.id) { opp.armor = None; }
        add_log(state, LogEntry::CardDiscarded { player: opp_idx, card_name: c.name.clone() });
        state.discard.push(c.clone());
    }
    state.pending_response = None;
    Ok(())
}

// ============================================================
// handleConfirmSkill
// ============================================================

pub fn handle_confirm_skill(state: &mut GameState, player_idx: usize, card_ids: &[String]) -> Result<(), String> {
    let (skill_id, discard_count) = {
        let pending = state.pending_response.as_ref().ok_or("没有需要确认的技能")?;
        if pending.pending_type != PendingType::SkillDiscard { return Err("没有需要确认的技能".into()); }
        if player_idx != pending.target { return Err("不是你需要确认".into()); }
        (pending.pending_skill_id.clone().ok_or("未知技能")?, pending.discard_count.unwrap_or(0))
    };
    if card_ids.len() != discard_count { return Err(format!("需要弃 {} 张牌", discard_count)); }

    // Verify cards exist
    for cid in card_ids {
        if !has_card(&state.players[player_idx].hand, cid) { return Err(format!("你没有牌 {}", cid)); }
    }

    // Remove cards
    for cid in card_ids {
        if let Some(card) = remove_card(&mut state.players[player_idx].hand, cid) {
            add_log(state, LogEntry::CardDiscarded { player: player_idx, card_name: card.name.clone() });
            state.discard.push(card);
        }
    }
    state.pending_response = None;

    // Mark used + execute
    if let Some(skill) = crate::skills::get_skill(&skill_id) {
        if skill.per_turn.is_some() {
            *state.skill_use_count.entry(skill_id.clone()).or_insert(0) += 1;
        }
        add_log(state, LogEntry::SkillUsed { player: player_idx, skill_name: skill.name.clone() });
        execute_skill_effect(state, player_idx, &skill_id);
    }
    Ok(())
}
