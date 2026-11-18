(() => {
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ja');
  document.querySelectorAll('[data-event-filter-scope]').forEach(scope => {
    const controls = Object.fromEntries([...scope.querySelectorAll('[data-event-filter]')].map(input => [input.dataset.eventFilter, input]));
    const items = [...scope.querySelectorAll('[data-filter-event]')];
    const update = () => {
      const words = normalize(controls.search?.value).trim().split(/\s+/).filter(Boolean);
      items.forEach(item => {
        const date = item.dataset.startDate || '';
        const year = String(Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 4 ? 1 : 0));
        const department = item.dataset.department || 'unset';
        item.hidden = (controls.completed.value === 'hide' && item.dataset.completed === 'true')
          || Boolean(controls.year?.value && controls.year.value !== year)
          || Boolean(controls.department?.value && controls.department.value !== department)
          || !words.every(word => normalize(item.dataset.search).includes(word));
      });
      scope.querySelector('[data-event-filter-empty]').hidden = !items.length || items.some(item => !item.hidden);
    };
    Object.values(controls).forEach(input => input.addEventListener('input', update));
    update();
  });
})();
