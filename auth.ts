// ============================================================
// auth.ts — Zitadel OIDC JWT 验证 (PKCE 服务端)
// ============================================================

import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = Deno.env.get("ZITADEL_ISSUER") || "https://auth.pdnode.com";
const clientId = Deno.env.get("ZITADEL_CLIENT_ID") || "";

// 从 Zitadel 拉取 JWKS 公钥（自动缓存）
const jwks = createRemoteJWKSet(new URL(`${issuer}/oauth/v2/keys`));

/** 从 JWT 中提取的用户信息 */
export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
}

/**
 * 验证 JWT access_token（或 id_token）
 * 返回用户信息，失败返回 null
 */
export async function validateToken(token: string): Promise<AuthUser | null> {
  if (!clientId) {
    console.warn("[auth] ZITADEL_CLIENT_ID not set — skipping token validation");
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer });
      return {
        sub: payload.sub as string,
        name: payload.name as string | undefined,
        email: payload.email as string | undefined,
        preferredUsername: payload.preferred_username as string | undefined,
      };
    } catch (e) {
      console.error("[auth] token validation failed:", (e as Error).message);
      return null;
    }
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: clientId,
    });
    return {
      sub: payload.sub as string,
      name: payload.name as string | undefined,
      email: payload.email as string | undefined,
      preferredUsername: payload.preferred_username as string | undefined,
    };
  } catch (e) {
    console.error("[auth] token validation failed:", (e as Error).message);
    return null;
  }
}

/**
 * 从 HTTP 请求中提取 Bearer token
 *
 * 优先级（从高到低）：
 *   1. Authorization header:  Bearer <token>        ← 首选，不暴露在 URL
 *   2. Sec-WebSocket-Protocol: <token>               ← 浏览器 new WebSocket(url, [token])
 *   3. URL query param:        ?token=<token>        ← 备用（Godot 等不支持 WS 头的客户端）
 */
export function extractToken(req: Request): string | null {
  // 1. Authorization header（首选）
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  // 2. Sec-WebSocket-Protocol（浏览器 WS 构造函数的第二个参数）
  const proto = req.headers.get("sec-websocket-protocol");
  if (proto) return proto;

  // 3. URL query param（后备，用于不支持自定义 WS 头的客户端如 Godot）
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;

  return null;
}
