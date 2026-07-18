// schoolsha — 三国杀风格卡牌游戏后端（Rust 复刻）
// 模块声明

pub mod types;
pub mod cards;
pub mod events;
pub mod effects;
pub mod game;
pub mod skills;
pub mod auth;
pub mod room;
pub mod elo;
pub mod matchmaking;

mod config;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "schoolsha=info".into()),
        )
        .init();

    tracing::info!("学校杀 Rust 后端启动中...");

    // TODO: 加载配置、启动 WebSocket 服务器
}
