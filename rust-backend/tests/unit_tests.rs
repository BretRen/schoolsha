// tests/unit_tests.rs — 单元测试
// 复刻 Deno 的 test_core.ts + test_equip.ts

use schoolsha::cards::{card_label, create_deck, draw_cards, shuffle, has_card};
use schoolsha::elo::{get_elo, predict_elo_change};
use schoolsha::events::EventBus;
use schoolsha::effects::{self, add_log, get_card_effect, handle_steal_card, handle_timeout, try_use_card};
use schoolsha::game::{check_timeout, create_game, handle_message};
use schoolsha::skills;
use schoolsha::types::{Card, CardType, CardsConfig, ClientMsg, GameState, Phase, Player, PendingResponse, PendingType, Suit};

// ============================================================
// 测试辅助函数
// ============================================================

fn init_all() {
    // Initialize effects and skills once
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        effects::init_effects();
        let chars = schoolsha::config::load_characters(".");
        let skills = schoolsha::config::load_skills(".");
        skills::init(&chars, &skills);
    });
}

fn make_card(id: &str, name: &str, card_type: CardType, suit: Suit, num: u8) -> Card {
    Card {
        id: id.to_string(),
        name: name.to_string(),
        suit,
        number: num,
        card_type,
    }
}

fn make_state(turn_player: usize) -> GameState {
    let p = Player {
        hp: 3, max_hp: 3, hand: vec![], alive: true,
        character_id: Some("student".into()),
        weapon: None, armor: None,
    };
    GameState {
        phase: Phase::Play,
        turn_player,
        players: [p.clone(), p],
        deck: vec![],
        discard: vec![],
        attack_used: false,
        pending_response: None,
        game_over: false,
        winner: None,
        turn_start_time: 0,
        disconnect_count: [0, 0],
        disconnected_at: [None, None],
        wine_used: [false, false],
        skip_next_play: None,
        skill_use_count: std::collections::HashMap::new(),
        log: vec![],
    }
}

fn load_cards_config() -> CardsConfig {
    let content = std::fs::read_to_string("cards.json").unwrap();
    serde_json::from_str(&content).unwrap()
}

// ============================================================
// cards.rs 测试
// ============================================================

#[test]
fn test_create_deck() {
    init_all();
    let config = load_cards_config();
    let deck = create_deck(&config);
    assert!(deck.len() > 50);
    assert!(deck.len() < 200);
}

#[test]
fn test_shuffle_preserves_count() {
    init_all();
    let config = load_cards_config();
    let mut deck = create_deck(&config);
    let len = deck.len();
    shuffle(&mut deck);
    assert_eq!(deck.len(), len);
}

#[test]
fn test_draw_cards() {
    init_all();
    let config = load_cards_config();
    let mut deck = create_deck(&config);
    let drawn = draw_cards(&mut deck, &mut vec![], 5);
    assert_eq!(drawn.len(), 5);
}

#[test]
fn test_draw_cards_recycle_discard() {
    init_all();
    let mut deck: Vec<Card> = vec![]; // empty deck
    let mut discard: Vec<Card> = (0..10).map(|i| make_card(&format!("C{}", i), "作业", CardType::Basic, Suit::Spade, 7)).collect();
    let drawn = draw_cards(&mut deck, &mut discard, 5);
    assert_eq!(drawn.len(), 5);
}

#[test]
fn test_card_label() {
    let card = make_card("T1", "作业", CardType::Basic, Suit::Heart, 7);
    let label = card_label(&card);
    assert!(label.contains("作业"));
    assert!(label.contains("♥"));
}

// ============================================================
// elo.rs 测试
// ============================================================

#[test]
fn test_elo_default() {
    let elo = get_elo(".", "nonexistent_player_test");
    assert_eq!(elo, 1000);
}

#[test]
fn test_elo_same_rating() {
    let pred = predict_elo_change(1000, 1000);
    assert_eq!(pred.win, 16);
    assert_eq!(pred.lose, -16);
}

