export function parseDistrictMapUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    if (input.length > 2048 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw Object.assign(new Error('地区・班の区分地図URLは http:// または https:// で始まる有効なURLを入力してください（2048文字以内）。'), { status: 400 });
  }
}

export function districtMapPresentation(value) {
  let href;
  try { href = parseDistrictMapUrl(value); } catch { return null; }
  if (!href) return null;
  const url = new URL(href);
  let mapId = '';
  if (['www.google.com', 'google.com'].includes(url.hostname) && url.pathname.startsWith('/maps/d/')) {
    mapId = url.searchParams.get('mid') || '';
  } else if (url.hostname === 'earth.google.com') {
    // My Maps exports its map ID as a length-delimited field in Earth share URLs.
    const data = url.pathname.match(/\/data=([A-Za-z0-9_-]+)/)?.[1];
    if (data) mapId = Buffer.from(data, 'base64url').toString('latin1').match(/\x0a\x21([A-Za-z0-9_-]{33})/)?.[1] || '';
  }
  const embedUrl = /^[A-Za-z0-9_-]+$/.test(mapId) ? `https://www.google.com/maps/d/embed?mid=${encodeURIComponent(mapId)}` : '';
  return { href, embedUrl };
}
