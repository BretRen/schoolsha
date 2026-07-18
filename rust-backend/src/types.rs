// types.rs — 所有类型和常量
// Rust 复刻：对应 Deno TS 的 types.ts

use serde::{Deserialize, Serialize};

// ============================================================
// 基础枚举
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Suit {
    Spade,
    Heart,
    Club,
    Diamond,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Judge,
    Draw,
    Play,
    Discard,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardType {
    Basic,
    Trick,
    Weapon,
    Armor,
    Effect,
}

// ============================================================
// 卡牌
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    pub name: String,
    pub suit: Suit,
    pub number: u8,
    #[serde(rename = "type")]
    pub card_type: CardType,
}

// ============================================================
// 玩家
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Player {
    pub hp: i32,
    pub max_hp: i32,
    pub hand: Vec<Card>,
    pub alive: bool,
    #[serde(rename = "characterId")]
    pub character_id: Option<String>,
    pub weapon: Option<Card>,
    pub armor: Option<Card>,
}

// ============================================================
// Pending — 交互锁（11 种类型）
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingType {
    Dodge,
    NearDeath,
    Duel,
    Barbarian,
    Volley,
    BorrowKnife,
    Steal,
    SkillDiscard,
    OpponentDiscard,
    JudgeArmor,
    PickDiscard,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingResponse {
    #[serde(rename = "type")]
    pub pending_type: PendingType,
    pub source: usize,
    pub target: usize,
    pub card: Option<Card>,
    pub timeout: u64, // ms timestamp, like Date.now()
    #[serde(rename = "selectableCards", skip_serializing_if = "Option::is_none")]
    pub selectable_cards: Option<Vec<Card>>,
    #[serde(rename = "poolSize", skip_serializing_if = "Option::is_none")]
    pub pool_size: Option<usize>,
    #[serde(rename = "stealAction", skip_serializing_if = "Option::is_none")]
    pub steal_action: Option<StealAction>,
    #[serde(rename = "exposedCards", skip_serializing_if = "Option::is_none")]
    pub exposed_cards: Option<Vec<ExposedCard>>,
    #[serde(rename = "pendingSkillId", skip_serializing_if = "Option::is_none")]
    pub pending_skill_id: Option<String>,
    #[serde(rename = "discardCount", skip_serializing_if = "Option::is_none")]
    pub discard_count: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StealAction {
    Steal,
    Discard,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExposedCard {
    pub card: Card,
    pub position: usize,
}

// ============================================================
// 游戏状态
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameState {
    pub phase: Phase,
    #[serde(rename = "turnPlayer")]
    pub turn_player: usize,
    pub players: [Player; 2],
    pub deck: Vec<Card>,
    pub discard: Vec<Card>,
    #[serde(rename = "attackUsed")]
    pub attack_used: bool,
    #[serde(rename = "pendingResponse")]
    pub pending_response: Option<PendingResponse>,
    #[serde(rename = "gameOver")]
    pub game_over: bool,
    pub winner: Option<usize>,
    #[serde(rename = "turnStartTime")]
    pub turn_start_time: u64,
    #[serde(rename = "disconnectCount")]
    pub disconnect_count: [u32; 2],
    #[serde(rename = "disconnectedAt")]
    pub disconnected_at: [Option<u64>; 2],
    #[serde(rename = "wineUsed")]
    pub wine_used: [bool; 2],
    #[serde(rename = "skipNextPlay")]
    pub skip_next_play: Option<usize>,
    #[serde(rename = "skillUseCount")]
    pub skill_use_count: std::collections::HashMap<String, u32>,
    pub log: Vec<LogEntry>,
}

// ============================================================
// 结构化日志（便于 i18n）
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "id")]
pub enum LogEntry {
    #[serde(rename = "card_played")]
    CardPlayed {
        player: usize,
        #[serde(rename = "cardName")]
        card_name: String,
        target: Option<usize>,
    },
    #[serde(rename = "card_equipped")]
    CardEquipped {
        player: usize,
        #[serde(rename = "cardName")]
        card_name: String,
    },
    #[serde(rename = "damage")]
    Damage {
        player: usize,
        amount: u32,
    },
    #[serde(rename = "heal")]
    Heal {
        player: usize,
        amount: u32,
    },
    #[serde(rename = "skill_used")]
    SkillUsed {
        player: usize,
        #[serde(rename = "skillName")]
        skill_name: String,
    },
    #[serde(rename = "phase")]
    Phase {
        player: usize,
        phase: String,
    },
    #[serde(rename = "draw")]
    Draw {
        player: usize,
        count: u32,
    },
    #[serde(rename = "discard")]
    Discard {
        player: usize,
        #[serde(rename = "cardName")]
        card_name: String,
    },
    #[serde(rename = "card_discarded")]
    CardDiscarded {
        player: usize,
        #[serde(rename = "cardName")]
        card_name: String,
    },
    #[serde(rename = "death")]
    Death { player: usize },
    #[serde(rename = "judge_result")]
    JudgeResult {
        player: usize,
        #[serde(rename = "cardName")]
        card_name: String,
        suit: String,
        result: String,
    },
}

// ============================================================
// JSON 配置类型
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardSpec {
    pub name: String,
    pub suit: Suit,
    pub number: u8,
    pub count: u8,
    #[serde(rename = "type")]
    pub card_type: CardType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardsConfig {
    pub cards: Vec<CardSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDef {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub skill_type: SkillType,
    pub trigger: Option<SkillTrigger>,
    pub effect: Option<SkillEffect>,
    #[serde(default, rename = "perTurn")]
    pub per_turn: Option<u32>,
    pub cost: Option<SkillCost>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillType {
    Active,
    Passive,
    Locked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillTrigger {
    pub event: Option<String>,
    pub phase: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SkillEffect {
    #[serde(rename = "damage")]
    Damage { amount: u32 },
    #[serde(rename = "heal")]
    SkillHeal { amount: u32 },
    #[serde(rename = "draw_cards")]
    SkillDraw { count: u32 },
    #[serde(rename = "force_discard")]
    ForceDiscard { count: u32 },
    #[serde(rename = "hand_limit_bonus")]
    HandLimitBonus { amount: i32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCost {
    pub discard: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillsConfig {
    pub skills: Vec<SkillDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterDef {
    pub id: String,
    pub name: String,
    #[serde(rename = "maxHp")]
    pub max_hp: i32,
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharactersConfig {
    pub characters: Vec<CharacterDef>,
}

// ============================================================
// WebSocket 客户端消息
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum ClientMsg {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "pick_character")]
    PickCharacter { id: String },
    #[serde(rename = "play_card")]
    PlayCard {
        #[serde(rename = "card_id")]
        card_id: String,
        target: Option<usize>,
    },
    #[serde(rename = "use_skill")]
    UseSkill {
        #[serde(rename = "skill_id")]
        skill_id: String,
        target: Option<usize>,
    },
    #[serde(rename = "end_phase")]
    EndPhase,
    #[serde(rename = "discard")]
    Discard {
        #[serde(rename = "card_ids")]
        card_ids: Vec<String>,
    },
    #[serde(rename = "steal_card")]
    StealCard {
        #[serde(rename = "card_id")]
        card_id: Option<String>,
        position: Option<usize>,
    },
    #[serde(rename = "pass")]
    Pass,
    #[serde(rename = "respond")]
    Respond {
        #[serde(rename = "card_id")]
        card_id: String,
    },
    #[serde(rename = "reconnect")]
    Reconnect { seat: usize },
    #[serde(rename = "confirm_skill")]
    ConfirmSkill {
        #[serde(rename = "card_ids")]
        card_ids: Vec<String>,
    },
    #[serde(rename = "lock_character")]
    LockCharacter,
    #[serde(rename = "activate_armor")]
    ActivateArmor,
    #[serde(rename = "ping")]
    Ping { ts: u64 },
}

impl ClientMsg {
    pub fn action_name(&self) -> &'static str {
        match self {
            ClientMsg::Ready => "ready",
            ClientMsg::PickCharacter { .. } => "pick_character",
            ClientMsg::PlayCard { .. } => "play_card",
            ClientMsg::UseSkill { .. } => "use_skill",
            ClientMsg::EndPhase => "end_phase",
            ClientMsg::Discard { .. } => "discard",
            ClientMsg::StealCard { .. } => "steal_card",
            ClientMsg::Pass => "pass",
            ClientMsg::Respond { .. } => "respond",
            ClientMsg::Reconnect { .. } => "reconnect",
            ClientMsg::ConfirmSkill { .. } => "confirm_skill",
            ClientMsg::LockCharacter => "lock_character",
            ClientMsg::ActivateArmor => "activate_armor",
            ClientMsg::Ping { .. } => "ping",
        }
    }
}

// ============================================================
// 角色 / 技能视图
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "maxHp")]
    pub max_hp: i32,
    pub skills: Vec<SkillRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillView {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub skill_type: String,
}

// ============================================================
// 玩家视图（对对手隐藏手牌）
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerView {
    pub hp: i32,
    #[serde(rename = "maxHp")]
    pub max_hp: i32,
    #[serde(rename = "handCount")]
    pub hand_count: usize,
    pub alive: bool,
    #[serde(rename = "characterId")]
    pub character_id: Option<String>,
    pub weapon: Option<Card>,
    pub armor: Option<Card>,
    pub skills: Vec<SkillView>,
}

// ============================================================
// 服务端视图（下发给每个玩家）
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerStateView {
    pub phase: Phase,
    #[serde(rename = "turnPlayer")]
    pub turn_player: usize,
    pub you: PlayerYouView,
    pub opponent: PlayerView,
    #[serde(rename = "attackUsed")]
    pub attack_used: bool,
    #[serde(rename = "pendingResponse")]
    pub pending_response: Option<PendingResponse>,
    #[serde(rename = "gameOver")]
    pub game_over: bool,
    pub winner: Option<usize>,
    #[serde(rename = "deckCount")]
    pub deck_count: usize,
    #[serde(rename = "turnTimeLeft")]
    pub turn_time_left: u64,
    #[serde(rename = "opponentDisconnected")]
    pub opponent_disconnected: bool,
    #[serde(rename = "playerName")]
    pub player_name: String,
    #[serde(rename = "playerId")]
    pub player_id: String,
    #[serde(rename = "opponentName")]
    pub opponent_name: String,
    #[serde(rename = "opponentId")]
    pub opponent_id: String,
    #[serde(rename = "handLimit")]
    pub hand_limit: usize,
    #[serde(rename = "skillUseCount")]
    pub skill_use_count: std::collections::HashMap<String, u32>,
    pub log: Vec<LogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerYouView {
    pub hp: i32,
    #[serde(rename = "maxHp")]
    pub max_hp: i32,
    pub hand: Vec<Card>,
    pub alive: bool,
    #[serde(rename = "characterId")]
    pub character_id: Option<String>,
    pub skills: Vec<SkillView>,
    pub weapon: Option<Card>,
    pub armor: Option<Card>,
}

// ============================================================
// 服务端消息（下发给客户端）
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMsg {
    #[serde(rename = "character_select")]
    CharacterSelect {
        characters: Vec<CharacterInfo>,
        #[serde(rename = "timeoutSec")]
        timeout_sec: u32,
        opponent: Option<OpponentInfo>,
        elo: Option<EloPreview>,
    },
    #[serde(rename = "game_state")]
    GameState {
        state: ServerStateView,
        #[serde(rename = "yourIndex")]
        your_index: usize,
        #[serde(rename = "eloResult")]
        elo_result: Option<EloResult>,
    },
    #[serde(rename = "waiting")]
    Waiting { message: String },
    #[serde(rename = "disconnected")]
    Disconnected {
        message: String,
        #[serde(rename = "attemptsLeft")]
        attempts_left: u32,
    },
    #[serde(rename = "room_created")]
    RoomCreated {
        code: String,
        #[serde(rename = "inviteUrl")]
        invite_url: String,
        #[serde(rename = "wsUrl")]
        ws_url: String,
    },
    #[serde(rename = "reconnected")]
    Reconnected { message: String },
    #[serde(rename = "opponent_reconnected")]
    OpponentReconnected,
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "queue_status")]
    QueueStatus {
        status: String,
        position: usize,
        #[serde(rename = "estimatedWait")]
        estimated_wait: String,
    },
    #[serde(rename = "match_found")]
    MatchFound {
        room: String,
        opponent: OpponentEloInfo,
    },
    #[serde(rename = "queue_timeout")]
    QueueTimeout { message: String },
    #[serde(rename = "opponent_picked")]
    OpponentPicked { picked: bool },
    #[serde(rename = "opponent_locked")]
    OpponentLocked { locked: bool },
    #[serde(rename = "opponent_left_win")]
    OpponentLeftWin {
        message: String,
        title: Option<String>,
        #[serde(rename = "eloResult")]
        elo_result: Option<EloResult>,
    },
    #[serde(rename = "pong")]
    Pong { ts: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpponentInfo {
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub elo: i32,
    #[serde(rename = "userId")]
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpponentEloInfo {
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub elo: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EloPreview {
    #[serde(rename = "my")]
    pub my: i32,
    pub prediction: Option<EloPrediction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EloPrediction {
    pub win: i32,
    pub lose: i32,
}

impl From<crate::elo::EloPrediction> for EloPrediction {
    fn from(p: crate::elo::EloPrediction) -> Self {
        EloPrediction { win: p.win, lose: p.lose }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EloResult {
    pub change: i32,
    #[serde(rename = "newElo")]
    pub new_elo: i32,
    #[serde(rename = "opponentChange")]
    pub opponent_change: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub code: String,
    #[serde(rename = "wsUrl")]
    pub ws_url: String,
    #[serde(rename = "inviteUrl")]
    pub invite_url: String,
    #[serde(rename = "deepLink")]
    pub deep_link: String,
}

// ============================================================
// 游戏常量
// ============================================================

/// 回合超时（秒）
pub const TURN_TIMEOUT_SEC: u64 = 45;

/// Pending 响应超时（秒）
pub const PENDING_TIMEOUT_SEC: u64 = 15;

/// Steal 响应超时（秒）
pub const STEAL_TIMEOUT_SEC: u64 = 10;

/// 选角超时（秒）
pub const CHARACTER_SELECT_TIMEOUT_SEC: u64 = 30;

/// 最大断线次数
pub const MAX_DISCONNECTS: u32 = 3;

/// 断线重连窗口（秒）
pub const RECONNECT_WINDOW_SEC: u64 = 30;

/// 默认 ELO
pub const DEFAULT_ELO: i32 = 1000;

/// ELO K 因子
pub const ELO_K: f64 = 32.0;

/// 最大手牌日志条数
pub const MAX_LOG_ENTRIES: usize = 50;
