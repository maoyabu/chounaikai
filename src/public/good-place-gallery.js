document.querySelectorAll('[data-good-place-gallery]').forEach(gallery => {
  if (gallery.dataset.initialized || gallery.dataset.rotating !== 'true') return;
  gallery.dataset.initialized = 'true';
  const cards = [...gallery.querySelectorAll('.good-place-feature')];
  const slots = Number(gallery.dataset.slots);
  const controls = gallery.querySelector('.good-place-gallery-controls');
  const pause = gallery.querySelector('[data-gallery-pause]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let offset = 0, timer, paused = reducedMotion.matches, hovering = false;
  controls.hidden = false;
  function render() {
    cards.forEach((card, index) => {
      const rank = (index - offset + cards.length) % cards.length;
      card.hidden = rank >= slots;
      card.style.order = String(rank);
      card.classList.toggle('is-featured', rank === 0);
    });
  }
  function schedule() {
    clearInterval(timer);
    const focused = gallery.contains(document.activeElement);
    if (!paused && !hovering && !focused && !document.hidden) {
      timer = setInterval(() => { offset = (offset + 1) % cards.length; render(); }, 6000);
    }
    pause.textContent = paused ? '自動再生' : '一時停止';
    pause.setAttribute('aria-pressed', String(paused));
  }
  function step(amount) { offset = (offset + amount + cards.length) % cards.length; render(); schedule(); }
  gallery.querySelector('[data-gallery-prev]').addEventListener('click', () => step(-1));
  gallery.querySelector('[data-gallery-next]').addEventListener('click', () => step(1));
  pause.addEventListener('click', () => { paused = !paused; schedule(); });
  gallery.addEventListener('mouseenter', () => { hovering = true; schedule(); });
  gallery.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  gallery.addEventListener('focusin', schedule);
  gallery.addEventListener('focusout', () => setTimeout(schedule, 0));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', event => { paused = event.matches; schedule(); });
  render(); schedule();
});
