// main.ts — 入口：认证初始化 + 启动

(async () => {
  await initAuth();
  if (AUTH.enabled) {
    if (AUTH.token) {
      hideLoginOverlay();
      const sec = document.getElementById("auth-section");
      if (sec) { sec.classList.remove("hidden"); }
      // Fetch user info
      fetch(`${AUTH.provider}/oidc/v1/userinfo`, { headers: { Authorization: `Bearer ${AUTH.token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            const name = data.nickname || data.name || data.preferred_username || "";
            const el = document.getElementById("auth-user");
            if (el) el.textContent = name || "已登录";
          }
        }).catch(() => {});
    } else {
      showLoginOverlay();
    }
  }
})();
