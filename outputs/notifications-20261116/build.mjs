import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const out = new URL('.', import.meta.url).pathname;
const wb = Workbook.create();
const sh = wb.worksheets.add('役割別通知一覧');
const guide = wb.worksheets.add('凡例・配信条件');
const rows = [];
const add = (role, sender, content, source, options = {}) => rows.push({
  role, sender, content, source, push: '初期ON', mail: '初期OFF', ios: '初期ON', condition: '', ...options
});
const commonRoles = ['町内会管理者', '役員', '班長', '世帯主', '一般会員'];
for (const role of commonRoles) {
  add(role, '警戒レベル登録・更新者', '警戒レベルの新規登録・上昇／世帯の安否登録依頼', 'alertLevelNotificationService.js / dispatchAlertLevelNotifications', {mail:'初期ON', condition:'当該町内会の有効会員全員。新規登録・上昇時のみ。登録者本人も対象。'});
  add(role, '緊急・危険情報の投稿者', '緊急・危険情報の新規投稿', 'dangerReportNotificationService.js / queueDangerReportNotifications', {mail:'初期ON', condition:'当該町内会の有効会員全員。投稿者本人も対象。'});
  add(role, 'いいところの投稿者', 'わがまちのいいところの新規投稿', 'goodPlaceService.js / queueGoodPlaceNotifications', {mail:'初期ON', condition:'当該町内会の有効会員全員。投稿者本人も対象。'});
  add(role, '町内会管理者・役員', '住民向け連絡の新規配信・更新', 'officerAnnouncementService.js / publishAnnouncement, updateAnnouncement', {condition:'有効会員のうち指定された宛先。全員・班長宛、地区・班の絞り込みに従う。'});
  add(role, '町内会管理者・役員／担当班長', '未確認の住民向け連絡の再通知', 'officerAnnouncementService.js / remindAnnouncement', {condition:'元の配信先のうち未確認者のみ。班長の再通知は自班内。'});
  add(role, '町内会管理者・役員', '町内会行事の登録・変更・削除', 'notificationRecipients.js / notifyEvent; associationEvents.js', {condition:'有効会員全員。非公開の下書きは対象外。公開済み行事の変更・削除も対象。'});
  add(role, '班長／同じ班の会員', '班内の連絡・会話／未確認連絡の再通知', 'officerAnnouncementService.js / prepareAnnouncement, remindAnnouncement; associations.js / member-chat', {ios:'対象外', condition:'同じ班の指定宛先。全員宛は班長のみ送信可能。会話の返信は送信者以外の既存宛先。'});
}
for (const role of ['町内会管理者', '役員']) {
  add(role, '町内会管理者・役員', '役員間の連絡・会話／未確認連絡の再通知', 'officerAnnouncementService.js / prepareAnnouncement, remindAnnouncement; associations.js / officer-chat', {ios:'対象外', condition:'現年度の役員・管理者から指定された宛先。全員・部会・個人・役員グループ。会話返信は送信者以外。'});
  add(role, '会員（質問者）', '質問・ご意見の新規投稿／再質問', 'questionBoxService.js / notifyResponsible', {condition:'有効会員である町内会管理者と現年度役員。'});
  add(role, '会員（借用申込者）', '設備・備品の貸出申込み／申込み取消', 'equipmentService.js / requestEquipmentLoan, decideEquipmentLoan; notificationRecipients.js', {condition:'有効会員である管理者と現年度役員。申込取消の通知は取消操作者を除外。取消通知のiOS優先度は通常。'});
  add(role, 'システム（定期実行）', '設備・備品の棚卸し案内', 'equipmentService.js / runEquipmentReminders, equipmentOfficerNotice', {condition:'有効会員である管理者と現年度役員。棚卸し設定の対象期間に配信。'});
  add(role, 'システム（定期実行）', '設備・備品の期限アラート', 'equipmentService.js / runEquipmentReminders, equipmentOfficerNotice', {condition:'有効会員である管理者と現年度役員。在庫あり・期限が設定期間内の備品。'});
}
add('町内会管理者', '参加申請者／世帯主', '町内会への参加申請の受付', 'householdParticipationService.js / notifyDistrictLeaders', {condition:'有効会員である管理者。担当班長への通知と併せて作成。'});
add('町内会管理者', '担当班長', '参加申請の班長承認／最終承認依頼', 'householdParticipationService.js / decideHouseholdParticipation', {condition:'管理者へ最終承認を依頼。'});
add('町内会管理者', '班長', '地区・班の統一と会員紐付けの確認依頼', 'locationLinks.js / handleLocationLink', {condition:'地区・班に不一致があり、班長が管理者へ確認を依頼した場合。'});
add('町内会管理者', '会員（グループ作成申請者）', 'グループ作成申請の受付', 'associationGroups.js / notifyResponsible', {condition:'有効会員である町内会管理者。'});
add('町内会管理者', '部会の実施報告登録者', '部会の実施報告の更新', 'questionBox.js / department_plan', {condition:'有効会員である町内会管理者。'});
add('町内会管理者', 'システム管理者', 'システム管理者からの返信・連絡', 'systemContacts.js / notify', {condition:'当該町内会の有効会員である管理者。操作した本人を除外。'});
add('役員', '町内会管理者', '担当部会の事業計画・目標の更新', 'notificationRecipients.js / notifyDepartmentPlan; management.js', {condition:'計画の年度・部会に一致する、解任されていない役員。有効会員に限定。'});
add('班長', '参加申請者／世帯主', '担当班の町内会参加申請の受付', 'householdParticipationService.js / notifyDistrictLeaders', {condition:'当該班の現年度班長で、有効会員の代表者。emailRequired指定があってもメール初期OFFが優先。'});
add('班長', '世帯主／世帯主確認済みの家族', '班・世帯からの退会申請の受付', 'withdrawalService.js / notifyLeaders', {condition:'申請対象の班の現年度班長。世帯主申請は直接、家族申請は世帯主承認後。'});
add('班長', '町内会管理者', '地区・班の統一・紐付け確認依頼の承認／却下', 'locationLinks.js / location_link_decided', {condition:'確認依頼を提出した班長本人。'});
add('班長（任命対象者）', '町内会管理者', '年度の班長への指定／班長の会員紐付け完了', 'management.js / district_leader_assigned; locationLinks.js', {condition:'指定・紐付けされた会員本人。役割変更直後はiOSの所属・役割判定に従う。'});
add('役員等（紐付け対象者）', '町内会管理者', '地区・班を確認した会員紐付けの完了', 'locationLinks.js / officer_assigned', {condition:'管理者が紐付けを実施した対象会員。一般の役員任命全件の通知を意味しない。'});
add('世帯主', '家族（参加申請者）', '世帯への紐付け申請の受付', 'householdParticipationService.js / household_link_requested', {ios:'役割条件あり', condition:'当該世帯主。iOSでは管理者・役員・班長の兼任者のみ（対応待ち通知の制限）。'});
add('世帯主', '家族（退会申請者）', '家族からの退会申請の確認依頼', 'withdrawalService.js / requestWithdrawal', {ios:'役割条件あり', condition:'当該世帯主。iOSでは管理者・役員・班長の兼任者のみ（対応待ち通知の制限）。'});
for (const role of ['グループ管理者', 'グループ会員']) {
  add(role, '同じグループの会員', 'グループ内の連絡・会話／未確認連絡の再通知', 'officerAnnouncementService.js / prepareAnnouncement, remindAnnouncement; associations.js / member-chat', {ios:'対象外', condition:'有効な町内会会員かつ有効なグループ会員。全員宛・個人宛に従う。返信は送信者以外の既存宛先。再通知の操作権限は別判定。'});
  add(role, 'グループ管理者', 'グループ行事の登録・変更・削除', 'notificationRecipients.js / notifyEvent; associationGroups.js', {condition:'町内会と当該グループの両方で有効な会員。非公開の下書きは対象外。'});
}
add('グループ管理者', '会員（参加・退会申請者）', 'グループへの参加申請／退会申請', 'associationGroups.js / group_request', {ios:'役割条件あり', condition:'当該グループの有効な管理者。iOSは町内会管理者・役員・班長の兼任者のみ（対応待ち通知の制限）。'});
add('申請者・対象者', '世帯主', '世帯への紐付け申請の不承認', 'householdParticipationService.js / household_head decision', {ios:'所属条件あり', condition:'紐付け申請者本人。iOSは配信時に当該町内会がアプリの所属一覧に存在する場合のみ。'});
add('申請者・対象者', '町内会管理者', '町内会・班への参加申請の承認／拒否', 'householdParticipationService.js / join_application_approved, join_application_rejected', {ios:'所属条件あり', condition:'参加申請者本人。未参加・拒否後に所属がない場合、iOS通知は配信対象外。'});
add('申請者・対象者', '役員（回答者）', '質問・ご意見箱への回答', 'questionBoxService.js / question_answered', {condition:'質問の投稿者本人。住民側からの再質問は管理者・役員宛の別通知。'});
add('申請者・対象者', '世帯主／担当班長', '退会申請の不承認', 'withdrawalService.js / notify, confirmWithdrawal, decideWithdrawal', {condition:'世帯主による却下は申請者。班長による却下は退会対象会員。メール初期OFFが優先。'});
add('申請者・対象者', '担当班長', '町内会の退会完了', 'withdrawalService.js / decideWithdrawal', {ios:'所属条件あり', condition:'退会対象会員（世帯退会は対象全員）。退会後に所属一覧から除外される場合、iOSは対象外。メール初期OFFが優先。'});
add('申請者・対象者', '世帯主／班長', '世帯からの削除／世帯の班一覧からの削除', 'householdMemberRemovalService.js; leaderHouseholdDeletionService.js', {ios:'所属条件あり', condition:'削除された対象会員。所属終了後にアプリの所属一覧に残らない場合、iOSは対象外。'});
add('申請者・対象者', 'グループ管理者', 'グループ参加・退会申請の承認／却下', 'associationGroups.js; notifications.js / group_request', {condition:'各申請の申請者・対象会員本人。'});
add('申請者・対象者', '町内会管理者', 'グループ作成申請の承認／却下', 'associationGroups.js; notifications.js / group_request', {condition:'グループ作成申請者本人。'});
add('申請者・対象者', '設備・備品の承認担当者', '貸出申込みの承認・却下・取消／返却済み', 'equipmentService.js / decideEquipmentLoan', {condition:'借用者本人。申込者の取消でも借用者宛の結果通知を作成。'});
add('システム管理者', '町内会管理者', 'システム管理者への連絡・返信', 'systemContacts.js / notify', {ios:'所属条件あり', condition:'退会していない全システム管理者（操作者本人を除外）。iOSは対象町内会がアプリの所属一覧にある場合のみ。'});
add('新規登録者', 'システム', 'メールアドレスの確認／登録完了への案内', 'emailVerificationService.js / sendVerificationEmail', {push:'対象外', mail:'直接送信', ios:'対象外', condition:'登録したメールアドレス宛。有効期限24時間。町内会別の通知設定とは別経路。'});
add('パスワード再設定者', 'システム', 'パスワード再設定の案内', 'emailVerificationService.js / sendPasswordResetEmail', {push:'対象外', mail:'直接送信', ios:'対象外', condition:'再設定対象のメールアドレス宛。有効期限1時間。町内会別の通知設定とは別経路。'});
add('世帯への招待対象者', '世帯の招待者', '世帯への招待／会員登録・ログインへの案内', 'emailVerificationService.js / sendHouseholdInvitationEmail', {push:'対象外', mail:'直接送信', ios:'対象外', condition:'招待先メールアドレス宛。有効期限7日間。町内会別の通知設定とは別経路。'});

