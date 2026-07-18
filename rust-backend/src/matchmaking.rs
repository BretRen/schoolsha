// matchmaking.rs — 匹配队列
// Rust 复刻：对应 Deno TS 的 matchmaking.ts

use crate::elo::{get_elo, predict_elo_change, EloPrediction};

use crate::types::ServerMsg;
use std::time::{Duration, Instant};

const MAX_ELO_DIFF: i32 = 300;
const MATCHMAKING_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone)]
pub struct QueuedPlayer {
    pub user_id: String,
    pub display_name: String,
    pub elo: i32,
    pub sender: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
    pub joined_at: Instant,
}

pub struct MatchmakingQueue {
    queue: Vec<QueuedPlayer>,
    data_dir: String,
}

impl MatchmakingQueue {
    pub fn new(data_dir: &str) -> Self {
        MatchmakingQueue {
            queue: Vec::new(),
            data_dir: data_dir.to_string(),
        }
    }

    pub fn join(
        &mut self,
        user_id: &str,
        display_name: &str,
        sender: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
    ) -> usize {
        // Remove existing entry for this user
        self.queue.retain(|p| p.user_id != user_id);

        let elo = get_elo(&self.data_dir, user_id);
        let player = QueuedPlayer {
            user_id: user_id.to_string(),
            display_name: display_name.to_string(),
            elo,
            sender,
            joined_at: Instant::now(),
        };

        let position = self.queue.len() + 1;
        self.queue.push(player);
        position
    }

    pub fn leave(&mut self, user_id: &str) {
        self.queue.retain(|p| p.user_id != user_id);
    }

    /// Try to find a match. Returns (player1, player2) if matched.
    pub fn try_match(&mut self) -> Option<(QueuedPlayer, QueuedPlayer, EloPrediction)> {
        if self.queue.len() < 2 {
            return None;
        }

        let p1 = &self.queue[0];
        // Find closest ELO match
        let mut best_idx = None;
        let mut best_diff = i32::MAX;

        for (i, p2) in self.queue.iter().enumerate().skip(1) {
            let diff = (p1.elo - p2.elo).abs();
            if diff < MAX_ELO_DIFF && diff < best_diff {
                best_diff = diff;
                best_idx = Some(i);
            }
        }

        if let Some(idx) = best_idx {
            let p1 = self.queue.remove(0);
            let p2 = self.queue.remove(idx - 1); // -1 because we already removed p1
            let prediction = predict_elo_change(p1.elo, p2.elo);
            Some((p1, p2, prediction))
        } else {
            // Check if oldest player has timed out
            if self.queue[0].joined_at.elapsed() > Duration::from_secs(MATCHMAKING_TIMEOUT_SECS) {
                let player = self.queue.remove(0);
                let _ = player.sender.send(ServerMsg::QueueTimeout {
                    message: "匹配超时，请重试".into(),
                });
            }
            None
        }
    }
}
