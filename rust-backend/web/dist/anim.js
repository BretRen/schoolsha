function safeCloneCard(card) {
  const clone = document.createElement("div");
  clone.className = card.className;
  clone.innerHTML = card.innerHTML;
  clone.querySelectorAll("*").forEach((el) => {
    const toRemove = [];
    for (const attr of el.attributes) {
      const name = attr.name;
      if (name.startsWith("x-") || name.startsWith("@") || name.startsWith(":")) {
        toRemove.push(name);
      }
    }
    toRemove.forEach((a) => el.removeAttribute(a));
  });
  return clone;
}
function animateCardFly(cardIds, destSelector, onDone) {
  const store = Alpine.store("g");
  const cards = cardIds.map(
    (id) => document.querySelector(`.gcard[data-id="${id}"]`)
  ).filter(Boolean);
  const destEl = document.querySelector(destSelector);
  if (!cards.length || !destEl) {
    if (onDone) onDone();
    return;
  }
  const destRect = destEl.getBoundingClientRect();
  const destX = destRect.left + destRect.width / 2;
  const destY = destRect.top + destRect.height / 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("fly-line");
  svg.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999";
  document.body.appendChild(svg);
  const clones = [];
  const lines = [];
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const len = Math.hypot(destX - sx, destY - sy);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", sx);
    line.setAttribute("y1", sy);
    line.setAttribute("x2", destX);
    line.setAttribute("y2", destY);
    line.setAttribute("stroke", "#7c3aed");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", len);
    line.setAttribute("stroke-dashoffset", "0");
    svg.appendChild(line);
    lines.push({ line, len });
    const clone = safeCloneCard(card);
    clone.classList.add("card-fly");
    clone.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;z-index:10000;pointer-events:none;transition:left .45s cubic-bezier(.4,0,.2,1),top .45s cubic-bezier(.4,0,.2,1);transform:scale(.8);opacity:.9`;
    document.body.appendChild(clone);
    clones.push(clone);
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const c of clones) {
        c.style.left = destX + "px";
        c.style.top = destY + "px";
      }
      for (const l of lines) {
        l.line.style.transition = "stroke-dashoffset .45s cubic-bezier(.4,0,.2,1)";
        l.line.setAttribute("stroke-dashoffset", l.len);
      }
    });
  });
  setTimeout(() => {
    for (const c of clones) c.remove();
    svg.remove();
    if (onDone) onDone();
  }, 500);
}
function animateCardAction(entry, zone, fromMy) {
  const areaEl = document.getElementById(fromMy ? "my-area" : "opp-area");
  const destEl = document.getElementById("play-discard-zone");
  if (!areaEl || !destEl) return;
  const os = areaEl.getBoundingClientRect();
  const ds = destEl.getBoundingClientRect();
  const sx = os.left + os.width / 2;
  const sy = os.top + os.height / 2;
  const dx = ds.left + ds.width / 2;
  const dy = ds.top + ds.height / 2;
  const len = Math.hypot(dx - sx, dy - sy);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999";
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", sx);
  line.setAttribute("y1", sy);
  line.setAttribute("x2", dx);
  line.setAttribute("y2", dy);
  line.setAttribute("stroke", zone === "play" ? "#22c55e" : "#ef4444");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", len);
  line.setAttribute("stroke-dashoffset", "0");
  svg.appendChild(line);
  document.body.appendChild(svg);
  const ghost = document.createElement("div");
  ghost.className = "gcard facedown card-fly";
  ghost.style.cssText = `position:fixed;left:${sx - 40}px;top:${sy - 55}px;z-index:10000;pointer-events:none;transition:left .45s cubic-bezier(.4,0,.2,1),top .45s cubic-bezier(.4,0,.2,1);transform:scale(.7);opacity:.85`;
  ghost.innerHTML = `<span class="gsuit">\u{1F0CF}</span><span class="gname" style="font-size:10px">${entry.cardName}</span>`;
  document.body.appendChild(ghost);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ghost.style.left = dx - 40 + "px";
      ghost.style.top = dy - 55 + "px";
      line.style.transition = "stroke-dashoffset .45s cubic-bezier(.4,0,.2,1)";
      line.setAttribute("stroke-dashoffset", len);
    });
  });
  setTimeout(() => {
    ghost.remove();
    svg.remove();
  }, 500);
}
function animatePickDiscardFly(cards, destEl, onDone) {
  const dr = destEl.getBoundingClientRect();
  const dx = dr.left + dr.width / 2;
  const dy = dr.top + dr.height / 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999";
  const clones = [];
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const len = Math.hypot(dx - sx, dy - sy);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", sx);
    line.setAttribute("y1", sy);
    line.setAttribute("x2", dx);
    line.setAttribute("y2", dy);
    line.setAttribute("stroke", "#ef4444");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", len);
    line.setAttribute("stroke-dashoffset", "0");
    svg.appendChild(line);
    const clone = safeCloneCard(card);
    clone.classList.add("card-fly");
    clone.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;z-index:10000;pointer-events:none;transition:left .45s,top .45s;transform:scale(.8);opacity:.9`;
    document.body.appendChild(clone);
    clones.push({ el: clone, line, len, dx, dy });
  }
  document.body.appendChild(svg);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const c of clones) {
        c.el.style.left = c.dx + "px";
        c.el.style.top = c.dy + "px";
        c.line.style.transition = "stroke-dashoffset .45s cubic-bezier(.4,0,.2,1)";
        c.line.setAttribute("stroke-dashoffset", c.len);
      }
    });
  });
  setTimeout(() => {
    for (const c of clones) c.el.remove();
    svg.remove();
    if (onDone) onDone();
  }, 500);
}
function animateStealFly(pos, onDone) {
  const stealCard = document.querySelector(`.steal-card[data-pos="${pos}"]`);
  const dest = document.getElementById("my-area");
  if (!stealCard || !dest) {
    if (onDone) onDone();
    return;
  }
  const sr = stealCard.getBoundingClientRect();
  const dr = dest.getBoundingClientRect();
  const sx = sr.left + sr.width / 2;
  const sy = sr.top + sr.height / 2;
  const dx = dr.left + dr.width / 2;
  const dy = dr.top + dr.height / 2;
  const len = Math.hypot(dx - sx, dy - sy);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("fly-line");
  svg.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999";
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", sx);
  line.setAttribute("y1", sy);
  line.setAttribute("x2", dx);
  line.setAttribute("y2", dy);
  line.setAttribute("stroke", "#7c3aed");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", len);
  line.setAttribute("stroke-dashoffset", "0");
  svg.appendChild(line);
  document.body.appendChild(svg);
  const clone = safeCloneCard(stealCard);
  clone.classList.add("card-fly");
  clone.style.cssText = `position:fixed;left:${sr.left}px;top:${sr.top}px;z-index:10000;pointer-events:none;transition:left .45s cubic-bezier(.4,0,.2,1),top .45s cubic-bezier(.4,0,.2,1);transform:scale(.8);opacity:.9`;
  document.body.appendChild(clone);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.left = dx + "px";
      clone.style.top = dy + "px";
      line.style.transition = "stroke-dashoffset .45s cubic-bezier(.4,0,.2,1)";
      line.setAttribute("stroke-dashoffset", len);
    });
  });
  setTimeout(() => {
    clone.remove();
    svg.remove();
    if (onDone) onDone();
  }, 500);
}
