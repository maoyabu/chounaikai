import fs from 'node:fs/promises';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
import { resolvePresentationFont, finalizePresentation } from '/Users/oyabu/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.11814/skills/presentations/container_tools/artifact_tool_utils.mjs';
const dir='/Users/oyabu/dev/chounaikai', build=dir+'/.codex-build/drive-guide';
const skill='/Users/oyabu/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.11814/skills/presentations';
const font=resolvePresentationFont({fontFamily:'Hiragino Kaku Gothic ProN'});
const p=Presentation.create({slideSize:{width:1600,height:900}}), slide=p.slides.add();slide.background.fill='#F8FAFC';
function text(value,x,y,w,h,size,bold=false,color='#263849'){const t=slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});t.text=value;t.text.style={typeface:font,fontSize:size,bold,color,autoFit:'none',wrap:true};}
text('Google Drive連携の準備手順',64,35,1470,76,48,true,'#174F66');
text('町内会管理者向け　町内会のGoogleアカウントと共有フォルダを用意します',66,118,1470,46,27);
const steps=[
 ['1','共有するフォルダを用意','Google Driveで資料の起点フォルダを決め、URLをコピーします。\n接続に使う町内会アカウントに、このフォルダの編集権限があることを確認します。'],
 ['2','Google Drive APIを有効化','console.cloud.google.com で町内会用プロジェクトを作成します。\n「APIとサービス」のライブラリで「Google Drive API」を検索し、有効にします。'],
 ['3','Googleの同意画面を設定','Google Auth Platformでアプリ名・連絡先・対象ユーザーを設定します。\nデータアクセスに https://www.googleapis.com/auth/drive を追加します。'],
 ['4','OAuthクライアントを作成','「クライアント」で「ウェブアプリケーション」を選びます。管理者設定に表示する\nリダイレクトURIを登録し、クライアントIDとシークレットを控えます。'],
 ['5','管理システムに登録して接続','「町内会管理」の「Google Drive連携設定」にID・シークレット・フォルダURLを保存。\n「Googleアカウントで接続」で許可し、役員メニューの「町内会ドキュメント管理」で確認。']
];
steps.forEach((s,i)=>{const y=189+i*113;text(s[0],66,y,56,68,39,true,'#187A91');text(s[1],141,y,1360,38,29,true);text(s[2],141,y+42,1370,68,24);});
text('テスト時：対象の町内会アカウントをテストユーザーに登録。外部アプリのテスト接続は通常7日で再接続が必要です。',66,771,1470,43,22,false,'#845116');
text('本番時：公開・Google審査等の要否を運用担当者と確認してください。許可はDrive全体ですが、システムの操作は登録フォルダ内です。',66,822,1470,47,22,false,'#845116');
slide.speakerNotes.textFrame.setText(`管理者向け補足\nAPIキーだけでは非公開のExcel・PDFを操作できません。町内会所有のOAuthクライアントを使用します。Googleパスワードは管理システムに登録しません。\n1. Google Driveの既存フォルダを起点として選択できます。町内会専用のアカウントで接続し、個人の私用アカウントを混ぜない運用を推奨します。役員は管理システムの認証・当年度役員権限でアクセスします。各役員のGoogleログインは不要です。\n2. Google Cloudで作成するプロジェクトは町内会ごとに管理してください。Google Drive APIを有効にします。\n3. Google Auth Platformのブランディングにアプリ名、ユーザーサポートメール、開発者連絡先を設定します。対象がGmailの場合は外部を選び、テスト状態では町内会アカウントをテストユーザーに追加します。データアクセスに https://www.googleapis.com/auth/drive を登録します。このスコープは制限付きです。既存フォルダ内の既存資料を操作するために使用しています。Google側の許可はフォルダだけに限定されません。公開時には審査・セキュリティ評価が必要となる場合があり、例外の適用は運用担当者と公式文書で確認してください。\n4. クライアント種別はウェブアプリケーションです。システム設定画面の承認済みリダイレクトURIを完全一致で登録します。IDとシークレットは町内会管理者設定にのみ登録し、資料や共有メールに記載しないでください。\n5. 設定を保存した後、Googleアカウントで接続しアクセスを許可します。接続済みアカウントと共有フォルダを確認します。Excel・PDFで閲覧・アップロード・ダウンロード・ゴミ箱移動を試します。検証用の資料を使用してください。\nPDFは画面内で閲覧、xlsxはシートの文字を簡易表示、xlsはダウンロードして閲覧します。アップロードは1件20MBまで。削除資料はGoogle Driveのゴミ箱から復元できます。\n外部アプリのテスト状態でDriveスコープを要求する更新トークンは通常7日で失効します。本番の公開状態・審査の要否を運用担当者が判断してください。\nシステム運用担当者：PUBLIC_BASE_URLとDRIVE_ENCRYPTION_KEYの設定が必要です。詳細はGOOGLE_DRIVE.mdを参照。\n出典（確認日2026-10-04）\nhttps://developers.google.com/identity/protocols/oauth2/web-server\nhttps://developers.google.com/workspace/drive/api/guides/api-specific-auth\nhttps://developers.google.com/identity/protocols/oauth2\nhttps://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification`);
const candidate=build+'/candidate.pptx';await(await PresentationFile.exportPptx(p)).save(candidate);
const result=await finalizePresentation({workspaceDir:dir,candidatePath:candidate,finalPath:dir+'/.codex-output/google-drive-setup.pptx',pythonExecutable:'/Users/oyabu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',integrityValidatorPath:skill+'/container_tools/inspect_presentation_package_integrity.py',layoutValidatorPath:skill+'/container_tools/inspect_presentation_layout_geometry.py',layoutArgs:['--expected-slide-size-emu','15240000,8572500','--validate-heading-fit'],explicitTotalSlideCount:1,fontPolicy:{basis:'design',families:[font]},verifyArtifactToolImport:true,receiptPath:build+'/validation.json'});console.log(JSON.stringify(result));
const png=await p.export({slide,format:'png',scale:1});await fs.writeFile(build+'/preview.png',new Uint8Array(await png.arrayBuffer()));
await fs.copyFile(dir+'/.codex-output/google-drive-setup.pptx',dir+'/src/public/documents/google-drive-setup.pptx');
