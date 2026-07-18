// room.rs — 房间管理器
// Rust 复刻：对应 Deno TS 的 room.ts

use crate::types::ServerMsg;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use rand::Rng;

// ============================================================
// Room
// ============================================================

pub struct Room {
    pub code: String,
    pub clients: [Option<ClientInfo>; 2],
    pub picks: [Option<String>; 2],
    pub locked: [bool; 2],
    pub is_match: bool,
    pub game_started: bool,
    pub select_timer: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub struct ClientInfo {
    pub user_id: String,
    pub display_name: String,
    pub sender: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
}

impl Room {
    pub fn new(code: String, is_match: bool) -> Self {
        Room {
            code,
            clients: [None, None],
            picks: [None, None],
            locked: [false, false],
            is_match,
            game_started: false,
            select_timer: None,
        }
    }

    pub fn is_full(&self) -> bool {
        self.clients[0].is_some() && self.clients[1].is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.clients[0].is_none() && self.clients[1].is_none()
    }

    pub fn broadcast(&self, msg: &ServerMsg) {
        for client in self.clients.iter().flatten() {
            let _ = client.sender.send(msg.clone());
        }
    }

    pub fn send_to(&self, idx: usize, msg: &ServerMsg) {
        if let Some(client) = &self.clients[idx] {
            let _ = client.sender.send(msg.clone());
        }
    }
}

// ============================================================
// RoomManager
// ============================================================

pub struct RoomManager {
    rooms: HashMap<String, Arc<Mutex<Room>>>,
}

impl RoomManager {
    pub fn new() -> Self {
        RoomManager {
            rooms: HashMap::new(),
        }
    }

    pub fn create_room(&mut self, is_match: bool) -> Arc<Mutex<Room>> {
        let code = generate_room_code();
        let room = Arc::new(Mutex::new(Room::new(code.clone(), is_match)));
        self.rooms.insert(code, room.clone());
        room
    }

    pub fn get_room(&self, code: &str) -> Option<Arc<Mutex<Room>>> {
        self.rooms.get(code).cloned()
    }

    pub fn get_or_create_room(&mut self, code: &str, is_match: bool) -> Arc<Mutex<Room>> {
        if let Some(room) = self.rooms.get(code) {
            return room.clone();
        }
        let room = Arc::new(Mutex::new(Room::new(code.to_string(), is_match)));
        self.rooms.insert(code.to_string(), room.clone());
        room
    }

    /// 从其他所有房间踢出同一用户
    pub fn kick_user_from_other_rooms(&self, user_id: &str, except_room: &str) {
        for room in self.rooms.values() {
            let mut r = room.lock();
            if r.code == except_room {
                continue;
            }
            for idx in 0..2 {
                let should_kick = r.clients[idx].as_ref().map_or(false, |c| c.user_id == user_id);
                if should_kick {
                    if let Some(c) = r.clients[idx].take() {
                        let _ = c.sender.send(ServerMsg::Error {
                            message: "你在另一房间加入了游戏".into(),
                        });
                    }
                }
            }
        }
    }

    /// 查找指定用户的断线对局
    pub fn find_disconnected_games(&self, user_id: &str) -> Vec<DisconnectedGame> {
        let mut games = Vec::new();
        for room in self.rooms.values() {
            let r = room.lock();
            if r.game_started {
                for idx in 0..2 {
                    if r.clients[idx].as_ref().map_or(false, |c| c.user_id == user_id) {
                        let opp_idx = 1 - idx;
                        if let Some(opp) = &r.clients[opp_idx] {
                            games.push(DisconnectedGame {
                                room_code: r.code.clone(),
                                opponent: opp.display_name.clone(),
                                disconnected_at: chrono::Utc::now().timestamp(),
                            });
                        }
                    }
                }
            }
        }
        games
    }

    /// 清理过期房间
    pub fn cleanup(&mut self) {
        self.rooms.retain(|_, room| {
            let r = room.lock();
            !r.is_empty() || r.game_started
        });
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DisconnectedGame {
    #[serde(rename = "roomCode")]
    pub room_code: String,
    pub opponent: String,
    #[serde(rename = "disconnectedAt")]
    pub disconnected_at: i64,
}

fn generate_room_code() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..6).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}
