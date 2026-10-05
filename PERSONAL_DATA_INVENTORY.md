# 個人情報の保存先・検索機能一覧

調査日: 2026-10-05。現行リポジトリのモデル、ルート、サービス、画面テンプレートを静的に確認した結果。
本番DBの内容・Atlasのバックアップ設定・他サービスのコードは確認していない。実データの件数や旧形式の残存は未確認。
この文書の作成段階では暗号化、検索仕様、データ移行、権限の変更を行っていない。

追記: 同日の後続実装で、町内会専用の住所・電話番号の暗号化と住所検索の除外を追加した。
以下の一覧は調査時点の状態を記録したもので、実装後の設定・移行・検索変更は
[住所・電話番号の暗号化](PERSONAL_DATA_ENCRYPTION.md) を参照。実際の既存DBの移行は未実施。

## 今回の要件

- 一般住人向けの、他の住人を検索する機能は不要。
- 役員等が権限のある範囲で行う氏名の部分一致検索・絞り込みは維持する。
- 個人の住所・電話番号の検索は不要。住所・電話番号を先行し、氏名・メールは後続で設計する。
- 公開情報としての町内会所在地・問い合わせ先と、非公開の個人情報を区別する。
- GitHubへのプッシュ、Herokuへのデプロイ、本番設定の変更は利用者が行う。

## 調査結果の要点

1. 個人の住所・電話番号は `households`、`annual_officers`、`annual_leader_assignments` に独立して保存される。世帯情報だけを暗号化しても年度台帳の平文は残る。
2. 役員・班長台帳には `mobilePhone` もある。住所は郵便番号・番地・建物名などの各項目を含めて対象にする。
3. 名簿の部分一致検索は、DBで文字列検索せず、許可された町内会のデータを画面へ取得した後にブラウザー内で行っている。入力で行を隠しても、取得済み情報はHTMLやJavaScriptに残る。
4. 役員一覧・班長一覧・年度設定の候補検索には現在、住所が含まれる。先行暗号化時に検索用属性と案内文から住所を除く候補となる。
5. 町内会の公開所在地はDBの正規表現検索に使われる。個人の住所と同じ扱いで暗号化すると、町内会探しに影響する。
6. 氏名・メールは複数箇所にコピーされる。メールは再設定、登録重複確認、世帯参加・招待の照合にも使われる。
7. 共通 `users` / `groups` は他サービスと共有する。氏名・メールの暗号化は本アプリだけの変更で完結しない。

## 保存先: 定型項目

「直接保存」は文字列等を当該コレクションに保存するもの。「参照」はIDを保存し表示時に関連データを読むもの。
以下の定型項目に、住所・電話・氏名・メール向けの項目別暗号化は現行コード上確認されない。

