import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load('.codex-output/monthly-report-preview.xlsx'));
for (const [sheetName,range,name] of [['月次報告','A1:D15','summary'],['前月の町内会行事','A1:D4','previous'],['部ごとの行事','A1:E10','departments']]) {
  const image = await workbook.render({ sheetName,range,scale:1.5,format:'png' });
  await fs.writeFile(`.codex-output/monthly-report-excel-${name}.png`,new Uint8Array(await image.arrayBuffer()));
}
console.log((await workbook.inspect({kind:'table',range:'月次報告!A7:B11',include:'values',tableMaxRows:5,tableMaxCols:2,maxChars:800})).ndjson);
