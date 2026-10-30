import { benefitColors, benefitIcons } from '../public/join-benefit-options.js';
export { benefitColors, benefitIcons };
export function joinBenefitValues(body) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  const fields = ['benefitTitle', 'benefitContent', 'benefitColor', 'benefitIcon'].map(name => {
    const value = body[name];
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    if (values.length > 10) fail('メリットは10件以内で登録してください。');
    if (values.some(item => typeof item !== 'string')) fail('メリットの入力形式を確認してください。');
    return values;
  });
  const [titles, contents, colors, icons] = fields;
  return Array.from({ length: Math.max(...fields.map(items => items.length)) }, (_, i) => ({
    title: (titles[i] || '').trim(), content: (contents[i] || '').trim(),
    color: colors[i] || 'green', icon: icons[i] || 'town'
  })).filter(item => item.title || item.content).map(item => {
    if (!item.title || !item.content) fail('メリットのタイトルと内容を両方入力してください。');
    if (item.title.length > 100 || item.content.length > 2000) fail('タイトルは100文字、内容は2000文字以内で入力してください。');
    if (!benefitColors.some(([value]) => value === item.color) || !benefitIcons.some(([value]) => value === item.icon)) fail('カラーとアイコンは選択肢から選んでください。');
    return item;
  });
}