| 保存先（コレクション） | 直接保存する項目 | 主な登録・更新／利用 | 暗号化時の扱い | 根拠 |
|---|---|---|---|---|
| 共通アカウント `users` | `displayname`（表示名）、`username`（ログインID）、`email`。別途 `birth_date`、`sex`、`blood`、`rh`、`avatar` 等 | 本登録、プロフィール編集、管理者による住人編集。各種名簿・通知・再設定 | 氏名・メールは後続。共有サービスとの互換性が必要。ログインIDも本人特定につながる | [モデル](src/models/user.js)、[登録](src/services/userService.js)、[プロフィール](src/routes/web.js)、[住人管理](src/routes/management.js)、[共有構成](README.md) |
| 仮登録 `pending_user_registrations` | `displayname`、`username`、`email`、`householdHeadEmail`（スキーマ上）。他にパスワードハッシュ等 | 確認前の登録、再送、メール確認時の本登録。`expiresAt` にTTL索引 | 後続。`email` は一意索引・完全一致検索あり。`householdHeadEmail` は保存経路ごとに値の有無を確認 | [モデル](src/models/pendingUserRegistration.js)、[登録](src/services/userService.js)、[確認](src/services/emailVerificationService.js) |
| 世帯 `households` | `displayName`（氏名由来の世帯名を含む）、`address.postalCode`、`address.street`、`address.building`、`phone`、`email` | 入会時の世帯登録、プロフィール、住人編集、班長会費台帳の世帯追加・修正 | **住所3項目・電話を先行候補**。世帯名・メールは後続。世帯名はDB並び替えに使用 | [モデル](src/models/organization.js)、[世帯処理](src/routes/households.js)、[住人管理](src/routes/management.js) |
| 世帯員 `household_members` | `name`、`nameKana`、`email`。他に生年月日、性別、LINEアカウント、続柄 | 家族登録・更新、招待受諾、参加承認。世帯・申請画面 | 後続。住所・電話は持たず世帯を参照。アカウント未登録の家族も対象 | [モデル](src/models/organization.js)、[世帯処理](src/routes/households.js)、[参加処理](src/services/householdParticipationService.js) |
| 入会申請 `join_applications` | `residentProfile.name`、`nameKana`、`email`。他に生年月日等、自由記述 `applicantNote`、`rejectionReason`。`addressEvidence` はスキーマ上あり | 申請時にプロフィールをコピー、承認で世帯員へ転記。住所・電話は世帯参照 | 後続。`addressEvidence` は本リポジトリでモデル以外の使用を確認できず、既存値の有無は未確認 | [モデル](src/models/workflow.js)、[参加処理](src/services/householdParticipationService.js) |
| 世帯招待 `association_invitations` | `email` | 招待作成・送信・受諾。トークン、状態、期限、メールを照合 | 後続。メールは完全一致条件・本人照合に使用 | [モデル](src/models/workflow.js)、[招待ルート](src/routes/householdInvitations.js)、[参加処理](src/services/householdParticipationService.js) |
| 登録状態 `resident_registrations` | `householdHeadEmail` | 世帯主メールによる参加依頼等の状態保持 | 後続。氏名・住所・電話はこのモデルにない | [モデル](src/models/residentRegistration.js)、[参加処理](src/services/householdParticipationService.js) |
| 年度役員 `annual_officers` | `name`、`nameKana`、`address`、`phone`、`mobilePhone`。メールは `users` 参照 | 手入力登録、編集、会員との紐付け、次年度コピー、役員一覧 | **住所・電話2項目を先行候補**。台帳に住所がない場合は関連世帯の住所を表示 | [モデル](src/models/annualOfficer.js)、[管理処理](src/routes/management.js)、[画面](src/views/association-officers.ejs) |
| 年度班長 `annual_leader_assignments` | `name`、`nameKana`、`address`、`phone`、`mobilePhone`。メールは `users` 参照 | 手入力登録、編集、会員・世帯紐付け、次年度コピー、班長一覧 | **住所・電話2項目を先行候補**。台帳／関連世帯双方の住所を扱う | [モデル](src/models/annualLeaderAssignment.js)、[管理処理](src/routes/management.js)、[画面](src/views/association-leaders.ejs) |
| 町内会基本情報 `neighborhood_associations` | `address.postalCode/prefecture/city/street`、`contact.name/email/phone` | 町内会設立申請・基本設定、公開ページ・町内会検索 | **公開用として別分類**。個人宅や個人の連絡先の場合もあり、公開範囲を決めてから対象化 | [モデル](src/models/neighborhoodAssociation.js)、[公開・申請](src/routes/web.js)、[設定](src/routes/management.js)、[公開ページ組立](src/services/associationPublicPageService.js) |
| 閲覧監査 `chounaikai_privacy_access_logs` | `actorName`（表示名／ログインIDのコピー）、`ip` | 閲覧・ダウンロード・出力時に追記 | 氏名対応時に検討。対象者の住所・電話・メールや本文はコピーせず、対象IDを記録 | [モデル](src/models/privacyAccessLog.js)、[記録](src/services/privacyAuditService.js) |
| 更新監査 `association_audit_logs` | `before` / `after`（任意構造）、`ip`。手入力役員・班長作成で `after.name` | 各種変更・承認・削除の記録 | 氏名対応時にコピーを扱う。住所・電話の直接コピーは確認範囲の書込コードでは見つからないが、旧履歴は未確認 | [モデル](src/models/auditLog.js)、[書込例](src/routes/management.js)、[削除記録](src/services/leaderHouseholdDeletionService.js) |
| 共通グループ `groups` | `invitedUsers: [String]`。個人の氏名等はユーザー参照 | 他サービスと共有する互換モデル | `invitedUsers` の値の意味・他サービスの書込は未確認。本アプリの定型メール保存先と断定しない | [モデル](src/models/group.js)、[共有構成](README.md) |

