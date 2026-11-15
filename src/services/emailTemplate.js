// Body markup is assembled by callers; escape all user-provided values there.
export const renderEmailHtml = ({ title, bodyHtml }) => {
  const safeTitle = String(title).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeTitle}</title></head>
<body style="margin:0;padding:24px 12px;background:#f3f6f4;color:#24352d;font-family:Arial,'Hiragino Kaku Gothic ProN',Meiryo,sans-serif;line-height:1.8;overflow-wrap:anywhere">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dce5df;border-radius:12px"><tr><td style="padding:24px">
<p style="margin:0 0 16px;color:#176b4d;font-weight:bold">まちの伝言板</p>
<h1 style="margin:0 0 24px;font-size:22px;line-height:1.5">${safeTitle}</h1>
${bodyHtml}
</td></tr></table>
</td></tr></table>
</body></html>`;
};