const order = [...commonRoles, 'グループ管理者','グループ会員','班長（任命対象者）','役員等（紐付け対象者）','申請者・対象者','システム管理者','新規登録者','パスワード再設定者','世帯への招待対象者'];
rows.sort((a,b) => order.indexOf(a.role)-order.indexOf(b.role));
const headers = ['役割（受信者）','送信者','通知内容','WebPush','メール通知','iOSの通知','受信条件・補足'];
sh.getRange('A2').values = [['役割別に受信する通知']];
sh.getRange('A3').values = [['2026年11月16日時点のローカル実装。配信欄は初期設定。保存済みの町内会設定・実配信状況は未照会。']];
sh.getRange('A4').values = [['役割は兼任可能。グループ役割の会員は、所属する町内会の会員として受け取る通知も併せて参照。']];
sh.getRange('A6:G6').values = [headers];
sh.getRange(`A7:G${rows.length+6}`).values = rows.map(r=>[r.role,r.sender,r.content,r.push,r.mail,r.ios,r.condition]);
sh.tables.add(`A6:G${rows.length+6}`, true, 'NotificationsByRole');
sh.freezePanes.freezeRows(6);
sh.freezePanes.freezeColumns(1);
for(let i=0;i<rows.length;i++) {
  wb.notes.add({id:`source-${i}`,target:{cell:{sheetName:sh.name,sheetId:sh.sheetId,address:`C${i+7}`}},authorId:'',createdAt:'',body:{plainText:`確認元：${rows[i].source}。配信共通：notificationSettings.js / defaultNotificationChannel、notificationService.js / deliverNotification、apnsService.js / sendNativePush、notificationInboxService.js / notificationPriority。`}});
}

