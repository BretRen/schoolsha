// main.rs — WebSocket 服务器入口
// Rust 复刻：对应 Deno TS 的 main.ts

mod types;
mod cards;
mod events;
mod effects;
mod game;
mod skills;
mod auth;
mod room;
mod elo;
mod matchmaking;
mod config;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use config::{AppConfig, load_cards, load_characters, load_skills};
use events::EventBus;
use game::{check_timeout, create_game, get_player_view, handle_message, mark_disconnected};
use parking_lot::Mutex;
use room::RoomManager;
use skills::init as init_skills;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::{info, warn};
use types::GameState;

struct AppState {
    config: AppConfig,
    rooms: Mutex<RoomManager>,
    games: Mutex<HashMap<String, GameWithBus>>,
    cards_config: types::CardsConfig,
}

struct GameWithBus {
    state: GameState,
    bus: EventBus,
    room_code: String,
}

#[derive(Debug, serde::Deserialize)]
struct WsParams {
    room: Option<String>,
    token: Option<String>,
    mode: Option<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "schoolsha=info".into()),
        )
        .init();

    let config = AppConfig::load();
    let data_dir = &config.data_dir;
    let cards_config = load_cards(data_dir);
    let characters = load_characters(data_dir);
    let skills = load_skills(data_dir);

    // Initialize effects registry
    effects::init_effects();
    // Initialize skills
    init_skills(&characters, &skills);

    info!("学校杀 Rust 后端启动于端口 {}", config.port);

    let state = Arc::new(AppState {
        config,
        rooms: Mutex::new(RoomManager::new()),
        games: Mutex::new(HashMap::new()),
        cards_config,
    });

    // Spawn cleanup task
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            cleanup_state.rooms.lock().cleanup();
            // Cleanup finished games
            cleanup_state.games.lock().retain(|_, g| !g.state.game_over);
        }
    });

    // Spawn timeout checker
    let timeout_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let mut games = timeout_state.games.lock();
            for (code, game) in games.iter_mut() {
                let mut bus = std::mem::take(&mut game.bus);
                let changed = check_timeout(&mut game.state);
                game.bus = bus;
                if changed {
                    // Broadcast updated game state
                    let room = timeout_state.rooms.lock().get_room(code);
                    if let Some(room) = room {
                        let room_locked = room.lock();
                        broadcast_game_state(&timeout_state, &room_locked, &game.state, &mut game.bus, code);
                    }
                }
            }
        }
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/info", get(info_handler))
        .route("/room/create", get(create_room_handler))
        .route("/leaderboard", get(leaderboard_handler))
        .route("/api/disconnected-games", get(disconnected_games_handler))
        .route("/invite/{code}", get(invite_handler))
        .route("/{*path}", get(static_handler))
        .route("/", get(index_handler))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8099);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .unwrap();
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .unwrap();
}

async fn invite_handler(axum::extract::Path(code): axum::extract::Path<String>) -> impl IntoResponse {
    Html(format!(r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>学校杀</title></head>
<body>
<script>
sessionStorage.setItem("invite_room", "{}");
location.replace("/");
</script>
<p>正在加入房间...</p>
</body></html>"#, code))
}

async fn info_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "version": "0.1.0-rust",
        "auth": {
            "mode": if state.config.auth_enabled { "zitadel_oidc" } else { "none" },
            "provider": "zitadel",
            "pkce": true,
        },
        "ws": format!("ws://localhost:{}", state.config.port),
    }))
}

async fn create_room_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut rooms = state.rooms.lock();
    let room = rooms.create_room(false);
    let code = room.lock().code.clone();
    let ws_url = format!("wss://schoolsha.games.pdnode.com/ws");
    let invite_url = format!("{}/invite/{}", state.config.public_url, code);
    let deep_link = format!("pdnode://schoolsha/invite/{}", code);

    axum::Json(serde_json::json!({
        "code": code,
        "wsUrl": ws_url,
        "inviteUrl": invite_url,
        "deepLink": deep_link,
    }))
}

/// Serve index.html for the root path
async fn index_handler() -> axum::response::Response {
    serve_static_file("index.html")
}

/// Serve any static file from ../web/
async fn static_handler(axum::extract::Path(path): axum::extract::Path<String>) -> axum::response::Response {
    serve_static_file(&path)
}

