document.querySelectorAll('[data-photo-post-dialog]').forEach(dialog => {
  if (dialog.dataset.initialized) return;
  dialog.dataset.initialized = 'true';
  const prefix = dialog.dataset.photoPostDialog;
  const field = suffix => document.getElementById(`${prefix}-${suffix}`);
  const form = field('form'), status = field('location'), error = field('error'), submit = field('submit');
  let position = null, request = 0, previewUrl, sending = false;
  function showPosition() {
    status.textContent = position.locationSource === 'photo'
      ? '写真に含まれる撮影場所を使用します。現在地を使う場合は「現在地を取得」を押してください。'
      : `現在地を取得しました（精度 約${Math.round(position.accuracy)}m）。`;
  }
  function locate() {
    const current = ++request;
    status.textContent = '現在地を取得しています…';
    const failed = reason => {
      if (current !== request) return;
      const messages = {
        1: 'このサイトの位置情報が許可されていません。ブラウザのサイト設定と端末の位置情報の許可を確認してください。',
        2: '端末の現在地を確認できません。位置情報設定と通信状態を確認して再取得してください。',
        3: '現在地の取得がタイムアウトしました。通信状態の良い場所で再取得してください。'
      };
      status.textContent = messages[reason.code] || reason.message || '位置情報を取得できませんでした。';
      if (position) status.textContent += ' 取得済みの位置情報は保持しています。';
      else status.textContent += ' 住所・場所を入力すれば投稿できます（大まかでも構いません）。';
    };
    if (window.isSecureContext === false) { failed({ message: '現在地の取得にはHTTPSでの接続が必要です。HTTPSのURLで開き直してください。' }); return; }
    if (!navigator.geolocation) { failed({ message: 'このブラウザでは現在地を取得できません。位置情報付きの写真を選択してください。' }); return; }
    DangerLocation.getDeviceLocation(navigator.geolocation, result => {
      if (current !== request) return;
      position = result; showPosition();
    }, failed);
  }
  field('open')?.addEventListener('click', () => dialog.showModal());
  if (dialog.dataset.autoOpen === 'true') dialog.showModal();
  field('close').addEventListener('click', () => { if (!sending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (sending) event.preventDefault(); });
  field('locate').addEventListener('click', locate);
  form.elements.photo.addEventListener('change', async () => {
    position = null; const selection = ++request;
    const preview = field('preview'), file = form.elements.photo.files[0];
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    preview.hidden = true;
    if (!file) { status.textContent = '写真を選ぶと撮影場所または現在地を取得します。'; return; }
    previewUrl = URL.createObjectURL(file); preview.src = previewUrl; preview.hidden = false;
    status.textContent = '写真の位置情報を確認しています…';
    let photoPosition = null;
    try { photoPosition = DangerLocation.readPhotoLocation(await file.arrayBuffer()); } catch { /* Use device location if metadata cannot be read. */ }
    if (selection !== request) return;
    if (photoPosition) { position = photoPosition; showPosition(); }
    else locate();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    error.textContent = '';
    if (!position && !form.elements.address.value.trim()) { error.textContent = '位置情報を取得するか、住所・場所を入力してください（大まかでも構いません）。'; form.elements.address.focus(); return; }
    if (form.elements.photo.files[0]?.size > 10 * 1024 * 1024) { error.textContent = '写真は10MB以下にしてください。'; return; }
    const data = new FormData(form);
    if (position) Object.entries(position).forEach(([key, value]) => data.set(key, value));
    else data.set('locationSource', 'address');
    sending = true; submit.disabled = true; submit.textContent = '投稿しています…';
    try {
      const response = await fetch(`/associations/${form.elements.association.value}/${dialog.dataset.postPath}`, { method: 'POST', headers: { 'x-csrf-token': document.querySelector('meta[name="csrf-token"]').content }, body: data });
      if (!response.ok) throw new Error('投稿できませんでした。写真の形式、入力内容、ログイン状態を確認して再度お試しください。');
      const result = await response.json();
      location.assign(result.url);
    } catch (reason) { error.textContent = reason.message; }
    finally { sending = false; submit.disabled = false; submit.textContent = '投稿する'; }
  });
});
