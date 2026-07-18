// config.rs — 配置加载
// 从 JSON 配置文件加载卡牌、角色、技能定义

use crate::types::{CardsConfig, CharactersConfig, SkillsConfig};
use std::env;
use std::path::Path;

pub struct AppConfig {
    pub port: u16,
    pub auth_enabled: bool,
    pub zitadel_client_id: Option<String>,
    pub zitadel_issuer: String,
    pub public_url: String,
    pub data_dir: String,
}

impl AppConfig {
    pub fn load() -> Self {
        let port: u16 = env::var("PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8099);

        let zitadel_client_id = env::var("ZITADEL_CLIENT_ID").ok()
            .filter(|s| !s.is_empty());

        let zitadel_issuer = env::var("ZITADEL_ISSUER")
            .unwrap_or_else(|_| "https://auth.pdnode.com".to_string());

        let public_url = env::var("PUBLIC_URL")
            .unwrap_or_else(|_| format!("http://localhost:{}", port));

        AppConfig {
            port,
            auth_enabled: zitadel_client_id.is_some(),
            zitadel_client_id,
            zitadel_issuer,
            public_url,
            data_dir: ".".to_string(),
        }
    }
}

/// 加载卡牌配置
pub fn load_cards(data_dir: &str) -> CardsConfig {
    let path = Path::new(data_dir).join("cards.json");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("无法读取 {}", path.display()));
    serde_json::from_str(&content)
        .unwrap_or_else(|e| panic!("cards.json 解析失败: {}", e))
}

/// 加载角色配置
pub fn load_characters(data_dir: &str) -> CharactersConfig {
    let path = Path::new(data_dir).join("characters.json");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("无法读取 {}", path.display()));
    serde_json::from_str(&content)
        .unwrap_or_else(|e| panic!("characters.json 解析失败: {}", e))
}

/// 加载技能配置
pub fn load_skills(data_dir: &str) -> SkillsConfig {
    let path = Path::new(data_dir).join("skills.json");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("无法读取 {}", path.display()));
    serde_json::from_str(&content)
        .unwrap_or_else(|e| panic!("skills.json 解析失败: {}", e))
}
