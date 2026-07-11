# 学校杀

[English](./README.md) | **Chinese**

学校杀是由 Stoller 学生共同创造的类三国杀卡牌游戏

> 完整名称：Stoller SchoolSha | 思多乐学校杀

---

## 文档

- **[卡牌图鉴](./docs/CARDS.md)** — 全部 88 张牌的效果与花色
- **[角色与技能](./docs/CHARACTERS.md)** — 4 个角色及技能说明
- **[PKCE 认证流程](./docs/PKCE_FLOW.md)** — 客户端接入指南（Godot / 浏览器 /
  Deno）

---

## 技术栈

- **后端**：Deno + TypeScript（WebSocket 服务器）
- **认证**：Zitadel OIDC + PKCE (S256)
- **前端**：Godot 4（开发中）
- **配置**：JSON 驱动（卡牌、角色、技能）

## 架构

```
main.ts      WebSocket 服务器 + 匹配 + 认证
game.ts      阶段机 + 超时 + 断线重连
effects.ts   25 张牌效果 + 装备系统 + 响应系统
events.ts    事件总线（技能挂载点）
skills.ts    技能运行时（JSON → 事件绑定）
cards.ts     牌堆创建 / 洗牌 / 抽牌
types.ts     类型定义 + WS 协议
auth.ts      Zitadel JWT 验证
```

### 配置文件

```
cards.json        88 张牌
characters.json    4 个角色
skills.json        3 个技能
```

---

## 快速开始

```bash
# 启动服务器
deno run --allow-net --allow-env --env-file=.env main.ts

# 命令行客户端（测试用）
deno run --allow-net cli.ts

# 运行测试
deno run --allow-env test_equip.ts
```

---

## 制作人员

> 排名不分先后

- 开发：[皮蛋](https://github.com/bretren)
- 角色与策划：孽慈，棉兔砸，[皮蛋](https://github.com/bretren)
- 审核：孽慈，Tim

## 起源

某天在学校玩三国杀的时候，突然想到为什么不做一个学校版本？
然后因为暑假和一些原因导致纸质版的成功的废弃了，转而制作软件版本。

## 免责 与 声明

- 本项目和 Stoller Middle School 没有任何关系
- 本项目不属于 Beaverton School District
- 本项目的角色（包括学生以及老师等）和现实人物没有任何关联，请勿过度解读
- **本软件按"现状"提供**
- 本项目以 MIT 许可证开源，包括所有的代码。但是不包括：
  - 美术版权
  - 角色
- 代码版权：Bret Ren
- 角色、美术版权：制作人员