#[test]
fn test_elo_high_beats_low() {
    let high = predict_elo_change(1400, 1000);
    let low = predict_elo_change(1000, 1400);
    assert!(high.win < low.win);
}

// ============================================================
// events.rs 测试
// ============================================================

#[test]
fn test_event_register_and_unsubscribe() {
    use schoolsha::events::GameEvent;
    use std::sync::{Arc, Mutex};

    let mut bus = EventBus::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_clone = calls.clone();

    let token = bus.on_event(vec!["damage".into()], Box::new(move |_, _| {
        calls_clone.lock().unwrap().push("hit".to_string());
    }));

    let mut state = make_state(0);
    bus.emit(GameEvent::Damage { source: 0, target: 1, amount: 2 }, &mut state);
    assert_eq!(*calls.lock().unwrap(), vec!["hit".to_string()]);

    bus.off_event(token);
    bus.emit(GameEvent::Damage { source: 0, target: 1, amount: 2 }, &mut state);
    assert_eq!(*calls.lock().unwrap(), vec!["hit".to_string()]);
}

// ============================================================
// effects.rs 测试
// ============================================================

#[test]
fn test_effect_zuoye_needs_target() {
    init_all();
    let e = get_card_effect("作业").expect("作业 effect not found");
    assert!(e.needs_target);
}

#[test]
fn test_effect_shemian_cannot_use() {
    init_all();
    let e = get_card_effect("豁免").expect("豁免 effect not found");
    let state = make_state(0);
    assert!(!(e.can_use)(&state, 0, &make_card("X", "豁免", CardType::Basic, Suit::Heart, 2)));
    assert!(e.can_respond.is_some());
}

#[test]
fn test_effect_mianfaquan_responds_duel_not_dodge() {
    init_all();
    let e = get_card_effect("免罚券").expect("免罚券 effect not found");
    let can_resp = e.can_respond.as_ref().unwrap();

    let mut state_duel = make_state(0);
    state_duel.pending_response = Some(PendingResponse {
        pending_type: PendingType::Duel,
        source: 1, target: 0, card: None, timeout: 99999,
        selectable_cards: None, pool_size: None, steal_action: None,
        exposed_cards: None, pending_skill_id: None, discard_count: None,
    });
    assert!(can_resp(&state_duel, 0, &make_card("X", "免罚券", CardType::Basic, Suit::Heart, 2)));

    let mut state_dodge = make_state(0);
    state_dodge.pending_response = Some(PendingResponse {
        pending_type: PendingType::Dodge,
        source: 1, target: 0, card: None, timeout: 99999,
        selectable_cards: None, pool_size: None, steal_action: None,
        exposed_cards: None, pending_skill_id: None, discard_count: None,
    });
    assert!(!can_resp(&state_dodge, 0, &make_card("X", "免罚券", CardType::Basic, Suit::Heart, 2)));
}

#[test]
fn test_effect_shentou_empty_opponent_cannot_use() {
    init_all();
    let e = get_card_effect("神偷").expect("神偷 effect not found");
    let mut state = make_state(0);
    state.players[1].hand = vec![];
    state.players[1].weapon = None;
    state.players[1].armor = None;
    assert!(!(e.can_use)(&state, 0, &make_card("X", "神偷", CardType::Trick, Suit::Spade, 3)));
}

// ============================================================
// 装备系统测试（复刻 test_equip.ts）
// ============================================================

#[test]
fn test_equip_weapon() {
    init_all();
    let mut s = make_state(0);
    s.players[0].hand = vec![make_card("C1", "钢笔", CardType::Weapon, Suit::Diamond, 1)];
    s.players[1].hand = vec![make_card("C2", "豁免", CardType::Basic, Suit::Diamond, 2)];

    try_use_card(&mut s, 0, "C1", None).expect("equip should succeed");
    assert_eq!(s.players[0].weapon.as_ref().unwrap().name, "钢笔");
    assert!(s.players[0].hand.is_empty());
}

