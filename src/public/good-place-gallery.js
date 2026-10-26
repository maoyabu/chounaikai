document.querySelectorAll('[data-good-place-gallery]').forEach(gallery => {
  if (gallery.dataset.galleryStateKey && !gallery.dataset.stateInitialized) {
    gallery.dataset.stateInitialized = 'true';
    const key = `gallery-open:${window.location.pathname}:${gallery.dataset.galleryStateKey}`;
    try {
      const saved = window.localStorage.getItem(key);
      if (saved === 'closed' || saved === 'open') gallery.open = saved === 'open';
    } catch { /* Opening and closing still work when storage is unavailable. */ }
    gallery.addEventListener('toggle', () => {
      try { window.localStorage.setItem(key, gallery.open ? 'open' : 'closed'); } catch { /* Storage is optional. */ }
    });
  }
  if (gallery.dataset.initialized || gallery.dataset.rotating !== 'true') return;
  gallery.dataset.initialized = 'true';
  const cards = [...gallery.querySelectorAll('.good-place-feature')];
  const slots = Number(gallery.dataset.slots);
  const grid = gallery.querySelector('.good-place-grid');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let offset = 0, timer, hovering = false;
  let outgoing = null, fade = null;
  function discardTransition() {
    fade?.cancel();
    outgoing?.remove();
    outgoing = null; fade = null;
  }
  function render(transition = false) {
    discardTransition();
    // Keep the previous layout above the next one; fading it reveals the new
    // photos with a cross dissolve, without moving the links or grid cells.
    if (transition && !reducedMotion.matches && typeof grid?.animate === 'function') {
      outgoing = grid.cloneNode(true);
      outgoing.setAttribute('aria-hidden', 'true');
      outgoing.inert = true;
      outgoing.classList.add('good-place-gallery-outgoing');
      Object.assign(outgoing.style, { left: `${grid.offsetLeft}px`, top: `${grid.offsetTop}px`, width: `${grid.offsetWidth}px`, height: `${grid.offsetHeight}px` });
      outgoing.querySelectorAll('a').forEach(link => { link.removeAttribute('href'); link.tabIndex = -1; });
      gallery.append(outgoing);
    }
    const ordered = cards.map((_, index) => cards[(offset + index) % cards.length]);
    let selected = ordered.slice(0, slots);
    if (gallery.dataset.diverseAssociations === 'true') {
      selected = [];
      const associations = new Set();
      for (const card of ordered) {
        if (associations.has(card.dataset.association)) continue;
        selected.push(card);
        associations.add(card.dataset.association);
        if (selected.length === slots) break;
      }
      for (const card of ordered) {
        if (selected.length === slots) break;
        if (!selected.includes(card)) selected.push(card);
      }
    }
    cards.forEach((card) => {
      const selectedRank = selected.indexOf(card);
      const rank = selectedRank < 0 ? slots : selectedRank;
      card.hidden = rank >= slots;
      card.style.order = String(rank);
      card.classList.toggle('is-featured', rank === 0);
    });
    if (outgoing) {
      const snapshot = outgoing;
      const ready = cards.filter(card => !card.hidden).map(card => {
        const image = card.querySelector('img');
        image.loading = 'eager';
        return typeof image.decode === 'function' ? image.decode() : Promise.resolve();
      });
      Promise.allSettled(ready).then(() => {
        if (outgoing !== snapshot) return;
        fade = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 800, easing: 'ease-in-out', fill: 'forwards' });
        fade.finished.then(() => { snapshot.remove(); if (outgoing === snapshot) { outgoing = null; fade = null; } }, () => snapshot.remove());
      });
    }
  }
  function schedule() {
    clearInterval(timer);
    const focused = gallery.contains(document.activeElement);
    if (!reducedMotion.matches && !hovering && !focused && !document.hidden && (gallery.tagName !== 'DETAILS' || gallery.open)) {
      timer = setInterval(() => { offset = (offset + 1) % cards.length; render(true); }, 6000);
    }
  }
  gallery.addEventListener('toggle', () => { discardTransition(); schedule(); });
  gallery.addEventListener('mouseenter', () => { hovering = true; schedule(); });
  gallery.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  gallery.addEventListener('focusin', schedule);
  gallery.addEventListener('focusout', () => setTimeout(schedule, 0));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', () => { discardTransition(); schedule(); });
  window.addEventListener('resize', discardTransition);
  render(); schedule();
});
