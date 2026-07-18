// events.rs — 事件系统（技能系统的核心入口）
// Rust 复刻：对应 Deno TS 的 events.ts

use crate::types::{Card, GameState, Phase};

// ============================================================
// 事件类型
// ============================================================

#[derive(Debug, Clone)]
pub enum GameEvent {
    PhaseEnter { phase: Phase, player: usize },
    PhaseExit { phase: Phase, player: usize },
    DrawCard { player: usize, cards: Vec<Card> },
    CardPlayed { player: usize, card: Card, target: Option<usize> },
    CardDiscarded { player: usize, cards: Vec<Card> },
    Damage { source: usize, target: usize, amount: u32 },
    Heal { player: usize, amount: u32 },
    PlayerDeath { player: usize },
    TurnStart { player: usize },
    TurnEnd { player: usize },
}

impl GameEvent {
    pub fn event_type(&self) -> &'static str {
        match self {
            GameEvent::PhaseEnter { .. } => "phase_enter",
            GameEvent::PhaseExit { .. } => "phase_exit",
            GameEvent::DrawCard { .. } => "draw_card",
            GameEvent::CardPlayed { .. } => "card_played",
            GameEvent::CardDiscarded { .. } => "card_discarded",
            GameEvent::Damage { .. } => "damage",
            GameEvent::Heal { .. } => "heal",
            GameEvent::PlayerDeath { .. } => "player_death",
            GameEvent::TurnStart { .. } => "turn_start",
            GameEvent::TurnEnd { .. } => "turn_end",
        }
    }
}

// ============================================================
// 事件总线
// ============================================================

pub type EventHandlerFn = Box<dyn FnMut(&GameEvent, &mut GameState) + Send>;

struct RegisteredHandler {
    event_types: Vec<String>,
    handler: EventHandlerFn,
}

/// 全局事件处理器列表（技能被动技在这里注册）
/// 注意：每局开始时需调用 clear_all_handlers()
pub struct EventBus {
    handlers: Vec<RegisteredHandler>,
}

impl EventBus {
    pub fn new() -> Self {
        EventBus {
            handlers: Vec::new(),
        }
    }

    /// 清除所有处理器（每局开始时调用）
    pub fn clear_all(&mut self) {
        self.handlers.clear();
    }

    /// 注册事件处理器
    /// event_types: 要监听的 GameEvent 类型列表（如 ["draw_card", "damage"]）
    /// 返回一个 token，可用于取消注册
    pub fn on_event(
        &mut self,
        event_types: Vec<String>,
        handler: EventHandlerFn,
    ) -> usize {
        let id = self.handlers.len();
        self.handlers.push(RegisteredHandler {
            event_types,
            handler,
        });
        id
    }

    /// 取消注册（通过 token）
    pub fn off_event(&mut self, token: usize) {
        if token < self.handlers.len() {
            self.handlers.remove(token);
        }
    }

    /// 触发事件。遍历所有监听该事件类型的 handler。
    pub fn emit(&mut self, event: GameEvent, state: &mut GameState) {
        let event_type = event.event_type();
        tracing::debug!(
            "[Event] {} {:?}",
            event_type,
            // 截断避免日志太长
            &format!("{:?}", event).chars().take(120).collect::<String>()
        );

        // 收集匹配的 handler 索引（因为不能同时 borrow self.handlers 和调用 handler）
        let matching: Vec<usize> = self
            .handlers
            .iter()
            .enumerate()
            .filter(|(_, h)| h.event_types.iter().any(|t| t == event_type))
            .map(|(i, _)| i)
            .collect();

        for idx in matching {
            if let Some(h) = self.handlers.get_mut(idx) {
                (h.handler)(&event, state);
            }
        }
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
