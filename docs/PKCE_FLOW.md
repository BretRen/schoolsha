# Zitadel PKCE 认证流程 — 客户端参考

## 概述

服务端通过 Zitadel OIDC 验证用户身份。客户端需要在建立 WebSocket 连接前完成 PKCE 流程获取 `access_token`。

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

### Godot 4 示例

```gdscript
func _generate_pkce() -> Dictionary:
    # 生成 64 字节随机数，base64url 编码
    var bytes = PackedByteArray()
    bytes.resize(64)
    for i in range(64):
        bytes[i] = randi() % 256
    var verifier = Marshalls.raw_to_base64(bytes).replace("+", "-").replace("/", "_").replace("=", "")
    
    # SHA256 + base64url
    var ctx = HashingContext.new()
    ctx.start(HashingContext.HASH_SHA256)
    ctx.update(verifier.to_utf8_buffer())
    var hash = ctx.finish()
    var challenge = Marshalls.raw_to_base64(hash).replace("+", "-").replace("/", "_").replace("=", "")
    
    return { "verifier": verifier, "challenge": challenge }
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

用户登录后会重定向到 `redirect_uri?code=<AUTHORIZATION_CODE>`

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

### 4. 连接 WebSocket

```
ws://host:8099/ws?token=<access_token>
```

或带 Authorization header（如果客户端支持）:
```
Authorization: Bearer <access_token>
```

## 刷新 token

access_token 过期后，用 refresh_token 刷新：

```
POST https://auth.pdnode.com/oauth/v2/token
grant_type=refresh_token&
client_id=<CLIENT_ID>&
refresh_token=<REFRESH_TOKEN>
```

(scope 需要包含 `offline_access`)

## Deno 示例 (测试用)

```typescript
// 手动获取 token 用于测试
const CLIENT_ID = "<your_client_id>";
const REDIRECT_URI = "http://localhost:9999/callback";

// 1. 生成 PKCE
const verifier = crypto.randomUUID() + crypto.randomUUID();
const encoder = new TextEncoder();
const hash = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// 2. 打开浏览器授权
const authUrl = `https://auth.pdnode.com/oauth/v2/authorize?` +
  `client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&` +
  `response_type=code&scope=openid+profile+email&` +
  `code_challenge=${challenge}&code_challenge_method=S256`;
console.log("Open:", authUrl);

// 3. 启动本地 HTTP 服务器接收回调
Deno.serve({ port: 9999 }, async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (!code) return new Response("no code");

  // 4. 换 token
  const tokenRes = await fetch("https://auth.pdnode.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  console.log("Access Token:", tokens.access_token);

  // 5. 连接到游戏服务器
  const ws = new WebSocket(`ws://localhost:8099/ws?token=${tokens.access_token}`);
  ws.onopen = () => console.log("Connected!");
  ws.onmessage = (e) => console.log(JSON.parse(e.data));

  return new Response("OK — check console");
});
```
