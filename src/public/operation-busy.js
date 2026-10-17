(() => {
  let active = false;
  let managed = false;
  let overlay;
  let previousFocus;
  let inertElements = [];
  const begin = (message = '更新・処理中です') => {
    if (active) return false;
    active = true;
    previousFocus = document.activeElement;
    overlay = document.createElement('dialog');
    overlay.className = 'operation-busy';
    overlay.setAttribute('aria-label', message);
    overlay.innerHTML = '<div role="status" aria-live="polite"><span class="operation-busy-spinner" aria-hidden="true"></span><strong></strong><p>完了するまでお待ちください。</p></div>';
    overlay.querySelector('strong').textContent = message;
    document.body.append(overlay);
    inertElements = [...document.body.children].filter(element => element !== overlay && !element.inert);
    inertElements.forEach(element => { element.inert = true; });
    document.body.setAttribute('aria-busy', 'true');
    overlay.addEventListener('cancel', event => event.preventDefault());
    overlay.showModal();
    return true;
  };
  const end = () => {
    if (!active) return;
    active = false;
    overlay.close(); overlay.remove();
    inertElements.forEach(element => { element.inert = false; });
    inertElements = [];
    document.body.removeAttribute('aria-busy');
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  window.AppBusy = {
    get active() { return active; },
    async run(task, message) {
      if (!begin(message)) return;
      managed = true;
      try { return await task(); } finally { managed = false; end(); }
    }
  };
  // Capture before any screen-specific listeners, including dynamically created forms.
  for (const type of ['click', 'dblclick', 'keydown', 'keyup', 'input', 'change', 'pointerdown', 'touchstart', 'dragstart', 'drop', 'submit']) {
    window.addEventListener(type, event => {
      if (!active) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }
  const isCurrentTarget = target => !target || ['_self', '_top', '_parent'].includes(target.toLowerCase());
  const isPageUrl = value => {
    const url = new URL(value, location.href);
    // These responses leave the current document open (downloads and attachments).
    return /^https?:$/.test(url.protocol) && !/\/(?:download|export|attachments|question-attachments)(?:\/|$)|\.(?:xlsx?|csv|pdf|zip)$/i.test(url.pathname);
  };
  window.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download') || link.getAttribute('href')?.startsWith('#') || !isCurrentTarget(link.target) || !isPageUrl(link.href)) return;
    const url = new URL(link.href, location.href);
    const current = new URL(location.href);
    if (url.hash && url.origin === current.origin && url.pathname === current.pathname && url.search === current.search) return;
    begin('ページを読み込み中です');
  });
  // Bubble after validation, confirmation and AJAX handlers have decided whether to submit.
  window.addEventListener('submit', event => {
    const form = event.target;
    const method = (event.submitter?.getAttribute('formmethod') || form.method).toLowerCase();
    const target = event.submitter?.getAttribute('formtarget') ?? form.target;
    const action = event.submitter?.getAttribute('formaction') || form.action || location.href;
    if (event.defaultPrevented || method === 'dialog' || !isCurrentTarget(target) || !isPageUrl(action)) return;
    if (!begin(form.dataset.busyMessage || (method === 'get' ? 'ページを読み込み中です' : '送信・更新中です'))) event.preventDefault();
    // Keep controls enabled so named submit buttons and all form values are sent.
  });
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (active) return;
    if (this.method !== 'dialog' && isCurrentTarget(this.target) && isPageUrl(this.action || location.href)) begin(this.dataset.busyMessage || (this.method === 'get' ? 'ページを読み込み中です' : '送信・更新中です'));
    try { return nativeSubmit.call(this); } catch (error) { end(); throw error; }
  };
  // Fetch screens share the same lock, including response-body transfer for uploads/previews.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    const background = url.pathname.startsWith('/api/notifications/') || /\/questions\/[^/]+\/read$/.test(url.pathname);
    if (background || managed) return nativeFetch(input, options);
    if (!begin('通信・更新中です')) throw new Error('処理中です。完了するまでお待ちください。');
    try {
      const response = await nativeFetch(input, options);
      const body = await response.arrayBuffer();
      const buffered = new Response([101, 204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      });
      Object.defineProperties(buffered, { url: { value: response.url }, redirected: { value: response.redirected } });
      return buffered;
    } finally {
      // Allow the caller to handle the response and start navigation before unlocking.
      setTimeout(end, 0);
    }
  };
  window.addEventListener('pageshow', end);
})();