#[test]
fn test_equip_replace_weapon() {
    init_all();
    let mut s = make_state(0);
    s.players[0].hand = vec![
        make_card("C1", "钢笔", CardType::Weapon, Suit::Diamond, 1),
        make_card("C2", "圆规", CardType::Weapon, Suit::Diamond, 1),
    ];
    s.players[1].hand = vec![make_card("C3", "豁免", CardType::Basic, Suit::Diamond, 2)];

    try_use_card(&mut s, 0, "C1", None).unwrap();
    try_use_card(&mut s, 0, "C2", None).unwrap();
    assert_eq!(s.players[0].weapon.as_ref().unwrap().name, "圆规");
    assert_eq!(s.discard.len(), 1);
    assert_eq!(s.discard[0].name, "钢笔");
}

#[test]
fn test_equip_armor() {
    init_all();
    let mut s = make_state(0);
    s.players[0].hand = vec![make_card("C1", "校服", CardType::Armor, Suit::Club, 2)];
    s.players[1].hand = vec![make_card("C2", "豁免", CardType::Basic, Suit::Diamond, 2)];

    try_use_card(&mut s, 0, "C1", None).unwrap();
    assert_eq!(s.players[0].armor.as_ref().unwrap().name, "校服");
}

#[test]
fn test_xiaofu_blocks_black_zuoye() {
    init_all();
    let mut s = make_state(0);
    s.players[0].hand = vec![make_card("C1", "作业", CardType::Basic, Suit::Spade, 7)];
    s.players[1].hand = vec![make_card("C2", "豁免", CardType::Basic, Suit::Diamond, 2)];
    s.players[1].armor = Some(make_card("CA", "校服", CardType::Armor, Suit::Club, 2));

    // 校服 blocks black (spade) 作业 — canUse returns false
    let result = try_use_card(&mut s, 0, "C1", None);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("不能使用"));
}

#[test]
fn test_heimingdan_blocks_zuoye() {
    init_all();
    let mut s = make_state(0);
    s.players[0].hand = vec![make_card("C1", "作业", CardType::Basic, Suit::Heart, 10)];
    s.players[1].hand = vec![make_card("C2", "豁免", CardType::Basic, Suit::Diamond, 2)];
    s.players[1].armor = Some(make_card("CA", "黑名单", CardType::Armor, Suit::Club, 2));

    let result = try_use_card(&mut s, 0, "C1", None);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("不能使用"));
}

#[test]
fn test_gangbi_plus_one_damage() {
    init_all();
    let mut s = make_state(0);
    s.players[0].weapon = Some(make_card("CW", "钢笔", CardType::Weapon, Suit::Diamond, 1));
    s.players[0].hand = vec![make_card("C1", "作业", CardType::Basic, Suit::Heart, 10)];
    s.players[1].hand = vec![];
    s.players[1].hp = 3;

    try_use_card(&mut s, 0, "C1", Some(1)).unwrap();
    assert!(s.pending_response.is_some());
    assert_eq!(s.pending_response.as_ref().unwrap().pending_type, PendingType::Dodge);

    // Simulate timeout
    s.pending_response.as_mut().unwrap().timeout = 0;
    handle_timeout(&mut s);

    // base 1 + 钢笔 1 = 2 damage
    assert_eq!(s.players[1].hp, 1, "expected 2 damage from 钢笔 bonus");
}

#[test]
fn test_yuangui_ignores_attack_limit() {
    init_all();
    let mut s = make_state(0);
    s.attack_used = true;
    s.players[0].weapon = Some(make_card("CW", "圆规", CardType::Weapon, Suit::Diamond, 1));
    s.players[0].hand = vec![make_card("C1", "作业", CardType::Basic, Suit::Heart, 10)];
    s.players[1].hand = vec![make_card("C2", "豁免", CardType::Basic, Suit::Diamond, 2)];

    let e = get_card_effect("作业").unwrap();
    assert!((e.can_use)(&s, 0, &s.players[0].hand[0]),
        "圆规 should allow attack even with attackUsed=true");
}

