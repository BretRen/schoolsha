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
    // 无 clientId 时降级：只验证签名和 issuer，不检查 audience
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
 * 支持三种方式（优先级从高到低）：
 *   1. Authorization header: Bearer <token>
 *   2. URL query param: ?token=<token>
 *   3. WebSocket protocol: <token>
 */
export function extractToken(req: Request): string | null {
  const url = new URL(req.url);

  // 1. Authorization header
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  // 2. URL query param
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;

  // 3. Sec-WebSocket-Protocol (某些客户端用这个传 token)
  const proto = req.headers.get("sec-websocket-protocol");
  if (proto) return proto;

  return null;
}