fn get_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn serve_static_file(path: &str) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::Response;

    // Path traversal protection
    if path.contains("..") || path.contains('~') || path.contains("\\") {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(axum::body::Body::from("Forbidden"))
            .unwrap();
    }

    let file_path = std::path::Path::new("../web").join(path);

    // Default to index.html for HTML5 history routing
    let final_path = if file_path.extension().is_none() && !path.is_empty() {
        std::path::Path::new("../web").join("index.html")
    } else if path.is_empty() || path == "/" {
        std::path::Path::new("../web").join("index.html")
    } else {
        file_path
    };

    match std::fs::read(&final_path) {
        Ok(data) => {
            let mime = get_mime(&final_path);
            Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .body(axum::body::Body::from(data))
                .unwrap()
        }
        Err(_) => {
            // Fallback to index.html for SPA
            match std::fs::read("../web/index.html") {
                Ok(data) => Response::builder()
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(axum::body::Body::from(data))
                    .unwrap(),
                Err(_) => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(axum::body::Body::from("Not Found"))
                    .unwrap(),
            }
        }
    }
}

async fn leaderboard_handler(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    let lb = elo::get_leaderboard(".", 10, None);
    axum::Json(serde_json::to_value(lb).unwrap())
}

async fn disconnected_games_handler(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    // Extract token from query params
    // Simplified: return empty for now
    axum::Json(serde_json::json!({ "games": [] }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(params): Query<WsParams>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let token = params.token.clone();
    let room_code = params.room.clone();
    let mode = params.mode.clone().unwrap_or_default();

    ws.on_upgrade(move |socket| handle_socket(socket, addr, state, token, room_code, mode))
}

async fn handle_socket(
    mut socket: WebSocket,
    _addr: SocketAddr,
    state: Arc<AppState>,
    token: Option<String>,
    room_code: Option<String>,
    mode: String,
) {
    let user_id: String;
    let display_name: String;

    // Auth
    if state.config.auth_enabled {
        if let Some(t) = &token {
            match auth::validate_token(t, &state.config.zitadel_issuer, state.config.zitadel_client_id.as_deref()).await {
                Some(user) => {
                    user_id = user.sub;
                    display_name = user.display_name;
                    info!(user = %display_name, "[auth] user connected");
                }
                None => {
                    let _ = socket.send(Message::Text(serde_json::to_string(&types::ServerMsg::Error {
                        message: "token 无效或已过期，请重新登录".into(),
                    }).unwrap().into())).await;
                    // socket will be dropped
                    return;
                }
            }
        } else {
            let _ = socket.send(Message::Text(serde_json::to_string(&types::ServerMsg::Error {
                message: "缺少认证 token，请先登录".into(),
            }).unwrap().into())).await;
            // socket will be dropped
            return;
        }
    } else {
        user_id = format!("anon_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis());
        display_name = format!("玩家_{}", &user_id[user_id.len().saturating_sub(6)..]);
    }

    // Create channel for sending ServerMsg to this client
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<types::ServerMsg>();

    // Join/create room
    let (room, assigned_seat) = {
        let mut rooms = state.rooms.lock();
        if let Some(code) = &room_code {
            (rooms.get_or_create_room(code, false), None)
        } else if mode == "matching" {
            // 匹配模式：查找已有匹配房间或创建新房间
            let (r, seat) = rooms.find_or_create_matching_room();
            (r, Some(seat))
        } else {
            // Auto-create room
            (rooms.create_room(false), None)
        }
    };

    let room_code_saved = room.lock().code.clone();

    // Add client to room
    {
        let mut r = room.lock();
        // Find empty seat (use pre-assigned seat for matching mode)
        let seat: usize = assigned_seat.unwrap_or_else(|| {
            if r.clients[0].is_none() { 0 } else if r.clients[1].is_none() { 1 } else {
                // Room full — this shouldn't happen with find_or_create_matching_room
                0
            }
        });
        
        if r.clients[seat].is_some() {
            warn!("Room full");
            let _ = tx.send(types::ServerMsg::Error { message: "房间已满".into() });
            return;
        }

        let client_info = room::ClientInfo {
            user_id: user_id.clone(),
            display_name: display_name.clone(),
            sender: tx.clone(),
            
        };
        r.clients[seat] = Some(client_info);

        // Send queue_status for matching, waiting for room joins
        if !r.is_full() {
            if r.is_match {
                let _ = tx.send(types::ServerMsg::QueueStatus {
                    status: "matching".into(),
                    position: 1,
                    estimated_wait: "未知".into(),
                });
            } else {
                let _ = tx.send(types::ServerMsg::Waiting {
                    message: format!("房间 {} — 等待对手加入...", r.code),
                });
            }
        }

        // If room is now full, start character select
        if r.is_full() {
            let chars = skills::get_all_characters();
            let char_infos: Vec<types::CharacterInfo> = chars.iter().map(|c| {
                types::CharacterInfo {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    max_hp: c.max_hp,
                    skills: c.skills.iter().map(|sid| {
                        let sk = skills::get_skill(sid);
                        types::SkillRef {
                            id: sid.clone(),
                            name: sk.map_or(sid.clone(), |s| s.name.clone()),
                        }
                    }).collect(),
                }
            }).collect();

            for (idx, client) in r.clients.iter().enumerate() {
                if let Some(c) = client {
                    let opp_idx = 1 - idx;
                    let opp_info = r.clients[opp_idx].as_ref().map(|opp| {
                        types::OpponentInfo {
                            display_name: opp.display_name.clone(),
                            elo: elo::get_elo(".", &opp.user_id),
                            user_id: opp.user_id.clone(),
                        }
                    });

                    let my_elo = elo::get_elo(".", &c.user_id);
                    let elo_preview = opp_info.as_ref().map(|opp| {
                        types::EloPreview {
                            my: my_elo,
                            prediction: Some(elo::predict_elo_change(my_elo, opp.elo).into()),
                        }
                    });

                    let _ = c.sender.send(types::ServerMsg::CharacterSelect {
                        characters: char_infos.clone(),
                        timeout_sec: 30,
                        opponent: opp_info,
                        elo: if r.is_match { elo_preview } else { None },
                    });
                }
            }
        }
    }

    // Split socket into sender and receiver
    use futures_util::{SinkExt, StreamExt};
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Send task: forward messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let json = serde_json::to_string(&msg).unwrap();
            if ws_sender.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    // Receive task: handle incoming WebSocket messages
    loop {
        match ws_receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                let msg: Result<types::ClientMsg, _> = serde_json::from_str(&text);
                match msg {
                    Ok(client_msg) => {
                        handle_client_message(
                            &state,
                            &room,
                            &room_code_saved,
                            &user_id,
                            &display_name,
                            &client_msg,
                        );
                    }
                    Err(e) => {
                        let _ = tx.send(types::ServerMsg::Error {
                            message: format!("无效消息: {}", e),
                        });
                    }
                }
            }
            Some(Ok(Message::Close(_))) => {
                // Handle disconnect
                handle_disconnect(&state, &room, &room_code_saved, &user_id);
                break;
            }
            Some(Err(_)) | None => {
                handle_disconnect(&state, &room, &room_code_saved, &user_id);
                break;
            }
            _ => {}
        }
    }

    send_task.abort();
}

fn handle_client_message(
    state: &Arc<AppState>,
    room: &Arc<Mutex<room::Room>>,
    room_code: &str,
    user_id: &str,
    _display_name: &str,
    msg: &types::ClientMsg,
) {
    match msg {
        types::ClientMsg::Ping { ts } => {
            // Respond with pong
            let r = room.lock();
            for client in r.clients.iter().flatten() {
                if client.user_id == user_id {
                    let _ = client.sender.send(types::ServerMsg::Pong { ts: *ts });
                    break;
                }
            }
        }
        types::ClientMsg::PickCharacter { id } => {
            let mut r = room.lock();
            let player_idx = if r.clients[0].as_ref().map_or(false, |c| c.user_id == user_id) { 0 } else { 1 };
            r.picks[player_idx] = Some(id.clone());
            // Notify opponent
            let opp_idx = 1 - player_idx;
            if let Some(opp) = &r.clients[opp_idx] {
                let _ = opp.sender.send(types::ServerMsg::OpponentPicked { picked: true });
            }
        }
        types::ClientMsg::LockCharacter => {
            let mut r = room.lock();
            let player_idx = if r.clients[0].as_ref().map_or(false, |c| c.user_id == user_id) { 0 } else { 1 };
            r.locked[player_idx] = true;
            // Notify opponent
            let opp_idx = 1 - player_idx;
            if let Some(opp) = &r.clients[opp_idx] {
                let _ = opp.sender.send(types::ServerMsg::OpponentLocked { locked: true });
            }
            // Check if both locked
            if r.locked[0] && r.locked[1] {
                // Start game!
                let picks = [
                    r.picks[0].clone().unwrap_or_default(),
                    r.picks[1].clone().unwrap_or_default(),
                ];
                r.game_started = true;
                drop(r);

                let mut games = state.games.lock();
                let mut bus = EventBus::new();
                let game_state = create_game(&mut bus, &picks, &state.cards_config);
                games.insert(room_code.to_string(), GameWithBus {
                    state: game_state,
                    bus,
                    room_code: room_code.to_string(),
                });

                // Broadcast initial game state
                let g = games.get(room_code).unwrap();
                let room = room.lock();
                for (idx, client) in room.clients.iter().enumerate() {
                    if let Some(c) = client {
                        let view = get_player_view(
                            &g.state, idx, &c.display_name, &c.user_id,
                            &room.clients[1 - idx].as_ref().map_or("".into(), |o| o.display_name.clone()),
                            &room.clients[1 - idx].as_ref().map_or("".into(), |o| o.user_id.clone()),
                        );
                        let _ = c.sender.send(types::ServerMsg::GameState {
                            state: view,
                            your_index: idx,
                            elo_result: None,
                        });
                    }
                }
            }
        }
        _ => {
            // Game action
            let mut games = state.games.lock();
            if let Some(game) = games.get_mut(room_code) {
                let player_idx = {
                    let r = room.lock();
                    if r.clients[0].as_ref().map_or(false, |c| c.user_id == user_id) { 0 } else { 1 }
                };
                let result = handle_message(&mut game.bus, &mut game.state, player_idx, msg);
                if let Err(e) = result {
                    let r = room.lock();
                    for client in r.clients.iter().flatten() {
                        if client.user_id == user_id {
                            let _ = client.sender.send(types::ServerMsg::Error { message: e });
                            break;
                        }
                    }
                    return;
                }

                // Broadcast updated game state
                let r = room.lock();
                broadcast_game_state(state, &r, &game.state, &mut game.bus, room_code);
            }
        }
    }
}

fn broadcast_game_state(
    _state: &Arc<AppState>,
    room: &room::Room,
    game_state: &GameState,
    _bus: &mut EventBus,
    _room_code: &str,
) {
    for (idx, client) in room.clients.iter().enumerate() {
        if let Some(c) = client {
            let opp_idx = 1 - idx;
            let view = get_player_view(
                game_state,
                idx,
                &c.display_name,
                &c.user_id,
                room.clients[opp_idx].as_ref().map_or("", |o| o.display_name.as_str()),
                room.clients[opp_idx].as_ref().map_or("", |o| o.user_id.as_str()),
            );

            let elo_result = if game_state.game_over && room.is_match {
                // Record ELO
                let winner_idx = game_state.winner.unwrap_or(0);
                let loser_idx = 1 - winner_idx;
                if let (Some(winner), Some(loser)) = (&room.clients[winner_idx], &room.clients[loser_idx]) {
                    let result = elo::update_elo(
                        ".", &winner.user_id, &loser.user_id,
                        &winner.display_name, &loser.display_name,
                    );
                    Some(if idx == winner_idx {
                        types::EloResult {
                            change: result.winner_change,
                            new_elo: result.winner_new_elo,
                            opponent_change: result.loser_change,
                        }
                    } else {
                        types::EloResult {
                            change: result.loser_change,
                            new_elo: result.loser_new_elo,
                            opponent_change: result.winner_change,
                        }
                    })
                } else {
                    None
                }
            } else {
                None
            };

            let _ = c.sender.send(types::ServerMsg::GameState {
                state: view,
                your_index: idx,
                elo_result,
            });
        }
    }
}

fn handle_disconnect(
    state: &Arc<AppState>,
    room: &Arc<Mutex<room::Room>>,
    room_code: &str,
    user_id: &str,
) {
    let r = room.lock();
    let player_idx = if r.clients[0].as_ref().map_or(false, |c| c.user_id == user_id) { 0 } else { 1 };

    // Mark disconnected in game state
    let mut games = state.games.lock();
    if let Some(game) = games.get_mut(room_code) {
        let over_limit = mark_disconnected(&mut game.state, player_idx);
        if over_limit {
            // Opponent wins
            broadcast_game_state(state, &r, &game.state, &mut game.bus, room_code);
            return;
        }

        // Notify opponent
        let opp_idx = 1 - player_idx;
        if let Some(opp) = &r.clients[opp_idx] {
            let _ = opp.sender.send(types::ServerMsg::Disconnected {
                message: "对手断线，等待重连...".into(),
                attempts_left: 3u32.saturating_sub(game.state.disconnect_count[player_idx]),
            });
        }
    }

    // Don't remove the client yet — allow reconnection
}
