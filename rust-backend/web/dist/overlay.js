let _overlayTimer = null;
function createOverlay(title, body, seconds, cfn, onAction, onCancel, noIgnore, buttonText) {
  removeOverlay();
  const el = document.createElement("div");
  el.id = "block-overlay";
  el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9999";
  let r = seconds;
  const upd = () => {
    const cd = el.querySelector("#bl-countdown");
    if (cd) cd.textContent = cfn(r);
  };
  const ignoreHtml = noIgnore ? "" : '<button class="btn btn-outline btn-sm" id="bl-ignore">\u5FFD\u7565</button>';
  el.innerHTML = `<div style="background:#1a1a1a;border:2px solid #7c3aed;border-radius:16px;padding:40px;text-align:center;max-width:360px;display:flex;flex-direction:column;gap:12px">
    <h2 style="font-size:28px">${title}</h2><div>${body}</div>
    <p id="bl-countdown" style="color:#f59e0b;font-family:monospace;font-size:16px">${cfn(seconds)}</p>
    <div style="display:flex;gap:12px;justify-content:center;margin-top:8px">
      <button class="btn btn-primary btn-sm" id="bl-action">${onAction ? buttonText || "\u91CD\u65B0\u8FDE\u63A5" : ""}</button>
      ${ignoreHtml}</div></div>`;
  document.body.appendChild(el);
  _overlayTimer = setInterval(() => {
    r--;
    if (r <= 0) {
      clearInterval(_overlayTimer);
      _overlayTimer = null;
      removeOverlay();
      if (onCancel) onCancel();
    }
    upd();
  }, 1e3);
  if (onAction) {
    el.querySelector("#bl-action").onclick = () => {
      clearInterval(_overlayTimer);
      _overlayTimer = null;
      removeOverlay();
      onAction();
    };
  } else el.querySelector("#bl-action").style.display = "none";
  if (!noIgnore) {
    el.querySelector("#bl-ignore").onclick = () => {
      clearInterval(_overlayTimer);
      _overlayTimer = null;
      removeOverlay();
      if (onCancel) onCancel();
    };
  }
}
function removeOverlay() {
  if (_overlayTimer) {
    clearInterval(_overlayTimer);
    _overlayTimer = null;
  }
  const el = document.getElementById("block-overlay");
  if (el) el.remove();
}
function showToast(msg) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(220,38,38,.9);color:white;padding:8px 20px;border-radius:8px;font-size:14px;z-index:999;pointer-events:none;animation:fadeOut 3s forwards";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3100);
}
function showLoginOverlay() {
  removeOverlay();
  const el = document.createElement("div");
  el.id = "block-overlay";
  el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:999";
  el.innerHTML = `<div style="background:var(--c-card);border:2px solid var(--c-accent);border-radius:16px;padding:40px 32px;text-align:center;max-width:340px;display:flex;flex-direction:column;gap:16px">
    <div style="font-size:48px">\u{1F510}</div>
    <h2 style="font-size:22px;font-weight:bold">\u8BF7\u5148\u767B\u5F55</h2>
    <p style="opacity:.6;font-size:14px">\u9700\u8981\u767B\u5F55\u540E\u624D\u80FD\u8FDB\u884C\u6E38\u620F\u64CD\u4F5C</p>
    <button class="btn btn-primary w-full" id="login-overlay-btn">\u767B\u5F55</button>
  </div>`;
  document.body.appendChild(el);
  el.querySelector("#login-overlay-btn").onclick = () => startLogin();
}
function hideLoginOverlay() {
  removeOverlay();
}
