(() => {
  const button = document.getElementById('danger-open');
  if (!button) return;
  const key = 'danger-fab-position-v1';
  let saved, drag, suppressClick = false;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }
  const limits = () => ({ x: Math.max(8, window.innerWidth - button.offsetWidth - 8), y: Math.max(8, window.innerHeight - button.offsetHeight - 8) });
  function move(x, y) {
    const max = limits();
    const left = Math.min(max.x, Math.max(8, x));
    const top = Math.min(max.y, Math.max(8, y));
    Object.assign(button.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    saved = { x: max.x > 8 ? (left - 8) / (max.x - 8) : 0, y: max.y > 8 ? (top - 8) / (max.y - 8) : 0 };
  }
  function restore() {
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
    const max = limits();
    move(8 + saved.x * (max.x - 8), 8 + saved.y * (max.y - 8));
  }
  function persist() {
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Movement still works without storage. */ }
  }
  restore();
  window.addEventListener('resize', restore);
  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    const rect = button.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    button.classList.add('is-dragging');
    move(drag.left + dx, drag.top + dy);
  });
  function finish(event) {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = drag.moved;
    if (drag.moved) persist();
    drag = null;
    button.classList.remove('is-dragging');
  }
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', finish);
  button.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    suppressClick = false;
  }, true);
  button.addEventListener('keydown', event => {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const rect = button.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
    move(rect.left + direction[0] * step, rect.top + direction[1] * step);
    persist();
  });
})();