## 保存先: 間接的なコピー・自由記述・外部保存

これらは住所・電話専用の項目ではない。定型項目の暗号化だけで、入力・送信済みの個人情報まで保護されるとは限らない。

| 保存先・経路 | 個人情報が残る可能性／確認できた内容 | 次段階での扱い | 根拠 |
|---|---|---|---|
| `notifications.title/body` | 参加申請通知などで世帯名・申請者名が組み込まれる。メール・プッシュにも配信 | 氏名コピーとして後続対象。本文への住所・電話入力も考慮 | [通知モデル](src/models/notification.js)、[参加通知](src/services/householdParticipationService.js)、[配信](src/services/notificationService.js) |
| `chounaikai_sessions` | ユーザーID・認証状態のほか、`notice` 等に世帯名が入る経路あり。住所・電話の定型保存は確認できない | 氏名対応時に内容と保持期間を確認 | [セッション設定](src/app.js)、[世帯削除の案内](src/routes/households.js) |
| 質問・連絡の本文 | `association_question_threads`、`system_contacts`、`officer_announcements`、`announcements` 等の自由記述に氏名・住所・電話・メールを入力できる | 入力方針・保持期間・本文暗号化を別途検討 | [質問モデル](src/models/questionThread.js)、[問い合わせモデル](src/models/systemContact.js)、[連絡モデル](src/models/officerAnnouncement.js)、[お知らせモデル](src/models/announcement.js) |
| その他の自由記述 | 入会・退会・グループ申請理由、会計の内容・メモ、予算詳細、備品のメモ・設置場所、行事本文・実施報告等 | スキーマから実際の個人情報混入は判定できない。定型項目と分けて扱う | [申請](src/models/workflow.js)、[グループ](src/models/associationGroup.js)、[会計](src/models/finance.js)、[予算](src/models/financeBudget.js)、[備品](src/models/equipment.js)、[行事](src/models/associationEvent.js) |
| Google Drive・Cloudinary／添付メタデータ | 文書・連絡・問い合わせ・画像・添付ファイル本体、ファイル名、写真内の個人情報 | MongoDBの項目暗号化とは別の保存先。共有権限・配信・削除を確認 | [Drive](GOOGLE_DRIVE.md)、[添付サービス](src/services/messageAttachmentService.js)、[プロフィール画像](src/services/profileImageService.js) |
| メール送信 | SMTP宛先にメール、招待本文に招待者名・家族名等 | DBで暗号化しても送信時には復号が必要。SMTP事業者・受信者側の保存は別管理 | [メール送信](src/services/emailVerificationService.js)、[通知](src/services/notificationService.js) |
| HTML・JavaScript・画面／印刷 | 名簿、編集フォーム、検索用 `data-search`、住人編集用JSON等に取得済み情報が載る | 復号は権限確認後。必要な範囲のみ取得し、住所を検索用属性へ複製しない。画面を隠すだけではアクセス制御にならない | [住人名簿](src/views/association-members.ejs)、[年度設定](src/views/association-annual-settings.ejs) |
| ダウンロード・出力 | 会計・備品Excel、文書・添付ダウンロードあり。専用の住人名簿CSV／Excel出力ルートは確認できない | 出力済みファイルはDB暗号化の対象外。自由記述の混入にも注意 | [会計出力](src/routes/associationFinance.js)、[備品出力](src/routes/equipment.js)、[文書](src/routes/documents.js)、[添付](src/routes/messageAttachments.js) |
| バックアップ・旧ダンプ・運用ログ | 設定・実際の内容は未確認。既存の平文バックアップは移行後も自動では暗号化されない | 移行前のバックアップ保護と保存期限、鍵の復旧手順を運用で確認 | 今回はリポジトリ調査のみ |

