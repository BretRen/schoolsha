(async () => {
  await initAuth();
  if (AUTH.enabled) {
    if (AUTH.token) {
      hideLoginOverlay();
      const sec = document.getElementById("auth-section");
      if (sec) sec.classList.remove("hidden");
      fetch(`${AUTH.provider}/oidc/v1/userinfo`, {
        headers: { Authorization: `Bearer ${AUTH.token}` }
      }).then((r) => {
        if (r.status === 401) {
          sessionStorage.removeItem("auth_token");
          sessionStorage.removeItem("pkce_verifier");
          location.reload();
          return null;
        }
        return r.ok ? r.json() : null;
      }).then((data) => {
        if (data) {
          const name = data.nickname || data.name || data.preferred_username || "";
          const el = document.getElementById("auth-user");
          if (el) el.textContent = name || "\u5DF2\u767B\u5F55";
        }
      }).catch(() => {
      });
    } else {
      showLoginOverlay();
    }
  }
})();
