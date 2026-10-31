import { readFile } from 'node:fs/promises';
import { jsPDF } from 'jspdf';

let font;
const loadFont = () => font ||= readFile(new URL('../assets/fonts/ipaexg.ttf', import.meta.url)).then(data => data.toString('base64')).catch(error => { font = undefined; throw error; });

export async function safetyReportPdf(report) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true, putOnlyUsedFonts: true });
  pdf.addFileToVFS('ipaexg.ttf', await loadFont());
  pdf.addFont('ipaexg.ttf', 'IPAexGothic', 'normal');
  pdf.setFont('IPAexGothic');
  pdf.setProperties({ title: '災害時安否状況報告書', subject: report.associationName, creator: 'まちの伝言板' });
  pdf.setTextColor(20);
  pdf.setDrawColor(110);
  pdf.setLineWidth(.2);
  const left = 16, right = 194, width = right - left;
  let y = 20;
  const space = height => { if (y + height > 282) { pdf.addPage(); y = 18; } };
  const text = (value, x = left, size = 10.5) => { pdf.setFontSize(size); pdf.text(String(value), x, y); };
  const line = (value, advance = 8, size = 10.5) => { space(advance); text(value, left + 2, size); y += advance; };
  const section = (title, needed) => {
    space(needed);
    pdf.setFillColor(240);
    pdf.rect(left, y - 4.5, width, 7, 'F');
    text(title, left + 2, 11);
    y += 10;
  };
  const handwriting = (label, start, advance = 9) => { text(label); pdf.line(start, y + 1, right, y + 1); y += advance; };
  pdf.setFontSize(17);
  pdf.text('【災害時安否状況報告書】', 105, y, { align: 'center' });
  y = 31;
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(report.createdAt));
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  text(`報告日時：${date.year}年 ${date.month}月 ${date.day}日 ${date.hour}時 ${date.minute}分（第　　 回報告）`);
  y += 9;
  handwriting('報告者氏名：', 44);
  handwriting('役職・役割：', 44);
  handwriting('連絡先（電話番号・無線等）：', 76, 10);
  pdf.line(left, y - 6, right, y - 6);
  section('1. 報告対象地域・組織', 22);
  const name = String(report.associationName).replace(/[\u0000-\u001f\u007f]/g, ' ');
  pdf.setFontSize(10.5);
  const names = pdf.splitTextToSize(`地域名・団体名：${name}`, width - 4);
  for (const row of names) line(row, 5.5);
  y += 4;
  section('2. 全体状況（数字を記入）', 37);
  line(`(1) 対象総世帯数：${report.totalHouseholds} 世帯 ／ 対象総人数：${report.totalPeople} 人`);
  line(`(2) 安否確認済数：${report.confirmedHouseholds} 世帯 ／ ${report.confirmedPeople} 人`);
  line(`(3) 安否未確認数：${report.unconfirmedHouseholds} 世帯 ／ ${report.unconfirmedPeople} 人`);
  y += 2;
  section('3. 住民の被害状況（人数を記入）', 45);
  line(`(1) 無事（軽傷含む）：${report.people[1]} 人`);
  line(`(2) 負傷者（要搬送）：${report.people[2]} 人`);
  line(`(3) 行方不明者・生き埋め：${report.people[3]} 人`);
  line(`(4) 死亡者：${report.people[4]} 人`);
  y += 2;
  section('4. 要配慮者（高齢者、障害者、乳幼児等）の状況', 40);
  line('・避難支援が必要な未避難者の有無：［ 有 ・ 無 ］');
  line(`  参考：支援が必要と登録された人 ${report.supportHouseholds} 世帯 ／ ${report.supportPeople} 人`, 7, 9);
  handwriting('・（有の場合）詳細：', 61, 8);
  pdf.line(left + 2, y + 1, right, y + 1);
  y += 9;
  section('5. 建物・ライフラインの被害状況', 36);
  line(`(1) 建物倒壊・損壊：［ 無 ・ 有（　　 棟）］（登録：${report.buildings[2]} 世帯）`, 8, 10);
  line(`(2) 火災の発生：［ 無 ・ 有（　　 箇所・鎮火／延焼中）］`, 7, 10);
  line(`    火災の登録：${report.buildings[3]} 世帯`, 6, 9);
  line(`(3) 断水・停電等：登録 ${report.buildings[4]} 世帯　内容：________________`, 8, 10);
  y += 1;
  section('6. 詳細情報および行政への要請事項（救助要請、物資要請など）', 30);
  line('※負傷者の氏名や、具体的な救助が必要な場所（住所・目印）を記入してください。', 7, 8.5);
  for (let i = 0; i < 2; i++) { pdf.line(left + 2, y + 1, right, y + 1); y += 9; }
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page); pdf.setFontSize(8); pdf.setTextColor(90);
    pdf.text('建物被害の登録単位は世帯です。棟数・箇所数、避難状況は確認して記入してください。', left, 288);
    pdf.text(`${page} / ${pages}`, right, 293, { align: 'right' });
  }
  return Buffer.from(pdf.output('arraybuffer'));
}
