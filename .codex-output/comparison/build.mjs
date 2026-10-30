import fs from 'node:fs/promises';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const dir='/Users/oyabu/dev/chounaikai/.codex-output/comparison';
const out='/Users/oyabu/dev/chounaikai/outputs/service-comparison';
await fs.mkdir(out,{recursive:true});
const d=JSON.parse(await fs.readFile(`${dir}/data.json`,'utf8'));
const wb=Workbook.create();
for(const [name,rows] of [['機能比較',d.rows],['料金比較',d.prices]]){
 const s=wb.worksheets.add(name);s.showGridLines=false;
 s.getRange('A2').values=[[`自治会サービス ${name}`]];
 s.getRange('A2').format.font={name:'Arial',size:16,bold:true,color:'#18334B'};
 s.getRange('A3').values=[['確認日：2026年10月30日。他社は公開情報、まちの伝言板は開発中の実装に基づく。']];
 s.getRange(`A5:E${rows.length+5}`).values=[d.headers,...rows];
 const r=s.getRange(`A5:E${rows.length+5}`);r.format.font={name:'Arial',size:11,color:'#203547'};r.format.wrapText=true;r.format.verticalAlignment='center';
 s.getRange(`A5:A${rows.length+5}`).format.columnWidth=24;
 s.getRange(`B5:E${rows.length+5}`).format.columnWidth=40;
 s.getRange(`A6:E${rows.length+5}`).format.rowHeight=name==='機能比較'?66:100;
 for(let i=0;i<rows.length;i++)if(i%2===0)s.getRange(`A${i+6}:E${i+6}`).format.fill='#F0F4F8';
 s.getRange('A5:E5').format={fill:'#18334B',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},rowHeight:32,horizontalAlignment:'center'};
 s.freezePanes.freezeRows(5);
 let n=rows.length+8;
 for(const note of d.notes){s.getRange(`A${n}:E${n}`).merge();s.getRange(`A${n}`).values=[[note]];s.getRange(`A${n}:E${n}`).format={font:{name:'Arial',size:10,color:'#526579'},wrapText:true,rowHeight:30};n++;}
 if(name==='機能比較'){s.getRange(`A${n+1}:E${n+2}`).merge();s.getRange(`A${n+1}`).values=[[d.assessment]];s.getRange(`A${n+1}:E${n+2}`).format={wrapText:true,font:{name:'Arial',size:11},rowHeight:30};n+=4;}
 for(const [label,url]of d.sources){s.getRange(`A${n}`).values=[[label]];s.getRange(`B${n}:E${n}`).merge();s.getRange(`B${n}`).values=[[url]];s.getRange(`A${n}:E${n}`).format={wrapText:true,rowHeight:34,font:{name:'Arial',size:10,color:'#526579'}};n++;}
}
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'機能比較!A5:E8',tableMaxRows:4,tableMaxCols:5,maxChars:1500})).ndjson);
for(const name of ['機能比較','料金比較']){
 const p=await wb.render({sheetName:name,range:name==='機能比較'?'A1:E12':'A1:E8',scale:1,format:'png'});await fs.writeFile(`${dir}/${name}.png`,new Uint8Array(await p.arrayBuffer()));
}
await(await SpreadsheetFile.exportXlsx(wb)).save(`${out}/自治会サービス比較表.xlsx`);
