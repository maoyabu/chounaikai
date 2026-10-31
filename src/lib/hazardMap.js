export function parseHazardMapUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    if (input.length > 2048 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    const error = new Error('ハザードマップURLは http:// または https:// で始まる有効なURLを入力してください（2048文字以内）。');
    error.status = 400;
    throw error;
  }
}
