document.querySelectorAll('[data-good-place-gallery]').forEach(gallery => {
  if (gallery.dataset.initialized || gallery.dataset.rotating !== 'true') return;
  gallery.dataset.initialized = 'true';
  const cards = [...gallery.querySelectorAll('.good-place-feature')];
  const slots = Number(gallery.dataset.slots);
  const grid = gallery.querySelector('.good-place-grid');
  const controls = gallery.querySelector('.good-place-gallery-controls');
  const pause = gallery.querySelector('[data-gallery-pause]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let offset = 0, timer, paused = reducedMotion.matches, hovering = false;
  controls.hidden = false;
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
    cards.forEach((card, index) => {
      const rank = (index - offset + cards.length) % cards.length;
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
    if (!paused && !hovering && !focused && !document.hidden) {
      timer = setInterval(() => { offset = (offset + 1) % cards.length; render(true); }, 6000);
    }
    pause.textContent = paused ? '自動再生' : '一時停止';
    pause.setAttribute('aria-pressed', String(paused));
  }
  function step(amount) { offset = (offset + amount + cards.length) % cards.length; render(true); schedule(); }
  gallery.querySelector('[data-gallery-prev]').addEventListener('click', () => step(-1));
  gallery.querySelector('[data-gallery-next]').addEventListener('click', () => step(1));
  pause.addEventListener('click', () => { paused = !paused; schedule(); });
  gallery.addEventListener('mouseenter', () => { hovering = true; schedule(); });
  gallery.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  gallery.addEventListener('focusin', schedule);
  gallery.addEventListener('focusout', () => setTimeout(schedule, 0));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', event => { paused = event.matches; discardTransition(); schedule(); });
  window.addEventListener('resize', discardTransition);
  render(); schedule();
});
