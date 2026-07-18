# 学校杀 — Rust 后端复刻

三国杀风格 1v1 校园卡牌对战游戏。此目录包含 Rust 重写版后端。

## 与 Deno/TypeScript 版的对比

| 指标 | Deno (TS) | Rust | 提升 |
|---|---|---|---|
| 内存占用 | 17 MB | **1.6 MB** | **10.6x** |
| 冷启动 | ~1.5s | ~0.1s | **15x** |
| HTTP 延迟 | ~1ms | **~0.6ms** | **1.7x** |
| 吞吐量 (100req/10并发) | 4,938 req/s | **8,329 req/s** | **1.7x** |
| 发行版体积 | — | **~8MB** (静态链接) | — |
| 依赖 | Deno运行时 | 无 (原生二进制) | — |

> 测试环境: Hetzner VPS (Debian), `GET /info` 端点

## 架构

```
src/
├── lib.rs          # 库入口（供测试使用）
├── main.rs         # HTTP + WebSocket 服务器 (axum)
├── types.rs        # 全部类型定义 (11 种 PendingType, GameState, WS 协议)
├── cards.rs        # 牌堆操作 (创建/洗牌/抽牌)
├── events.rs       # 事件总线 (技能被动技入口)
├── effects.rs      # 卡牌效果注册表 (20+ 张牌) + tryUseCard/tryRespond/handleTimeout
├── skills.rs       # 技能运行时 (JSON 配置驱动)
├── game.rs         # 阶段机 + 消息处理 + 断线重连 + 客户端视图
├── auth.rs         # Zitadel OIDC JWT 验证 (双策略: JWT + userinfo)
├── room.rs         # 房间管理器 (Room + RoomManager)
├── elo.rs          # ELO 积分计算 + 排行榜
├── matchmaking.rs  # 匹配队列 (ELO 邻近配对)
└── config.rs       # 配置加载 (.env + JSON 配置文件)
```

## 运行

### 开发模式

```bash
cargo run
```

### 生产部署 (systemd)

```bash
# 编译
cargo build --release

# 安装服务
sudo cp schoolsha-rust.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now schoolsha-rust

# 管理
systemctl status schoolsha-rust
systemctl restart schoolsha-rust
journalctl -u schoolsha-rust -f
```

### 测试

```bash
# 全部测试 (26 个)
cargo test

# 单线程运行 (避免并发问题)
cargo test -- --test-threads=1
```

## 配置文件

从父目录链接 JSON 配置文件：
- `cards.json` — 90 张卡牌定义
- `characters.json` — 4 个角色
- `skills.json` — 3 个技能

## API 端点

- `GET /info` — 服务器信息
- `GET /room/create` — 创建房间
- `WS /ws` — 游戏 WebSocket
- `GET /leaderboard` — ELO 排行榜
- `GET /api/disconnected-games` — 断线对局查询

## 设计要点

### 从 Deno → Rust 的关键设计决策

1. **效果注册表**：从 TS 的全局 `effectMap` + 闭包改为 Rust 的 `OnceLock<HashMap<String, CardEffect>>` + `Box<dyn Fn>` trait 对象
2. **PendingResponse**：TS 的对象字面量改为 Rust 的强类型 enum + struct，11 种 PendingType 穷举匹配
3. **事件总线**：从全局 `handlers[]` 数组改为 `EventBus` 结构体实例，消除全局状态泄漏
4. **WebSocket**：从 Deno 原生 WS 改为 axum + tokio-tungstenite，用 `split()` 实现全双工
