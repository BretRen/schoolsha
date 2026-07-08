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
  /** Zitadel 唯一用户 ID (sub claim) */
  sub: string;
  /** 显示名称（优先 nickname → name → preferred_username → sub） */
  displayName: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
}

/**
 * 验证 JWT access_token（或 id_token）
 * 返回用户信息，失败返回 null
 */
export async function validateToken(token: string): Promise<AuthUser | null> {
  const doVerify = async (aud?: string) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      ...(aud ? { audience: aud } : {}),
    });
    return {
      sub: payload.sub as string,
      displayName: (payload.nickname || payload.name || payload.preferred_username || payload.sub) as string,
      name: payload.name as string | undefined,
      email: payload.email as string | undefined,
      preferredUsername: payload.preferred_username as string | undefined,
    };
  };

  if (!clientId) {
    console.warn("[auth] ZITADEL_CLIENT_ID not set — skipping audience check");
    try {
      return await doVerify();
    } catch (e) {
      console.error("[auth] token validation failed:", (e as Error).message);
      return null;
    }
  }

  try {
    return await doVerify(clientId);
  } catch (e) {
    console.error("[auth] token validation failed:", (e as Error).message);
    return null;
  }
}

/**
 * 从 Zitadel userinfo 端点拉取用户显示名称
 * JWT 里可能没有昵称字段，所以通过 API 补全
 */
export async function fetchUserInfo(token: string): Promise<{ name: string } | null> {
  try {
    const res = await fetch(`${issuer}/oidc/v1/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[auth] userinfo fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    // 优先级：nickname > name > preferred_username > sub
    const name = data.nickname || data.name || data.preferred_username || data.sub;
    return { name };
  } catch (e) {
    console.warn("[auth] userinfo fetch error:", (e as Error).message);
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
