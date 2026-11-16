import fs from 'node:fs/promises';
import { chromium } from '/Users/oyabu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { renderView } from '../test-support/renderView.js';
import { buildMonthlyReport, reportMonthLabel, eventSchedule } from '../src/services/monthlyReportService.js';
import { monthlyReportWorkbook } from '../src/services/monthlyReportExcel.js';
const association = { _id:'preview',name:'みどり町内会',group:'group',optionalFeatures:{finance:true},financeFiscalStartMonth:4 };
const report = buildMonthlyReport({association,month:'2026-11',information:'11月の役員会で共有する事項です。\n・防災訓練の振り返り\n・年末の防犯パトロールについて',departments:[{_id:'d',name:'防災部'},{_id:'c',name:'文化部'}],entries:[{date:'2026-04-01',cf:'収入',amount:1200000},{date:'2026-11-01',cf:'支出',amount:450000}],events:[{_id:'a',title:'秋の防災訓練',startDate:'2026-10-25',endDate:'2026-10-25',startTime:'09:00',endTime:'12:00',category:'防災部',completed:true,implementationReport:'50名が参加。避難場所と備蓄品の確認を行いました。\n今後は班ごとの連絡体制を強化します。'},{_id:'b',title:'備蓄品点検',startDate:'2026-11-10',endDate:'2026-11-10',startTime:'10:00',endTime:'11:00',category:'防災部',completed:true,implementationReport:'使用期限と数量を確認しました。'},{_id:'c',title:'年末の防犯パトロール',startDate:'2026-12-20',endDate:'2026-12-20',startTime:'19:00',endTime:'20:00',category:'防災部'}]});
let html = await renderView('src/views/monthly-report.ejs',{title:'月次報告',association,report,reportMonthLabel,eventSchedule,showOutput:true,csrfToken:'preview',currentPath:''});
html=html.replaceAll('href="/assets/','href="file:///Users/oyabu/dev/chounaikai/src/public/').replaceAll('src="/assets/','src="file:///Users/oyabu/dev/chounaikai/src/public/');
await fs.writeFile('.codex-output/monthly-report-preview.html',html);
await monthlyReportWorkbook(association,report).xlsx.writeFile('.codex-output/monthly-report-preview.xlsx');
if (process.argv.includes('--excel-only')) process.exit(0);
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  for (const [name,width] of [['desktop',1440],['mobile',390]]) {
    const page=await browser.newPage({viewport:{width,height:1000}});
    await page.goto('file:///Users/oyabu/dev/chounaikai/.codex-output/monthly-report-preview.html');
    await page.screenshot({path:`.codex-output/monthly-report-${name}.png`,fullPage:true});
    console.log(JSON.stringify({name,width,bodyWidth:await page.evaluate(()=>document.documentElement.scrollWidth),tables:await page.locator('.monthly-report-table').count()}));
    await page.close();
  }
} finally {await browser.close();}