## 検索・絞り込みの一覧

以下の `/associations/:associationId` は対象の町内会IDで限定される。
「ブラウザー内」は取得した一覧を `includes()` 等で絞り込む実装。「DB」はMongoDBの条件で検索する実装。
権限は現在のコードの条件であり、「役員である」だけで全機能を使用できるわけではない。

| 機能・URL | 現在の利用条件 | 対象・一致方法／実行場所 | 住所・電話を先行暗号化した際の影響 | 根拠 |
|---|---|---|---|---|
| 住人一覧 `/associations/:associationId/manage/members` | `association.manage`。システム管理者は権限チェックを通過 | 氏名（表示名またはログインID）・メール部分一致。複数語AND、NFKC・小文字化。地区／班／役職／部会のID絞込。ブラウザー内 | 検索への直接影響なし。住所・電話を表示・編集するため復号が必要。初期取得は町内会の有効会員一覧 | [ルート](src/routes/management.js)、[画面](src/views/association-members.ejs)、[権限](src/middleware/auth.js) |
| 管理者候補 `/associations/:associationId/manage/managers` | `role.manage`。システム管理者例外あり | 氏名・ログインID・メール・班名の部分一致。複数語AND、ブラウザー内 | 住所・電話は検索対象外 | [ルート](src/routes/management.js)、[画面](src/views/association-managers.ejs) |
| 年度設定・役員候補 `/associations/:associationId/manage/annual` | 画面は `association.manage`。役員登録等の操作は `role.manage` | 年度はDB条件。候補は氏名・ログインID・メール・班・**住所（郵便番号・建物含む）**・性別表示・属性タグの部分一致。複数語AND、ブラウザー内 | **検索用 `searchText`、入力例・説明から住所を除く候補**。表示・編集は復号して維持 | [ルート](src/routes/management.js)、[画面](src/views/association-annual-settings.ejs) |
| 年度設定・班長候補（同画面） | 画面は `association.manage`。班長操作はルートにより `role.manage`／`organization.manage` | 氏名・ログインID・メール・班・**住所**・属性タグの部分一致。複数語AND、ブラウザー内 | **住所検索を除く候補** | [ルート](src/routes/management.js)、[画面](src/views/association-annual-settings.ejs) |
| 年度設定・会員紐付け（同画面のダイアログ） | 画面は `association.manage`、紐付け操作は `role.manage` | 役員／班長とも候補氏名・メール部分一致、ブラウザー内 | 住所・電話への直接影響なし | [画面](src/views/association-annual-settings.ejs)、[ルート](src/routes/management.js) |
| 役員一覧 `/associations/:associationId/manage/officers` | `association.manage`。システム管理者例外あり | 年度はDB条件。氏名・地区／班表示・メール・**住所**の部分一致、ブラウザー内。電話は検索文字列に含めない | **住所検索を除く候補**。住所・電話・携帯を一覧／編集に表示 | [ルート](src/routes/management.js)、[画面](src/views/association-officers.ejs) |
| 班長一覧 `/associations/:associationId/manage/leaders` | `association.manage`。システム管理者例外あり | 年度はDB条件。氏名・地区／班表示・メール・**住所**の部分一致、ブラウザー内。電話は検索文字列に含めない | **住所検索を除く候補**。住所・電話・携帯を一覧／編集に表示 | [ルート](src/routes/management.js)、[画面](src/views/association-leaders.ejs) |
| グループメンバー `/associations/:associationId/groups/:groupId/manage` | ログイン＋対象グループ責任者確認 | 氏名・ログインID・メール部分一致、NFKC・小文字化、ブラウザー内 | 住所・電話への直接影響なし。一般住人向け検索ではなく責任者の管理機能 | [ルート](src/routes/associationGroups.js)、[画面](src/views/association-group-manage.ejs) |
| 班長台帳・会費 `/associations/:associationId/leader`、`/leader/fees` | ログイン＋現在年度の担当班確認 | 担当班・有効世帯／会員・申請状態・年度でDB絞込。世帯名DB並び替え、生年月日による世帯員のDB並び替え。文字列検索入力は確認できない | 住所・電話の表示・更新に復号。世帯名暗号化はDB並び替えに影響するため後続 | [ルート](src/routes/households.js)、[会費画面](src/views/leader-fees.ejs) |
| 個人情報閲覧監査 `/admin/privacy-audit` | システム管理者 | 日付・町内会・カテゴリ・操作・対象ID。閲覧者はID完全一致、または `actorName` の部分一致（DB正規表現） | 住所・電話への直接影響なし。氏名暗号化時は過去の `actorName` と検索を別途設計 | [ルート](src/routes/privacyAudit.js)、[条件](src/services/privacyAuditQuery.js) |
| 公開の町内会一覧 | ログイン不要 | 都道府県・市区町村の正規表現条件、キーワードで町内会名・活動区域・**町内会所在地の番地**をDB部分一致検索 | **公開所在地は個人住所とは別に扱う**。一律暗号化は検索を壊す | [ルート](src/routes/web.js) |

