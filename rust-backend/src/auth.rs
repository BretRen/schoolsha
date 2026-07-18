// auth.rs — Zitadel OIDC JWT 验证
// Rust 复刻：对应 Deno TS 的 auth.ts

use serde::Deserialize;
use tracing::{debug, error, warn};

// ============================================================
// 用户信息
// ============================================================

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub sub: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
struct UserInfoResponse {
    sub: Option<String>,
    nickname: Option<String>,
    name: Option<String>,
    preferred_username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JwtClaims {
    sub: Option<String>,
    azp: Option<String>,
    nickname: Option<String>,
    name: Option<String>,
    preferred_username: Option<String>,
}

// ============================================================
// 验证
// ============================================================

/// 验证 token（JWT 本地验证或 userinfo 远程验证）
pub async fn validate_token(
    token: &str,
    issuer: &str,
    client_id: Option<&str>,
) -> Option<AuthUser> {
    // 策略 1: JWT 本地验证
    if token.split('.').count() == 3 {
        if let Some(user) = validate_jwt(token, issuer, client_id).await {
            debug!(sub = %user.sub, "[auth] JWT validated");
            return Some(user);
        }
        warn!("[auth] JWT verify failed, trying userinfo");
    }

    // 策略 2: Opaque token → userinfo
    validate_via_userinfo(token, issuer).await
}

async fn validate_jwt(token: &str, issuer: &str, client_id: Option<&str>) -> Option<AuthUser> {
    use jsonwebtoken::{decode, decode_header, DecodingKey, Validation, Algorithm};

    let header = decode_header(token).ok()?;
    let kid = header.kid?;

    // Fetch JWKS
    let jwks_url = format!("{}/oauth/v2/keys", issuer);
    let jwks_resp = reqwest::get(&jwks_url).await.ok()?;
    let jwks: serde_json::Value = jwks_resp.json().await.ok()?;

    // Find the key with matching kid
    let key = jwks["keys"].as_array()?.iter().find(|k| k["kid"].as_str() == Some(&kid))?;
    let n = key["n"].as_str()?;
    let e = key["e"].as_str()?;

    let decoding_key = DecodingKey::from_rsa_components(n, e).ok()?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);

    let token_data = decode::<JwtClaims>(token, &decoding_key, &validation).ok()?;
    let claims = token_data.claims;

    // Check azp
    if let (Some(cid), Some(azp)) = (client_id, &claims.azp) {
        if azp != cid {
            error!(%azp, expected = %cid, "[auth] JWT azp mismatch");
            return None;
        }
    }

    let sub = claims.sub?;
    let display_name = claims.nickname
        .or(claims.name)
        .or(claims.preferred_username)
        .unwrap_or_else(|| sub.clone());

    Some(AuthUser { sub, display_name })
}

async fn validate_via_userinfo(token: &str, issuer: &str) -> Option<AuthUser> {
    let url = format!("{}/oidc/v1/userinfo", issuer);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        error!(status = %resp.status(), "[auth] userinfo returned error");
        return None;
    }

    let data: UserInfoResponse = resp.json().await.ok()?;
    let sub = data.sub?;
    let display_name = data.nickname
        .or(data.name)
        .or(data.preferred_username)
        .unwrap_or_else(|| sub.clone());

    debug!(sub = %sub, "[auth] opaque token validated via userinfo");
    Some(AuthUser { sub, display_name })
}

/// 从 userinfo 端点拉取显示名称
pub async fn fetch_user_name(token: &str, issuer: &str) -> Option<String> {
    let url = format!("{}/oidc/v1/userinfo", issuer);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let data: UserInfoResponse = resp.json().await.ok()?;
    Some(
        data.nickname
            .or(data.name)
            .or(data.preferred_username)
            .unwrap_or_else(|| data.sub.unwrap_or_default()),
    )
}
