import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { documentCellText } from '../src/services/documentPreviewService.js';

test('Excel preview handles empty and populated merged cells after xlsx round trip', async () => {
 const source=new ExcelJS.Workbook(),sheet=source.addWorksheet('役員会資料');
 sheet.mergeCells('A1:C1');sheet.mergeCells('A2:C2');sheet.getCell('A2').value='役員会';
 sheet.getCell('A3').value=0;sheet.getCell('B3').value={formula:'1+1',result:2};
 const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(await source.xlsx.writeBuffer());
 const result=loaded.getWorksheet('役員会資料');
 assert.throws(()=>result.getCell('B1').text,TypeError);
 assert.deepEqual([1,2,3].map(r=>[1,2,3].map(c=>documentCellText(result.getCell(r,c)))),[['','',''],['役員会','',''],['0','2','']]);
});