現行の氏名検索では、ふりがなが自動的にすべて検索されるわけではない。上表の検索用文字列に `nameKana` を含まない画面がある。ふりがな検索の追加は今回の調査・住所電話暗号化とは別の仕様変更。

## 検索入力以外の照合・利用

| 用途 | 現行の条件／処理 | 氏名・メール暗号化時の注意 | 根拠 |
|---|---|---|---|
| ログイン | `passport-local-mongoose` による `username` とパスワード照合 | ログインIDは表示名と分ける。暗号化変更は既存認証・共有サービスに影響 | [アカウント](src/models/user.js)、[認証](src/routes/auth.js)、[Webログイン](src/routes/web.js) |
| 新規登録・本登録・再送 | `users` / 仮登録のメール・ログインID重複確認。メールの小文字化／照合、仮登録の一意索引 | 完全一致索引、重複判定、一意性を移行後も維持 | [登録](src/services/userService.js)、[確認・再送](src/services/emailVerificationService.js) |
| パスワード再設定 | メール完全一致＋大文字小文字を区別しないcollation。メール送信 | 検索用索引と送信用復号が必要 | [サービス](src/services/passwordResetService.js) |
| 世帯主への参加依頼 | 入力メールから `users` を完全一致検索。本人メールとの比較 | 一般住人が入力するが、住人一覧を自由検索する機能とは異なる | [参加処理](src/services/householdParticipationService.js) |
| 招待・受諾 | 招待メールと本人メールの比較、既存アカウント検索、受諾更新条件にメール | DB条件とアプリ内比較の両方を変更する必要あり | [招待](src/routes/householdInvitations.js)、[参加](src/services/householdParticipationService.js)、[登録画面](src/routes/web.js) |
| 名簿・宛先選択・申請確認 | 役員連絡網、地区連絡、住人への連絡、入会承認、退会、グループ管理等で `populate` した氏名／メールを表示 | 部分一致入力がない選択リストにも表示・復号が必要 | [役員連絡](src/routes/officerNetwork.js)、[地区連絡](src/routes/districtMessages.js)、[住人連絡](src/routes/officerAnnouncements.js)、[退会](src/routes/withdrawals.js) |
| 一般住人からの閲覧 | 自分／自世帯のプロフィール・申請、役員紹介、参加グループ等 | 他住人検索は不要でも表示用途は残る。役員紹介は住所・電話・携帯をDB取得から除外している | [Webルート](src/routes/web.js)、[グループ](src/routes/associationGroups.js) |

## 住所・電話番号を先行する際の実装範囲案

この節は次段階の案であり、実装済みではない。

