document.querySelectorAll('[data-photo-comments]').forEach(panel => {
  const comments = [...panel.querySelectorAll('[data-photo-comment]')];
  if (comments.length < 2) return;
  const position = panel.querySelector('[data-photo-comment-position]');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0, timer, paused = reducedMotion.matches, hovering = false;
  function next() {
    index = (index + 1) % comments.length;
    comments.forEach((comment, i) => { comment.hidden = i !== index; });
    position.textContent = `${index + 1} / ${comments.length}`;
  }
  function schedule() {
    clearInterval(timer);
    if (!paused && !hovering && !panel.contains(document.activeElement) && !document.hidden) timer = setInterval(next, 6000);
  }
  panel.addEventListener('mouseenter', () => { hovering = true; schedule(); });
  panel.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  panel.addEventListener('focusin', schedule);
  panel.addEventListener('focusout', () => setTimeout(schedule, 0));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', () => { paused = reducedMotion.matches; schedule(); });
  schedule();
});