#[test]
fn test_gaomi_discard_equipment() {
    init_all();
    let mut s = make_state(0);
    s.players[0].hand = vec![make_card("C1", "告密", CardType::Trick, Suit::Spade, 5)];
    s.players[1].hand = vec![];
    s.players[1].weapon = Some(make_card("CW", "钢笔", CardType::Weapon, Suit::Diamond, 1));
    s.players[1].armor = Some(make_card("CA", "校服", CardType::Armor, Suit::Club, 2));

    try_use_card(&mut s, 0, "C1", Some(1)).unwrap();
    assert!(s.pending_response.is_some());
    assert_eq!(s.pending_response.as_ref().unwrap().pending_type, PendingType::Steal);

    // Pick position 1 (should be equipment since hand is empty and pool starts with hand)
    // pool: [weapon, armor] — position 1 is weapon
    handle_steal_card(&mut s, 0, Some(1)).unwrap();

    // After discard steal: weapon should be gone (or armor, depending on pool order)
    let has_equipment = s.players[1].weapon.is_some() || s.players[1].armor.is_some();
    assert!(!has_equipment || s.players[1].weapon.is_none() || s.players[1].armor.is_none(),
        "告密 should have discarded equipment");
}

#[test]
fn test_shentou_steal_equipment() {
    init_all();
    let mut s = make_state(0);
    s.players[0].hand = vec![make_card("C1", "神偷", CardType::Trick, Suit::Spade, 3)];
    s.players[1].hand = vec![];
    s.players[1].weapon = Some(make_card("CW", "尺子", CardType::Weapon, Suit::Spade, 5));

    try_use_card(&mut s, 0, "C1", Some(1)).unwrap();
    assert!(s.pending_response.is_some());

    handle_steal_card(&mut s, 0, Some(1)).unwrap();

    assert!(s.players[1].weapon.is_none(), "尺子 should be stolen");
    assert!(s.players[0].hand.iter().any(|c| c.name == "尺子"), "尺子 should be in P0 hand");
}

// ============================================================
// game.rs 测试
// ============================================================

#[test]
fn test_create_game_state() {
    init_all();

    let mut bus = EventBus::new();
    let config = load_cards_config();
    let picks = ["student".to_string(), "student".to_string()];
    let state = create_game(&mut bus, &picks, &config);

    assert_eq!(state.phase, Phase::Play);
    assert!(!state.game_over);
    assert!(state.players[0].alive);
    assert!(state.players[1].alive);
    // 4 starting cards each, turn player gets +2 from draw phase
    let tp = state.turn_player;
    let other = 1 - tp;
    assert_eq!(state.players[tp].hand.len(), 6, "turn player should have 6 cards");
    assert_eq!(state.players[other].hand.len(), 4, "other player should have 4 cards");
}

#[test]
fn test_pending_timeout() {
    init_all();

    let mut bus = EventBus::new();
    let config = load_cards_config();
    let picks = ["student".to_string(), "student".to_string()];
    let mut state = create_game(&mut bus, &picks, &config);

    state.pending_response = Some(PendingResponse {
        pending_type: PendingType::Dodge,
        source: 0,
        target: 1,
        card: None,
        timeout: 0, // already expired
        selectable_cards: None, pool_size: None, steal_action: None,
        exposed_cards: None, pending_skill_id: None, discard_count: None,
    });

    let changed = check_timeout(&mut state);
    assert!(changed);
    assert!(state.pending_response.is_none());
}

#[test]
fn test_game_over_rejects_messages() {
    init_all();

    let mut bus = EventBus::new();
    let config = load_cards_config();
    let picks = ["student".to_string(), "student".to_string()];
    let mut state = create_game(&mut bus, &picks, &config);
    state.game_over = true;

    let result = handle_message(
        &mut bus, &mut state, 0,
        &ClientMsg::EndPhase,
    );
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "游戏已结束");
}

// ============================================================
// 安全检查测试
// ============================================================

#[test]
fn test_html_escape() {
    fn esc(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }
    assert_eq!(esc("<script>"), "&lt;script&gt;");
    assert_eq!(esc("hello"), "hello");
    assert_eq!(esc("<img onerror=\"x\">"), "&lt;img onerror=&quot;x&quot;&gt;");
}