| 対象 | 項目 | 維持・確認する処理 |
|---|---|---|
| 世帯 | `address.postalCode/street/building`、`phone` | 入会、プロフィール、管理者住人編集、班長会費台帳、申請再表示、削除確認 |
| 年度役員 | `address`、`phone`、`mobilePhone` | 手入力・更新・一覧・会員紐付け・次年度コピー |
| 年度班長 | `address`、`phone`、`mobilePhone` | 手入力・更新・一覧・会員／世帯紐付け・次年度コピー |

- 町内会の公開住所・問い合わせ先は、公開仕様を維持する別枠として扱う案。
- 役員・班長一覧と年度設定の住所検索を除外し、氏名・メール・地区／班などの部分一致を維持する案。
- メール、氏名、ふりがな、世帯名、生年月日、性別、LINE、自由記述は先行対象に混ぜず、保存コピー・検索要件を整理して後続で対応する。
- 読み取りは `.lean()`、`populate()`、項目指定 `select()` を含む。書き込みは `save()`、`create()`、`updateOne()`、`findOneAndUpdate()`、`insertMany()` 等の経路を確認し、特定のフックだけに依存して平文が残らないようにする。
- 次年度コピーで暗号文が二重暗号化されないこと、キーの版・レコード／項目の紐付けと整合することを確認する。
- 既存・退会済み・取消済み・過去年度・未紐付け台帳も移行範囲に含める。現在画面に見えるデータだけでは不十分。
- 個人情報専用の鍵をMFA鍵と分離する。鍵がない／不正／復号失敗時は安全に処理を止め、平文保存や暗号文の画面表示に切り替えない。
- テスト環境で移行の再実行・中断再開・鍵更新・バックアップ復旧、画面と更新の往復、検索対象の変更を検証する。

## 未確認事項・次段階で確認するもの

- 本番DBのフィールド分布、旧形式、モデル外フィールド、`addressEvidence` や共通 `groups.invitedUsers` の実際の内容。
- `accountbook_project_clean` / `menu-service` の個人情報利用・検索・保存コピー。先行する町内会専用コレクションへの他サービスからのアクセスも未確認。
- Atlasの実際の保存時暗号化・バックアップ・アクセス設定、SMTP／Drive／Cloudinary／運用ログの保持・共有設定。
- 町内会連絡先が個人宅・個人電話の場合の公開方針と、過去のエクスポートファイル／バックアップの保管。
- 管理対象の最大人数と必要な閲覧範囲。現行のブラウザー内検索はページング・取得量の観点で、10万人規模の負荷評価が別途必要。

今回の確認はソースコードの読み取りと文書作成であり、本番・テストDBの参照／変更は行っていない。

## 共有プロジェクトの追加確認（2026-10-05）

ローカルの `accountbook_project_clean` と `menu-service` のモデル・ルート・画面コードを追加で読み取り確認した。本番に配置されている版や実データとの一致は未確認。

- 両プロジェクトのコードで、町内会専用 `households` / `household_members` / `annual_officers` / `annual_leader_assignments` への参照は検索で見つからない。これらに保存する住所・電話の暗号化は、本アプリ内で対応できる見込み。
- `accountbook_project_clean/models/resume.js` には履歴書用の `zip`、`prefecture`、`city`、`address_detail`、`home_phone`、`mobile_phone` があり、履歴書画面・PDFで使われる。したがって「他プロジェクトでは住所・電話を一切利用していない」とは言えない。町内会の世帯・年度台帳とは別モデルであり、今回の先行暗号化の対象には含めない。
- 両プロジェクトは共通アカウントの `displayname` / `email` を表示・編集等に使用する。`menu-service/models/users.js` は認証に `usernameField: 'email'` を設定している。共通フィールドの暗号化は他アプリの表示だけでなくログイン・更新・照合にも影響するため、合同の移行設計が必要。
- この追加確認は参照有無と共有フィールドの主要利用確認であり、他プロジェクト全体の個人情報棚卸しではない。
