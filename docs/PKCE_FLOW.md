# Zitadel PKCE 认证流程 — 客户端参考

## 概述

服务端通过 Zitadel OIDC 验证用户身份。客户端需要在建立 WebSocket 连接前完成 PKCE 流程获取 `access_token`。

## 连接时传递 token（优先级）

1. **Authorization header**（首选，不暴露在 URL）
   ```
   Authorization: Bearer <access_token>
   ```
2. **Sec-WebSocket-Protocol**（浏览器专用）
   ```js
   new WebSocket("wss://host/ws", [access_token])
   ```
3. **URL query param**（后备，Godot 等受限客户端）

## Zitadel 端点

| 端点 | URL |
|------|-----|
| Issuer | `https://auth.pdnode.com` |
| Authorize | `https://auth.pdnode.com/oauth/v2/authorize` |
| Token | `https://auth.pdnode.com/oauth/v2/token` |
| UserInfo | `https://auth.pdnode.com/oidc/v1/userinfo` |

## PKCE 流程 (S256)

### 1. 生成 code_verifier 和 code_challenge

```
code_verifier = 随机 43-128 字符的字符串 (A-Z, a-z, 0-9, -._~)
code_challenge = base64url(sha256(code_verifier))
```

### 2. 浏览器打开授权页面

```
https://auth.pdnode.com/oauth/v2/authorize?
  client_id=<CLIENT_ID>&
  redirect_uri=<REDIRECT_URI>&
  response_type=code&
  scope=openid+profile+email&
  code_challenge=<CHALLENGE>&
  code_challenge_method=S256
```

### 3. 用 code 换 token

```
POST https://auth.pdnode.com/oauth/v2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
client_id=<CLIENT_ID>&
code=<AUTHORIZATION_CODE>&
redirect_uri=<REDIRECT_URI>&
code_verifier=<VERIFIER>
```

返回:
```json
{
  "access_token": "eyJhbG...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbG..."
}
```

## 各客户端连接方式

### ✅ 浏览器 / Node.js（首选：Authorization header）

```js
// PKCE 获取 token 后...
const ws = new WebSocket("wss://host:8099/ws");

// 浏览器 WS 构造函数不支持自定义请求头，
// 用 Sec-WebSocket-Protocol 传 token：
const ws = new WebSocket("wss://host:8099/ws", [accessToken]);
```

### ✅ Deno（首选：Authorization header）

```typescript
// Deno 的 WebSocket 支持自定义 headers
const ws = new WebSocket("ws://localhost:8099/ws");
ws.addEventListener("open", () => { /* ready */ });

// 但创建时无法设 header，需要在 HTTP upgrade 阶段处理。
// 推荐：先走 HTTP → 拿 token → 用 ?token= 参数连接
const ws = new WebSocket(`ws://localhost:8099/ws?token=${accessToken}`);
```

### ⚠️ Godot 4（URL 后备方案）

Godot 的 `WebSocketPeer.connect_to_url()` 不支持自定义请求头，只能用 URL 参数：

```gdscript
# 1. PKCE 获取 token（同标准流程）

# 2. 连接时把 token 放 URL
var ws = WebSocketPeer.new()
var url = "ws://localhost:8099/ws?token=" + access_token
ws.connect_to_url(url)
```

### ✅ 其他 HTTP 客户端（Authorization header）

```bash
# curl + websocat 测试
websocat -H="Authorization: Bearer $TOKEN" ws://localhost:8099/ws

# 或用 URL 参数快速测试
websocat "ws://localhost:8099/ws?token=$TOKEN"
```

## 刷新 token

access_token 过期后：

```
POST https://auth.pdnode.com/oauth/v2/token
grant_type=refresh_token&
client_id=<CLIENT_ID>&
refresh_token=<REFRESH_TOKEN>
```

(scope 需要包含 `offline_access`)
