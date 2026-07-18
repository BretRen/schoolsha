// cards.rs — 卡牌定义与操作
// Rust 复刻：对应 Deno TS 的 cards.ts

use crate::types::{Card, CardsConfig, Suit};
use rand::Rng;
use std::sync::atomic::{AtomicU64, Ordering};

/// 卡牌 ID 计数器
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_id() -> String {
    let id = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("C{}", id)
}

/// 卡牌中文显示（用于日志和 CLI）
pub fn card_label(c: &Card) -> String {
    let suit_str = match c.suit {
        Suit::Spade => "♠",
        Suit::Heart => "♥",
        Suit::Club => "♣",
        Suit::Diamond => "♦",
    };
    let num_str = match c.number {
        1 => "A".to_string(),
        11 => "J".to_string(),
        12 => "Q".to_string(),
        13 => "K".to_string(),
        n => n.to_string(),
    };
    format!("{}{} {}", suit_str, num_str, c.name)
}

/// 从 JSON 配置创建牌堆
pub fn create_deck(config: &CardsConfig) -> Vec<Card> {
    ID_COUNTER.store(0, Ordering::Relaxed);
    let mut cards = Vec::new();
    for spec in &config.cards {
        for _ in 0..spec.count {
            cards.push(Card {
                id: next_id(),
                name: spec.name.clone(),
                suit: spec.suit,
                number: spec.number,
                card_type: spec.card_type,
            });
        }
    }
    cards
}

/// Fisher-Yates 洗牌
pub fn shuffle<T>(arr: &mut [T]) {
    let mut rng = rand::thread_rng();
    for i in (1..arr.len()).rev() {
        let j = rng.gen_range(0..=i);
        arr.swap(i, j);
    }
}

/// 从牌堆抽 N 张牌，自动回收弃牌堆
pub fn draw_cards(deck: &mut Vec<Card>, discard: &mut Vec<Card>, count: usize) -> Vec<Card> {
    let mut drawn = Vec::with_capacity(count);
    for _ in 0..count {
        if deck.is_empty() {
            if discard.is_empty() {
                break;
            }
            deck.append(discard); // 回收弃牌堆
            shuffle(deck);
        }
        if let Some(card) = deck.pop() {
            drawn.push(card);
        }
    }
    drawn
}

/// 从手中移除指定 ID 的牌
pub fn remove_card(hand: &mut Vec<Card>, card_id: &str) -> Option<Card> {
    if let Some(idx) = hand.iter().position(|c| c.id == card_id) {
        Some(hand.remove(idx))
    } else {
        None
    }
}

/// 检查手中是否有某张牌
pub fn has_card(hand: &[Card], card_id: &str) -> bool {
    hand.iter().any(|c| c.id == card_id)
}
