import sanitizeHtml from 'sanitize-html';

export const sanitizeFaqAnswer = html => sanitizeHtml(html, {
  allowedTags: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a'],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false
});
const escapeHtml = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const faqAnswerHtml = item => item.answerFormat === 'html'
  ? sanitizeFaqAnswer(item.answer || '')
  : escapeHtml(item.answer || '').replace(/\r?\n/g, '<br>');
export const faqAnswerText = item => sanitizeHtml(faqAnswerHtml(item).replace(/<\/(?:p|div|h2|h3|li|blockquote)>|<br\s*\/?\s*>/gi, '\n'), { allowedTags: [], allowedAttributes: {} });
