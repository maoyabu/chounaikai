// Use the configured public origin, never the request Host or query parameters.
export const publicSiteCanonical = (req, path, parameters = {}) => {
  const base = new URL(req.app?.locals.publicBaseUrl || process.env.PUBLIC_BASE_URL || 'http://localhost:3003');
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('PUBLIC_BASE_URL must use HTTP or HTTPS');
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) throw new Error('Canonical URL must use the public origin');
  url.search = ''; url.hash = '';
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  return url.href;
};
export const publicPageCanonical = (req, associationId, groupId) => {
  const path = groupId
    ? `/associations/${encodeURIComponent(String(associationId))}/groups/${encodeURIComponent(String(groupId))}`
    : `/associations/${encodeURIComponent(String(associationId))}/public`;
  return publicSiteCanonical(req, path);
};

const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim();
export const publicSeoValues = body => {
  const values = {};
  for (const [field, max, label] of [['publicPageTitle', 120, '検索用タイトル'], ['publicMetaDescription', 300, '検索用説明文']]) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== 'string') throw Object.assign(new Error(`${label}を正しく入力してください。`), { status: 400 });
    const value = oneLine(body[field]);
    if (value.length > max) throw Object.assign(new Error(`${label}は${max}文字以内で入力してください。`), { status: 400 });
    values[field] = value;
  }
  return values;
};
export const publicPageMetadata = (association, group) => {
  const page = group || association;
  const title = oneLine(page.publicPageTitle) || (group ? `${group.name} | ${association.name}` : `${association.name}のご案内`);
  const introduction = oneLine(group ? group.publicDescription || group.purpose : association.introduction);
  const fallback = group ? `${association.name}のグループ「${group.name}」の紹介ページです。` : `${association.name}の紹介ページです。地域の活動や町内会の情報をご案内します。`;
  return { title, documentTitle: `${title} | まちの伝言板`, metaDescription: oneLine(page.publicMetaDescription) || (introduction ? `${group ? `${association.name}・${group.name}` : association.name}：${introduction}`.slice(0, 160) : fallback) };
};

export const goodPlaceHistoryCanonical = (req, associationId, page, sort) => publicSiteCanonical(req, `/associations/${encodeURIComponent(String(associationId))}/good-places`, { ...(page > 1 ? { page } : {}), ...(sort === 'likes' ? { sort } : {}) });
