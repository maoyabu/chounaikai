import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
const SKILL_DIR='/Users/oyabu/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.11814/skills/presentations';
const TMP_DIR='/Users/oyabu/dev/chounaikai/.codex-build/join-guide';
const {resolvePresentationFont}=await import(pathToFileURL(path.join(SKILL_DIR,'container_tools/artifact_tool_utils.mjs')).href);
const font=resolvePresentationFont({fontFamily:'Hiragino Kaku Gothic ProN'});
const p=Presentation.create({slideSize:{width:1280,height:720}}); const s=p.slides.add(); s.background.fill='#F7F7F2';
function shape(geometry,x,y,w,h,fill,line='none'){return s.shapes.add({geometry,position:{left:x,top:y,width:w,height:h},fill,line:{fill:line,width:line==='none'?0:1}})}
function txt(text,x,y,w,h,size,color='#1F352D',bold=false){const a=shape('textbox',x,y,w,h,'none');a.text=text;a.text.style={typeface:font,fontSize:size,bold,color,autoFit:'shrinkText',verticalAlignment:'middle',wrap:true};return a}
function line(x,y,w,color='#CBD6CE',height=2){shape('rect',x,y,w,height,color)}
// Top heading
shape('rect',0,0,1280,12,'#176B4D');
txt('町内会への参加ガイド',54,31,920,50,34,'#163D30',true);
txt('会員登録から参加申請まで  メールを確認しながら進めます',56,83,950,31,18,'#557064');
// Horizontal five-step spine
const centers=[130,360,590,820,1050]; const y=162;
line(130,y+23,920,'#B7C9BE',4);
const steps=[['1','登録画面','ユーザー名・メール\nパスワードを入力'],['2','メール確認','届いた確認メールの\nリンクを開く'],['3','ログイン','登録したメールまたは\nユーザー名でログイン'],['4','参加申請','町内会・地区・班と\n世帯情報を入力'],['5','承認を待つ','班長または町内管理者が\n参加を承認']];
steps.forEach((v,i)=>{shape('ellipse',centers[i]-24,y,48,48,i===4?'#E9A63A':'#176B4D');txt(v[0],centers[i]-24,y+1,48,46,22,'#FFFFFF',true);txt(v[1],centers[i]-90,y+58,180,29,18,'#163D30',true);txt(v[2],centers[i]-100,y+90,200,49,14,'#40594F');});
// Branch heading
line(56,330,1168,'#D5DED8',1);
txt('参加申請画面のイメージ',56,348,390,30,20,'#163D30',true);
txt('登録方法で入力欄が切り替わります',452,350,440,28,15,'#557064');
// Editable wireframe UI, compact two branches
shape('roundRect',56,391,550,199,'#FFFFFF','#D7E0DA');
shape('rect',56,391,550,34,'#E7F1EB');txt('町内会への参加申請',74,395,400,25,16,'#176B4D',true);
txt('地区・班を選択',78,438,185,23,14,'#40594F',true);shape('roundRect',267,437,300,28,'#F8FAF8','#CDD8D0');txt('▼  地区・班を選択',279,440,275,22,13,'#667A70');
txt('登録方法',78,478,160,23,14,'#40594F',true);shape('roundRect',267,477,300,30,'#F8FAF8','#CDD8D0');txt('世帯主として登録する  ▾',279,481,275,22,13,'#667A70');
txt('メールアドレス  必須',78,522,194,22,14,'#40594F',true);shape('roundRect',267,518,300,30,'#FFFFFF','#CDD8D0');txt('name@example.jp',280,522,275,22,13,'#87968F');
txt('一般メンバーは世帯主メールも入力',78,556,440,22,13,'#587064');
// Two route descriptions
shape('roundRect',638,391,282,199,'#EAF3ED');txt('世帯主として申請',660,410,235,29,18,'#176B4D',true);txt('住所・生年月日などを入力\n申請後、承認されると参加完了',660,449,233,58,15,'#314D40');shape('roundRect',660,524,235,42,'#FFFFFF');txt('通知：承認結果が届きます',672,530,215,27,13,'#176B4D',true);
shape('roundRect',938,391,286,199,'#FFF3DF');txt('一般メンバーとして申請',960,410,245,29,17,'#966116',true);txt('世帯主メールを入力\n世帯主確認後、班長または\n町内管理者が承認',960,447,244,70,14,'#57472D');shape('roundRect',960,529,240,42,'#FFFFFF');txt('管理者承認なら世帯主確認も完了',970,533,224,34,12,'#875A13',true);
// Notification strip
shape('rect',0,615,1280,105,'#163D30');
txt('届く通知',54,631,160,28,18,'#FFFFFF',true);
txt('登録時',215,631,85,24,14,'#A9D5BE',true);txt('確認メール（登録したアドレス）',215,660,315,28,15,'#FFFFFF');
txt('申請時',558,631,85,24,14,'#A9D5BE',true);txt('アプリ内通知（班長・町内管理者）',558,660,335,28,15,'#FFFFFF');
txt('承認後',927,631,85,24,14,'#A9D5BE',true);txt('アプリ内通知（申請者）',927,660,290,28,15,'#FFFFFF');
s.speakerNotes.textFrame.setText('システムの登録画面、ルート、通知処理をもとに作成。登録時はメール確認リンクを送信。代表者の参加申請は班長・町内管理者へアプリ内通知。一般メンバーの世帯紐付け依頼は世帯主へアプリ内通知し、世帯主確認後は班長と町内管理者へ通知。町内管理者は世帯主確認待ちも直接承認でき、世帯主の確認も完了扱い。参加承認結果は申請者へアプリ内通知。メール通知は全通知ではなく、確認メール以外は通知設定・運用設定により送信される場合がある。');
const png=await p.export({slide:s,format:'png',scale:1}); await fs.writeFile(path.join(TMP_DIR,'preview.png'),new Uint8Array(await png.arrayBuffer()));
const layout=await s.export({format:'layout'}); await fs.writeFile(path.join(TMP_DIR,'layout.json'),await layout.text());
await (await PresentationFile.exportPptx(p)).save(path.join(TMP_DIR,'candidate.pptx'));
