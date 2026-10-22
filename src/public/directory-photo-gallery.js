document.querySelectorAll('[data-directory-photo-gallery]').forEach(gallery => {
  const track = gallery.querySelector('.directory-photo-track');
  const intervalSelect = gallery.querySelector('[data-photo-interval]');
  const storageKey = 'directory-photo-interval';
  const allowedSeconds = [3, 5, 10, 15, 30];
  const validSeconds = value => allowedSeconds.includes(Number(value)) ? Number(value) : 5;
  let seconds = 5;
  try { seconds = validSeconds(window.localStorage.getItem(storageKey)); } catch { /* Storage is optional. */ }
  intervalSelect.value = String(seconds);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let timer, animation, hovering = false;
  function reset() {
    animation?.cancel();
    animation = null;
    [...track.children].forEach((card, index) => { card.hidden = index >= 3; });
  }
  function schedule() {
    clearInterval(timer);
    if (motion.matches || hovering || gallery.contains(document.activeElement) || document.hidden || track.children.length <= 3) return;
    timer = setInterval(() => {
      if (animation) return;
      const first = track.firstElementChild;
      const incoming = track.children[3];
      incoming.hidden = false;
      incoming.querySelector('img').loading = 'eager';
      const distance = incoming.getBoundingClientRect().top - track.children[2].getBoundingClientRect().top;
      const current = track.animate([{ transform: 'translateY(0)' }, { transform: `translateY(-${distance}px)` }], { duration: 700, easing: 'ease-in-out', fill: 'forwards' });
      animation = current;
      current.finished.then(() => {
        if (animation !== current) return;
        track.append(first);
        reset();
      }, () => {});
    }, seconds * 1000);
  }
  function stop() { clearInterval(timer); reset(); }
  gallery.addEventListener('mouseenter', () => { hovering = true; stop(); });
  gallery.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  gallery.addEventListener('focusin', stop);
  gallery.addEventListener('focusout', () => setTimeout(schedule, 0));
  intervalSelect.addEventListener('change', () => {
    seconds = validSeconds(intervalSelect.value);
    intervalSelect.value = String(seconds);
    try { window.localStorage.setItem(storageKey, String(seconds)); } catch { /* Storage is optional. */ }
    stop(); schedule();
  });
  document.addEventListener('visibilitychange', () => { stop(); schedule(); });
  motion.addEventListener('change', () => { stop(); schedule(); });
  window.addEventListener('resize', () => { stop(); schedule(); });
  schedule();
});
