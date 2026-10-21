window.dangerMapFailed = () => {
  document.getElementById('danger-map-status').textContent = '地図を読み込めませんでした。時間をおいて再読み込みしてください。';
};
window.gm_authFailure = window.dangerMapFailed;
window.initDangerMap = async () => {
  const element = document.getElementById('danger-history-map');
  if (!element) return;
  const points = JSON.parse(element.dataset.points), markers = new Map(), pending = new Map();
  const bounds = new google.maps.LatLngBounds(), info = new google.maps.InfoWindow();
  const map = new google.maps.Map(element, { center: { lat: 36, lng: 138 }, zoom: 5 });
  const geocoder = new google.maps.Geocoder(), addresses = new Map();
  const status = document.getElementById('danger-map-status');
  let selected = null, timer, interacted = false, failed = 0;
  function highlight(id) {
    const entry = markers.get(id);
    if (!entry) return false;
    interacted = true;
    if (selected) { selected.setAnimation(null); selected.setZIndex(undefined); }
    clearTimeout(timer);
    selected = entry.marker;
    selected.setZIndex(10000);
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      selected.setAnimation(google.maps.Animation.BOUNCE);
      const active = selected;
      timer = setTimeout(() => active.setAnimation(null), 2100);
    }
    map.panTo(selected.getPosition());
    if (map.getZoom() < 15) map.setZoom(15);
    const content = document.createElement('div'), link = document.createElement('a');
    link.href = entry.point.url; link.textContent = entry.point.title; content.append(link);
    if (entry.point.address) { const note = document.createElement('p'); note.textContent = `${entry.point.address}（大まかな場所）`; content.append(note); }
    info.setContent(content); info.open({ map, anchor: selected });
    document.querySelectorAll('[data-danger-focus]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.dangerFocus === id)));
    status.textContent = `${entry.point.title}の場所を表示しています。`;
    return true;
  }
  window.focusDangerReport = async id => {
    if (!markers.has(id) && pending.has(id)) { status.textContent = '投稿場所を確認しています…'; await pending.get(id); }
    if (!highlight(id)) status.textContent = 'この投稿の場所を特定できませんでした。投稿の住所・内容をご確認ください。';
  };
  async function addPoint(point) {
    try {
      let position;
      if (point.address) {
        if (!addresses.has(point.address)) addresses.set(point.address, geocoder.geocode({ address: point.address, region: 'jp' }));
        const result = await addresses.get(point.address);
        position = result.results[0]?.geometry.location;
        if (!position) throw new Error('No location');
      } else {
        if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) throw new Error('Invalid location');
        position = { lat: point.latitude, lng: point.longitude };
      }
      const marker = new google.maps.Marker({ position, map, title: point.title });
      markers.set(point.id, { marker, point }); bounds.extend(position);
      marker.addListener('click', () => highlight(point.id));
    } catch { failed++; }
  }
  // Register promises before awaiting so early photo taps can wait for their pin.
  points.forEach(point => pending.set(point.id, addPoint(point)));
  await Promise.all(pending.values());
  if (!interacted && markers.size) {
    map.fitBounds(bounds);
    google.maps.event.addListenerOnce(map, 'idle', () => { if (!interacted && map.getZoom() > 16) map.setZoom(16); });
  }
  if (!interacted) status.textContent = `${markers.size}件の場所を地図に表示しました。${failed ? ` ${failed}件は場所を特定できませんでした。` : ''}`;
  if (window.pendingDangerReport) { const id = window.pendingDangerReport; window.pendingDangerReport = null; await window.focusDangerReport(id); }
};
