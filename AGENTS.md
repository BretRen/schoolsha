# AGENTS.md — AI 编辑指南

## 项目概述

学校杀 (SchoolSha) 是一个 1v1 卡牌对战游戏，Deno + TypeScript 后端，Godot 4
前端。

## 技术栈

- **运行时**：Deno 2.6+（不支持 Node.js API）
- **语言**：TypeScript（严格模式）
- **依赖管理**：`deno.json` 的 `imports` 字段，JSR / deno.land / npm 均可
- **无构建工具**：deno run 直接执行源码
- **配置文件**：JSON（`cards.json`, `characters.json`, `skills.json`）

## 项目结构

```
/opt/games/sanguosha/          ← 工作目录
├── main.ts                    入口：WebSocket 服务器 + HTTP API + 多房间路由
├── room.ts                    房间管理器（Room 类 + RoomManager 单例）
├── game.ts                    阶段机 + 超时 + 断线重连（纯函数，无全局状态）
├── effects.ts                 全部卡牌效果 + 装备系统 + 响应系统
├── events.ts                  事件总线（技能系统入口）
├── skills.ts                  技能运行时（JSON → 事件绑定）
├── cards.ts                   牌堆创建/洗牌/抽牌
├── types.ts                   类型定义 + WS 协议
├── auth.ts                    Zitadel JWT 验证
├── cli.ts                     ANSI 命令行测试客户端
├── web/                       网页版客户端
│   ├── index.html             主页面
│   ├── style.css              暗色主题样式
│   └── app.js                 游戏逻辑（纯 JS，无框架）
├── test_integration.ts        全流程集成测试
├── test_equip.ts              装备系统单元测试
├── cards.json                 88 张牌配置
├── characters.json             4 个角色
├── skills.json                 3 个技能
├── .env                       配置（PORT, ZITADEL_CLIENT_ID 等）
├── deno.json                  导入映射
└── docs/
    ├── CARDS.md               卡牌图鉴（中文）
    ├── CHARACTERS.md          角色与技能（中文）
    └── PKCE_FLOW.md           PKCE 认证流程
```

## 运行命令

```bash
# 开发（无认证）
deno run --allow-net --allow-env --env-file=.env main.ts

# 类型检查
deno check main.ts

# 装备系统测试
deno run --allow-env test_equip.ts

# 集成测试（需要服务器先跑）
deno run --allow-net --allow-read --allow-write test_integration.ts

# 手动 CLI 测试（需要两个终端）
deno run --allow-net cli.ts
```

## 代码约定

### 架构原则

1. **后端是唯一真相源** — 前端只做渲染和发送操作，不包含游戏逻辑
2. **JSON 驱动** — 卡牌/角色/技能通过 JSON 配置，新增一张牌只需改 JSON +
   注册效果
3. **事件总线** — 所有技能通过 `events.ts` 的 `onEvent` / `emit`
   绑定，不修改核心逻辑

### 多房间架构

- `room.ts` 的 `RoomManager` 管理所有房间（单例），每 5 分钟清理过期房间
- 房间码 6 位大写字母数字（排除 0/O/1/I/L），`GET /room/create` 创建新房间
- `?room=CODE` 参数加入指定房间；不带参数则自动创建
- WebSocket 断线重连：先验证 userId（如有），再恢复连接
- 邀请链接：`pdnode://schoolsha/invite/CODE`（自定义 scheme）+ HTML 落地页
  `GET /invite/CODE`

### 如何新增一张牌

1. 在 `cards.json` 添加条目（name, type, suit, number, count）
2. 在 `effects.ts` 用 `registerCardEffect()` 注册效果
3. 如果牌有响应功能，在 `tryRespond()` 中添加对应的响应逻辑

### 如何新增一个角色/技能

1. 在 `characters.json` 添加角色（id, name, maxHp, skills）
2. 在 `skills.json` 添加技能（id, name, type, trigger, effect）
3. 如需新效果类型，在 `skills.ts` 的 `executeSkillEffect()` 添加 case

### 如何修改游戏规则

- 阶段流转：`game.ts` → `enterPhase()` / `advancePhase()`
- 伤害计算：`effects.ts` → `dealDamage()`
- 响应系统：`effects.ts` → `tryRespond()` / `handleTimeout()`
- 装备逻辑：`effects.ts` → `equipCard()`

### TypeScript 风格

- 使用 Deno 原生 TypeScript（不需要 tsconfig）
- 导入用相对路径（`"./game.ts"`）
- JSON 用 `import ... from "./file.json" with { type: "json" }`
- 不要用 `any`，用具体类型
- 错误返回用 `string | null`（null = 成功，string = 错误信息）

### .env 管理

- `.env` 在 `.gitignore` 中，不提交
- 认证开关：`ZITADEL_CLIENT_ID` 为空 = 无认证，有值 = 强制 Zitadel 验证
- `PUBLIC_URL`：公网地址，用于生成邀请链接（默认 `http://localhost:8099`）
- 服务器启动必须带 `--env-file=.env`

## Git 仓库

- Remote: `git@github.com:bretren/schoolsha.git`
- Branch: `main`
- 每次提交前必须通过 `deno check` 和 `test_equip.ts`

## 注意事项

- 不要在生产服务器上随意重启服务（游戏进行中会掉线）
- 修改 JSON 配置后无需重启，下次创建新游戏时生效
- 修改 TypeScript 代码后需要重启服务器
- 每个房间独立运行 1v1，互不影响
