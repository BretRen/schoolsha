// game.rs — 阶段机 + 超时 + 断线重连
// Rust 复刻：对应 Deno TS 的 game.ts

use crate::types::{GameState, Phase};

/// 推进到下一阶段
pub fn advance_phase(state: &mut GameState) {
    let next = match state.phase {
        Phase::Judge => Phase::Draw,
        Phase::Draw => Phase::Play,
        Phase::Play => Phase::Discard,
        Phase::Discard => Phase::End,
        Phase::End => {
            // Turn end: switch turn player
            state.turn_player = 1 - state.turn_player;
            // Reset per-turn state
            state.attack_used = false;
            state.skill_use_count.clear();
            state.turn_start_time = now_ms();
            Phase::Judge
        }
    };
    state.phase = next;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