const notes = [
 ['基準','2026年11月16日時点のローカルソースコードを整理。デプロイ状況・DB内の保存済み設定・配信実績は確認していません。'],
 ['初期ON','町内会の通知カテゴリ設定が未保存の場合に有効。通知先の端末登録・許可・サーバー設定が揃ったときに配信対象になります。'],
 ['初期OFF','初期設定は無効。町内会管理者が当該カテゴリのメールをONにすると配信対象になります。'],
 ['対象外','その経路では送信しない実装です。端末や通知設定をONにしても送信されません。'],
 ['役割条件あり','iOSの「対応待ち」通知は町内会管理者・役員・班長のいずれかの役割が必要。世帯主のみ・グループ管理者のみの場合は配信されません。'],
 ['所属条件あり','iOSは配信時のアプリ所属一覧に当該町内会があることが必要。参加前・退会後・システム管理者のみの会員では配信されない場合があります。'],
 ['直接送信','確認・再設定・招待メールは通知キューと別の送信経路。町内会カテゴリ設定を参照しません。'],
 ['WebPushの初期設定','すべての通知カテゴリで初期ON。ブラウザーで通知を許可し、有効な購読が登録されていること、VAPID設定が必要です。'],
 ['メールの初期設定','警戒レベル・緊急／危険情報・わがまちのいいところは初期ON。それ以外は初期OFF。メールアドレスとSMTP設定が必要です。'],
 ['メールの形式','HTMLを基本に、テキスト本文も併記。通知メールの件名は【まちの伝言板】［町内会名］＋確認内容。'],
 ['iOSの設定','WebPushと同じpushスイッチを使用し、独立したカテゴリ別スイッチはありません。APNs設定、端末通知許可、期限内の端末登録、有効なログインセッションが必要です。'],
 ['iOSで除外される通知','役員間・班内・グループ内の連絡、会話、各再通知（officer_network / district_message / group_messageと各_reminder）はAPNs対象外です。'],
 ['iOSの対応待ち判定','質問・再質問、地区・班確認依頼、参加申請受付、世帯紐付け依頼、退会確認依頼、貸出申込み、グループ申請受付などが対象。貸出申込取消・結果は通常通知扱いです。'],
 ['emailRequiredの扱い','参加申請や退会結果でemailRequiredが指定されても、現実装ではカテゴリのemail=falseが優先されます。必ず送信されるメールとは扱っていません。'],
 ['役割の重なり','役員・班長・世帯主・グループ役割は兼任可能です。兼任者は該当する各行を参照してください。同じ通知を表上で複数の役割に掲載しています。'],
 ['一般会員の意味','当該町内会に有効な参加状態である会員。世帯内の家族会員を含みます。未参加の申請者は「申請者・対象者」行を参照してください。'],
 ['町内会管理者の意味','有効なassociation.manage権限のある役割の担当者。システム管理者とは別です。多くの受信先抽出では有効な町内会会員であることも必要です。'],
 ['現年度の役員・班長','受信先抽出は実装の年度判定に従います。部会事業計画は計画年度・部会を使用します。'],
 ['再通知','未確認の受信者へ操作により再通知する実装です。自動で一定時間ごとに送られる意味ではありません。'],
 ['行事通知','非公開下書きは配信しません。既に公開された行事の非公開化・削除では元の公開状態に応じて通知されます。'],
 ['アプリ内お知らせ','本表の3経路がOFFでも、通知レコード自体はアプリ内のお知らせとして作成されます。確認・再設定・招待メールは別経路です。'],
 ['確認元','各通知内容セルにExcelのメモとして作成箇所と共通配信ロジックを記載しています。'],
];
guide.getRange('A2').values = [['凡例・配信条件']];
guide.getRange('A4:B4').values = [['項目','内容']];
guide.getRange(`A5:B${notes.length+4}`).values = notes;
for (const sheet of [sh,guide]) {
  sheet.showGridLines=false;
  sheet.tabColor='#234B6A';
  sheet.getUsedRange().format.font={name:'Arial',size:11,color:'#23313F'};
  sheet.getUsedRange().format.verticalAlignment='center';
  sheet.getRange('A2').format.font={name:'Arial',size:16,bold:true,color:'#173A56'};
}
const n=rows.length+6;
for(const [col,width] of Object.entries({A:23,B:27,C:55,D:15,E:16,F:19,G:65})) sh.getRange(`${col}6:${col}${n}`).format.columnWidth=width;
sh.getRange(`A7:G${n}`).format.wrapText=true;
sh.getRange(`A7:G${n}`).format.rowHeight=70;
sh.getRange('A6:G6').format={fill:'#234B6A',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},rowHeight:30,horizontalAlignment:'center'};
sh.getRange(`D7:F${n}`).format.horizontalAlignment='center';
for(let i=0;i<rows.length;i++) {
  const r=i+7;
  if(i===0 || rows[i-1].role!==rows[i].role) sh.getRange(`A${r}:G${r}`).format.borders={top:{style:'medium',color:'#A8BBC9'}};
}
sh.getRange(`D7:F${n}`).conditionalFormats.add('containsText',{text:'対象外',format:{font:{color:'#777777'}}});
sh.getRange(`D7:F${n}`).conditionalFormats.add('containsText',{text:'条件あり',format:{fill:'#FFF1D6',font:{color:'#805A16'}}});
guide.getRange(`A4:A${notes.length+4}`).format.columnWidth=29;
guide.getRange(`B4:B${notes.length+4}`).format.columnWidth=110;
guide.getRange(`A5:B${notes.length+4}`).format.wrapText=true;
guide.getRange(`A5:B${notes.length+4}`).format.rowHeight=59;
guide.getRange('A4:B4').format={fill:'#234B6A',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},rowHeight:28,horizontalAlignment:'center'};
guide.freezePanes.freezeRows(4);
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'役割別通知一覧!A6:G10',include:'values',tableMaxRows:5,tableMaxCols:7,maxChars:2500})).ndjson);
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',options:{useRegex:true,maxResults:10},maxChars:500})).ndjson);
for(const [sheetName,range,file] of [
 ['役割別通知一覧','A2:F12','preview-main.png'],
 ['役割別通知一覧','F6:G12','preview-conditions.png'],
 ['凡例・配信条件','A2:B14','preview-guide.png']
]) {
  const image=await wb.render({sheetName,range,scale:1.4,format:'png'});
  await fs.writeFile(out+file,new Uint8Array(await image.arrayBuffer()));
}
const file=await SpreadsheetFile.exportXlsx(wb);
await file.save(out+'役割別通知一覧_20261116.xlsx');
console.log(JSON.stringify({rows:rows.length,path:out+'役割別通知一覧_20261116.xlsx'}));
