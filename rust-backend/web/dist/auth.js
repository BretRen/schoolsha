function b64(buf) {
  const s = String.fromCharCode(...new Uint8Array(buf));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function startLogin() {
  const vb = new Uint8Array(32);
  crypto.getRandomValues(vb);
  const verifier = b64(vb);
  sessionStorage.setItem("pkce_verifier", verifier);
  const challenge = b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );
  location.href = `${AUTH.provider}/oauth/v2/authorize?${new URLSearchParams({
    client_id: AUTH.clientId,
    redirect_uri: location.origin + "/",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid profile email"
  })}`;
}
async function handleAuthCallback() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return false;
  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) return false;
  history.replaceState(null, "", location.pathname);
  const r = await fetch(`${AUTH.provider}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: AUTH.clientId,
      code,
      redirect_uri: location.origin + "/",
      code_verifier: verifier
    })
  });
  if (!r.ok) {
    sessionStorage.removeItem("pkce_verifier");
    return false;
  }
  const d = await r.json();
  AUTH.token = d.access_token;
  sessionStorage.setItem("auth_token", d.access_token);
  sessionStorage.removeItem("pkce_verifier");
  return true;
}
async function initAuth() {
  try {
    const r = await fetch(`${HTTP_URL}/info`);
    const info = await r.json();
    if (info.auth?.mode === "zitadel_oidc") {
      AUTH.enabled = true;
      AUTH.provider = info.auth.provider;
      AUTH.clientId = info.auth.clientId;
    }
  } catch {
  }
  const saved = sessionStorage.getItem("auth_token");
  if (saved) AUTH.token = saved;
  if (AUTH.enabled && location.search.includes("code=")) {
    await handleAuthCallback();
  }
  const inviteRoom = sessionStorage.getItem("invite_room");
  if (inviteRoom) {
    if (AUTH.token) {
      sessionStorage.removeItem("invite_room");
      joinRoomByCode(inviteRoom);
      return;
    }
    if (AUTH.enabled) {
      startLogin();
      return;
    }
  }
  if (AUTH.token) fetchDisconnectedGames();
}
let _reconnectOverlayActive = false;
async function fetchDisconnectedGames() {
  if (!AUTH.token) return;
  try {
    const r = await fetch(
      `${HTTP_URL}/api/disconnected-games?token=${encodeURIComponent(AUTH.token)}`
    );
    if (r.status === 401) {
      sessionStorage.removeItem("auth_token");
      sessionStorage.removeItem("pkce_verifier");
      location.reload();
    }
    const data = await r.json();
    if (data.games?.length) {
      const g = data.games[0];
      const elapsed = Math.floor((Date.now() - g.disconnectedAt) / 1e3);
      const remain = Math.max(0, 30 - elapsed);
      if (remain <= 0) return;
      _reconnectOverlayActive = true;
      createOverlay(
        "\u65AD\u7EBF\u91CD\u8FDE",
        `\u623F\u95F4 <b style="color:#c4b5fd">${g.roomCode}</b> &nbsp; \u5BF9\u624B: ${esc(g.opponent)}`,
        remain,
        (t) => `${t} \u79D2\u5185\u53EF\u91CD\u8FDE`,
        () => {
          _reconnectOverlayActive = false;
          Alpine.store("g").roomCode = g.roomCode;
          connect(buildWsUrl(`?room=${g.roomCode}`));
        },
        () => {
          _reconnectOverlayActive = false;
        },
        false
      );
      return;
    }
  } catch {
  }
}
function doLogout() {
  AUTH.token = null;
  sessionStorage.removeItem("auth_token");
  sessionStorage.removeItem("pkce_verifier");
  location.reload();
}
