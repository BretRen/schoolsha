// anim.ts — 卡牌飞行 + 细线动画

/** 卡牌飞行动画：从手牌飞到目标区域，细线跟随缩短 */
function animateCardFly(cardIds, destSelector, onDone) {
  const store = Alpine.store("g");
  const cards = cardIds.map(id => document.querySelector(`.gcard[data-id="${id}"]`)).filter(Boolean);
  const destEl = document.querySelector(destSelector);
  if (!cards.length || !destEl) { if (onDone) onDone(); return; }

  const destRect = destEl.getBoundingClientRect();
  const destX = destRect.left + destRect.width / 2;
  const destY = destRect.top + destRect.height / 2;

  // SVG overlay for lines
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

    // Line
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

    // Clone card
    const clone = card.cloneNode(true);
    clone.classList.add("card-fly");
    clone.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;z-index:10000;pointer-events:none;transition:left .45s cubic-bezier(.4,0,.2,1),top .45s cubic-bezier(.4,0,.2,1);transform:scale(.8);opacity:.9`;
    document.body.appendChild(clone);
    clones.push(clone);
  }

  // Trigger animation
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

  // Cleanup
  setTimeout(() => {
    for (const c of clones) c.remove();
    svg.remove();
    if (onDone) onDone();
  }, 500);
}

/** 从对手面板偷牌动画 */
function animateStealFly(pos, onDone) {
  const stealCard = document.querySelector(`.steal-card[data-pos="${pos}"]`);
  const dest = document.getElementById("my-area");
  if (!stealCard || !dest) { if (onDone) onDone(); return; }

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
  line.setAttribute("x1", sx); line.setAttribute("y1", sy);
  line.setAttribute("x2", dx); line.setAttribute("y2", dy);
  line.setAttribute("stroke", "#7c3aed"); line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", len); line.setAttribute("stroke-dashoffset", "0");
  svg.appendChild(line);
  document.body.appendChild(svg);

  const clone = stealCard.cloneNode(true);
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

  setTimeout(() => { clone.remove(); svg.remove(); if (onDone) onDone(); }, 500);
}
