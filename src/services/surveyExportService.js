import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import officeCrypto from 'officecrypto-tool';
import { summarizeAnnouncementResponses } from './officerAnnouncementService.js';

const id = value => String(value?._id || value || '');

// Session-specific secret: passwords never enter URLs, workbooks or logs.
export const surveyExportView = (req, announcement) => {
  if (id(announcement.sender) !== id(req.user?._id) || !['single', 'multiple'].includes(announcement.responseMode)) return {};
  req.session.surveyExportSecret ||= crypto.randomBytes(32).toString('hex');
  const password = crypto.createHmac('sha256', req.session.surveyExportSecret)
    .update(`${id(announcement.association)}:${id(announcement._id)}`).digest('base64url').slice(0, 20);
  return { surveyExportPassword: password, surveyExportUrl: `/associations/${req.params.associationId}/announcements/${announcement._id}/responses.xlsx` };
};

export const createSurveyWorkbook = async ({ announcement, receipts, districtByUser = new Map(), password }) => {
  if (!password) throw new Error('Excelの開封パスワードがありません。');
  const workbook = new ExcelJS.Workbook();
  const summary = summarizeAnnouncementResponses(announcement, receipts);
  const tally = workbook.addWorksheet('回答集計');
  tally.columns = [{ width: 45 }, { width: 18 }, { width: 20 }];
  tally.addRows([
    ['アンケート', announcement.title],
    ['回答方法', announcement.responseMode === 'single' ? '1つ選択' : '複数選択可'],
    ['送信先人数', summary.recipientCount], ['回答済み人数', summary.answeredCount],
    ['割合の基準', '送信先人数（複数選択では合計が100％を超える場合があります）'], [],
    ['選択肢', '人数', '割合'],
    ...summary.choices.map(choice => [choice.label, choice.respondents.length, summary.recipientCount ? choice.respondents.length / summary.recipientCount : 0]),
    ['未回答', summary.unanswered.length, summary.recipientCount ? summary.unanswered.length / summary.recipientCount : 0]
  ]);
  for (let row = 8; row <= tally.rowCount; row++) tally.getCell(row, 3).numFmt = '0.0%';
  const details = workbook.addWorksheet('回答一覧', { views: [{ state: 'frozen', ySplit: 1 }] });
  details.columns = [
    { header: '氏名', width: 25 }, { header: '班', width: 24 }, { header: '回答状況', width: 16 },
    ...announcement.options.map(label => ({ header: label, width: 30 })),
    { header: '回答日時（日本時間）', width: 25 }
  ];
  for (const receipt of receipts) {
    const answered = Boolean(receipt.respondedAt);
    details.addRow([
      receipt.recipient?.displayname || receipt.recipient?.username || '退会済みの住人',
      districtByUser.get(id(receipt.recipient))?.name || '班未設定', answered ? '回答済み' : '未回答',
      ...announcement.options.map((_, index) => answered && (receipt.selectedOptions || []).includes(index) ? '○' : ''),
      answered ? new Date(receipt.respondedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) : ''
    ]);
  }
  details.autoFilter = { from: { row: 1, column: 1 }, to: { row: details.rowCount, column: details.columnCount } };
  for (const [sheet, header] of [[tally, 7], [details, 1]]) {
    sheet.eachRow(row => {
      row.alignment = { vertical: 'top', wrapText: true };
      let lines = 1;
      row.eachCell((cell, column) => {
        const width = sheet.getColumn(column).width || 20;
        lines = Math.max(lines, ...String(cell.value ?? '').split('\n').map(line => Math.ceil([...line].reduce((length, char) => length + (char.charCodeAt(0) > 255 ? 2 : 1), 0) / Math.max(1, width - 2))));
      });
      row.height = Math.max(22, lines * 16 + 6);
    });
    sheet.getRow(header).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245A81' } };
    });
    sheet.getRow(header).height = Math.max(32, sheet.getRow(header).height);
  }
  // File encryption, not worksheet edit protection. Plain data stays in memory.
  const plain = Buffer.from(await workbook.xlsx.writeBuffer());
  try { return officeCrypto.encrypt(plain, { password }); }
  finally { plain.fill(0); }
};
