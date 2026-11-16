import ExcelJS from 'exceljs';
import { eventSchedule, reportMonthLabel } from './monthlyReportService.js';

const chunks = (text, length = 120) => String(text || '').split('\n').flatMap(line => {
  const chars = [...line];
  return chars.length ? Array.from({ length: Math.ceil(chars.length / length) }, (_, index) => chars.slice(index * length, (index + 1) * length).join('')) : [''];
});

export function monthlyReportWorkbook(association, report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'まちの伝言板';
  const setup = (name, widths) => {
    const sheet = workbook.addWorksheet(name, { views: [{ showGridLines: false }] });
    sheet.columns = widths.map(width => ({ width }));
    sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    sheet.pageMargins = { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 };
    const title = sheet.addRow([`${association.name} ${reportMonthLabel(report.month)} 月次報告`]);
    title.font = { name: 'Meiryo', size: 16, bold: true, color: { argb: 'FF173A56' } };
    const titleUnits = [...String(title.getCell(1).value)].reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? 2 : 1), 0);
    title.height = Math.max(30, Math.ceil(titleUnits / (widths.reduce((sum, width) => sum + width, 0) * 11 / 16)) * 23 + 6);
    sheet.mergeCells(1, 1, 1, widths.length);
    return sheet;
  };
  const heading = (sheet, values) => {
    const row = sheet.addRow(values);
    row.font = { name: 'Meiryo', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF234B6A' } };
    row.height = 26;
    return row;
  };
  const text = (sheet, value) => {
    for (const part of chunks(value)) {
      const row = sheet.addRow([part]);
      sheet.mergeCells(row.number, 1, row.number, sheet.columns.length);
      row.height = 36;
    }
  };
  const summary = setup('月次報告', [30, 30, 30, 30]);
  heading(summary, ['情報共有事項']);
  text(summary, report.information || '登録されていません。');
  summary.addRow([]);
  heading(summary, ['会計報告', '金額（円）']);
  text(summary, `集計期間：${report.finance.fiscalStartMonth}-01 ～ ${reportMonthLabel(report.month)}末`);
  if (report.finance.enabled) {
    for (const [label, value] of [['累計収入', report.finance.income], ['累計支出', report.finance.expense], ['次月繰越し金', report.finance.carryover]]) {
      const row = summary.addRow([label, value]);
      row.getCell(2).numFmt = '#,##0';
      row.height = 26;
    }
    text(summary, '次月繰越し金＝累計収入－累計支出。期首繰越金は収入として登録済みの金額を含みます。');
  } else text(summary, '会計機能が無効、または会計データとの連携が未設定です。');
  summary.addRow([]);
  heading(summary, ['行事の集計について']);
  text(summary, report.futureNote);
  text(summary, report.eventNote);

  const previous = setup('前月の町内会行事', [27, 34, 16, 65]);
  text(previous, `${reportMonthLabel(report.previousMonth)}の行事と完了報告`);
  heading(previous, ['日程', '行事タイトル', '状況', '完了報告']);
  const eventRows = (sheet, events, department, future = false) => {
    if (!events.length) {
      const row = sheet.addRow(department ? [department, '該当する行事はありません。'] : ['該当する行事はありません。']);
      row.height = 28;
    }
    for (const event of events) {
      const reportParts = chunks(event.implementationReport || '未登録', 140);
      const values = [eventSchedule(event), event.title];
      if (!future) values.push(event.completed ? '完了' : '未完了', reportParts[0]);
      if (department) values.unshift(department);
      const row = sheet.addRow(values);
      row.height = 26;
      if (!future) for (const part of reportParts.slice(1)) {
        const continuation = Array(sheet.columns.length).fill('');
        continuation[continuation.length - 1] = part;
        const extra = sheet.addRow(continuation);
        extra.height = 26;
      }
    }
  };
  eventRows(previous, report.previousEvents);
  previous.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }];
  previous.pageSetup.printTitlesRow = '1:3';

  const departments = setup('部ごとの行事', [23, 27, 34, 16, 65]);
  text(departments, report.futureNote);
  for (const department of report.departmentReports) {
    heading(departments, [department.name]);
    text(departments, `${reportMonthLabel(report.month)}の行事と完了報告`);
    heading(departments, ['担当部', '日程', '行事タイトル', '状況', '完了報告']);
    eventRows(departments, department.currentEvents, department.name);
    text(departments, `${reportMonthLabel(report.nextMonth)}以降の行事`);
    heading(departments, ['担当部', '日程', '行事タイトル']);
    eventRows(departments, department.futureEvents, department.name, true);
    if (department.annualReport) {
      text(departments, '年度の実施報告（参考・月別の報告ではありません）');
      text(departments, department.annualReport);
    }
    departments.addRow([]);
  }
  if (!report.departmentReports.length) text(departments, '部会・該当する行事は登録されていません。');
  for (const sheet of workbook.worksheets) {
    sheet.eachRow(row => {
      row.alignment = { vertical: 'top', wrapText: true };
      if (!row.font?.bold) row.font = { name: 'Meiryo', size: 11, color: { argb: 'FF23313F' } };
      // Excel does not auto-fit wrapped rows on download, so allow for long titles/reports.
      if (!row.getCell(1).isMerged) {
        let lines = 1;
        row.eachCell(cell => {
          const width = Math.max(8, sheet.getColumn(cell.col).width - 2);
          const count = String(cell.value ?? '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].reduce((units, char) => units + (char.charCodeAt(0) > 255 ? 2 : 1), 0) / width)), 0);
          lines = Math.max(lines, count);
        });
        row.height = Math.max(row.height || 24, Math.min(409, lines * 16 + 10));
      }
    });
  }
  return workbook;
}
