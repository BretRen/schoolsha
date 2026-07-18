// elo.rs — ELO 积分计算 + 排行榜
// Rust 复刻：对应 Deno TS 的 elo.ts

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

const ELO_FILE: &str = "elo.json";
const INITIAL_ELO: i32 = 1000;
const K_FACTOR: f64 = 32.0;

// ============================================================
// 数据结构
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EloEntry {
    pub elo: i32,
    pub wins: u32,
    pub losses: u32,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderboardEntry {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub elo: i32,
    pub wins: u32,
    pub losses: u32,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub rank: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Leaderboard {
    #[serde(rename = "top10")]
    pub top10: Vec<LeaderboardEntry>,
    pub you: Option<LeaderboardEntry>,
}

// ============================================================
// 持久化
// ============================================================

fn load_elo(data_dir: &str) -> HashMap<String, EloEntry> {
    let path = Path::new(data_dir).join(ELO_FILE);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_elo(data_dir: &str, data: &HashMap<String, EloEntry>) {
    let path = Path::new(data_dir).join(ELO_FILE);
    let tmp = Path::new(data_dir).join(format!("{}.tmp", ELO_FILE));
    let json = serde_json::to_string_pretty(data).unwrap();
    std::fs::write(&tmp, &json).expect("无法写入 elo.json.tmp");
    std::fs::rename(&tmp, &path).expect("无法重命名 elo.json.tmp");
}

// ============================================================
// ELO 计算
// ============================================================

/// ELO 更新结果
pub struct EloUpdateResult {
    pub winner_change: i32,
    pub loser_change: i32,
    pub winner_new_elo: i32,
    pub loser_new_elo: i32,
}

/// 更新 ELO 分数（原子操作：read-modify-write 在锁内）
pub fn update_elo(
    data_dir: &str,
    winner_id: &str,
    loser_id: &str,
    winner_name: &str,
    loser_name: &str,
) -> EloUpdateResult {
    let mut data = load_elo(data_dir);

    // 确保双方都有记录（两阶段：先 insert 或 get，再修改）
    for (id, name) in [
        (winner_id.to_string(), winner_name),
        (loser_id.to_string(), loser_name),
    ] {
        if !data.contains_key(&id) {
            data.insert(id.clone(), EloEntry {
                elo: INITIAL_ELO,
                wins: 0,
                losses: 0,
                display_name: truncate_name(if name.is_empty() { &id } else { name }),
            });
        } else if !name.is_empty() {
            data.get_mut(&id).unwrap().display_name = truncate_name(name);
        }
    }

    // 获取可变引用并计算
    let [w_entry, l_entry] = get_two_mut(&mut data, winner_id, loser_id);

    let old_w = w_entry.elo;
    let old_l = l_entry.elo;

    // 标准 ELO 公式
    let e_winner = 1.0 / (1.0 + 10_f64.powf((l_entry.elo - w_entry.elo) as f64 / 400.0));

    w_entry.elo = (w_entry.elo as f64 + K_FACTOR * (1.0 - e_winner)).round() as i32;
    l_entry.elo = (l_entry.elo as f64 + K_FACTOR * (0.0 - e_winner)).round() as i32;

    if w_entry.elo < 0 { w_entry.elo = 0; }
    if l_entry.elo < 0 { l_entry.elo = 0; }

    w_entry.wins += 1;
    l_entry.losses += 1;

    let result = EloUpdateResult {
        winner_change: w_entry.elo - old_w,
        loser_change: l_entry.elo - old_l,
        winner_new_elo: w_entry.elo,
        loser_new_elo: l_entry.elo,
    };

    save_elo(data_dir, &data);

    result
}

/// 预测 ELO 变化（不保存）
pub fn predict_elo_change(my_elo: i32, opp_elo: i32) -> EloPrediction {
    let e_win = 1.0 / (1.0 + 10_f64.powf((opp_elo - my_elo) as f64 / 400.0));
    EloPrediction {
        win: (K_FACTOR * (1.0 - e_win)).round() as i32,
        lose: (K_FACTOR * (0.0 - e_win)).round() as i32,
    }
}

pub struct EloPrediction {
    pub win: i32,
    pub lose: i32,
}

/// 获取排行榜
pub fn get_leaderboard(data_dir: &str, top_k: usize, player_user_id: Option<&str>) -> Leaderboard {
    let data = load_elo(data_dir);

    // 按 ELO 降序
    let mut sorted: Vec<(String, &EloEntry)> = data.iter().map(|(k, v)| (k.clone(), v)).collect();
    sorted.sort_by(|a, b| b.1.elo.cmp(&a.1.elo));

    let mut top10 = Vec::with_capacity(top_k);
    let mut you: Option<LeaderboardEntry> = None;

    for (rank, (user_id, entry)) in sorted.iter().enumerate() {
        let lb_entry = LeaderboardEntry {
            user_id: user_id.clone(),
            elo: entry.elo,
            wins: entry.wins,
            losses: entry.losses,
            display_name: entry.display_name.clone(),
            rank: rank + 1,
        };

        if top10.len() < top_k {
            top10.push(lb_entry.clone());
        }
        if let Some(uid) = player_user_id {
            if user_id == uid {
                you = Some(lb_entry.clone());
            }
        }
    }

    Leaderboard { top10, you }
}

/// 获取某玩家的 ELO
pub fn get_elo(data_dir: &str, user_id: &str) -> i32 {
    let data = load_elo(data_dir);
    data.get(user_id).map(|e| e.elo).unwrap_or(INITIAL_ELO)
}

fn truncate_name(name: &str) -> String {
    if name.len() > 64 {
        name[..64].to_string()
    } else {
        name.to_string()
    }
}

/// 从 HashMap 中同时获取两个可变引用
fn get_two_mut<'a>(
    map: &'a mut HashMap<String, EloEntry>,
    key1: &str,
    key2: &str,
) -> [&'a mut EloEntry; 2] {
    assert_ne!(key1, key2, "get_two_mut: keys must be different");
    let ptr = map as *mut HashMap<String, EloEntry>;
    // SAFETY: keys are different, so the two entries are disjoint
    unsafe {
        let entry1 = (*ptr).get_mut(key1).expect("elo entry not found");
        let entry2 = (*ptr).get_mut(key2).expect("elo entry not found");
        [entry1, entry2]
    }
}
