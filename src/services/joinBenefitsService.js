export function joinBenefitValues(body) {
  const titles = Array.isArray(body.benefitTitle) ? body.benefitTitle : body.benefitTitle === undefined ? [] : [body.benefitTitle];
  const contents = Array.isArray(body.benefitContent) ? body.benefitContent : body.benefitContent === undefined ? [] : [body.benefitContent];
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (titles.length > 30 || contents.length > 30) fail('メリットは30件以内で登録してください。');
  return Array.from({ length: Math.max(titles.length, contents.length) }, (_, i) => {
    if ((titles[i] !== undefined && typeof titles[i] !== 'string') || (contents[i] !== undefined && typeof contents[i] !== 'string')) fail('メリットの入力形式を確認してください。');
    return { title: (titles[i] || '').trim(), content: (contents[i] || '').trim() };
  }).filter(item => item.title || item.content).map(item => {
    if (!item.title || !item.content) fail('メリットのタイトルと内容を両方入力してください。');
    if (item.title.length > 100 || item.content.length > 2000) fail('タイトルは100文字、内容は2000文字以内で入力してください。');
    return item;
  });
}
