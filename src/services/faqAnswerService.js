import sanitizeHtml from 'sanitize-html';

export const sanitizeFaqAnswer = html => sanitizeHtml(html, {
  allowedTags: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'hr', 'font', 'ul', 'ol', 'li', 'blockquote', 'a'],
  allowedAttributes: { a: ['href', 'title'], '*': ['style'] },
  // Only text colors and paragraph alignment survive; all other CSS is removed.
  allowedStyles: {
    '*': { color: [/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i] },
    'p': { 'text-align': [/^(left|center|right)$/] },
    'div': { 'text-align': [/^(left|center|right)$/] },
    'h1': { 'text-align': [/^(left|center|right)$/] },
    'h2': { 'text-align': [/^(left|center|right)$/] },
    'h3': { 'text-align': [/^(left|center|right)$/] },
    'h4': { 'text-align': [/^(left|center|right)$/] },
    'h5': { 'text-align': [/^(left|center|right)$/] },
    'h6': { 'text-align': [/^(left|center|right)$/] },
    'blockquote': { 'text-align': [/^(left|center|right)$/] }
  },
  transformTags: {
    font: (_tag, attributes) => ({ tagName: 'span', attribs: { style: `color: ${attributes.color || ''}` } })
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false
});
const escapeHtml = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const faqAnswerHtml = item => item.answerFormat === 'html'
  ? sanitizeFaqAnswer(item.answer || '')
  : escapeHtml(item.answer || '').replace(/\r?\n/g, '<br>');
export const faqAnswerText = item => sanitizeHtml(faqAnswerHtml(item).replace(/<\/(?:p|div|h[1-6]|li|blockquote)>|<br\s*\/?\s*>/gi, '\n'), { allowedTags: [], allowedAttributes: {} });
