# LINEログイン

既存会員がID・パスワードでログインし、プロフィールの本人情報 →「ログイン・通知」で、通知設定の下にある「LINEログインの連携・解除」を開いて本人のLINEを連携します。初期状態は閉じており、見出しに連携済み・未連携を表示します。連携・解除には現在のパスワードが必要です。新規アカウントの自動作成や、メール・表示名による自動紐付けは行いません。参加承認・町内会権限は既存の仕組みを使用します。

## Herokuでの準備

1. Heroku Dashboardでアプリ `chonaikai-maoyabu-4c7a141082fc` の Settings → Config Vars を開きます。
2. `PUBLIC_BASE_URL` が `https://chonaikai-maoyabu-4c7a141082fc.herokuapp.com` であることを確認します。
3. 以下を設定します。シークレットをGit・チャット・スクリーンショット・シェル履歴に保存しないでください。

|変数|値|
|---|---|
|LINE_LOGIN_CHANNEL_ID|LINE DevelopersのチャネルID|
|LINE_LOGIN_CHANNEL_SECRET|同じチャネルのチャネルシークレット|

両方が未設定の場合は機能と画面の入口を非表示にします。片方のみ設定・不正な公開URLは起動時エラーです。設定は全町内会共通で、町内会ごとの登録は不要です。

4. LINE Developersのウェブアプリ設定に以下を登録します。

```text
https://chonaikai-maoyabu-4c7a141082fc.herokuapp.com/auth/line/callback
```

5. コードをデプロイします。起動時に専用コレクションの一意インデックスと有効期限インデックスを作成します。インデックス作成に失敗した場合は公開せず解決してください。
6. LINEチャネルは「開発中」のまま、AdminまたはTesterのアカウントで下記を確認します。一般会員への案内は確認後にチャネルを「公開」してから行います。

## 実機での確認

- 従来のログインでプロフィール → LINEログイン設定 → パスワード入力 → LINEでの同意 → 連携済み表示。
- ログアウト後「LINEでログイン」で同じ会員・同じ町内会に戻る。
- 未連携のLINEではログインできず、従来ログインでの連携を案内する。
- LINEでキャンセル、別ブラウザでコールバックを開く、期限切れ、コールバックの再読み込みでログイン・連携できない。
- 管理者はLINEログイン後も既存のMFA設定・追加認証を要求される（サイト全体のMFA設定が有効な場合）。
- 家族招待・町内会登録の途中でLINEログインしても、その手続きへ戻る。
- 解除時に現在のセッションが終了し、他端末のLINEログイン済みセッションも次のリクエストで終了する。ID・パスワードでは引き続きログインできる。
- LINE連携を解除・再連携しても古いLINEログインのセッションは復活しない。
- Safari/Chrome、スマホ/PCそれぞれでLINEへの遷移と復帰を確認する。

## 保存・保護

- 共通 `users` / `groups` は変更しません。
- `chounaikai_line_identities`：チャネルID、LINEユーザーID、既存会員ID、日時を保存。会員ごと・LINEごとに一意です。連携準備中はLINEユーザーIDを持たない予約行を作成します。
- `chounaikai_line_flows`：ブラウザと紐付いた10分間の認証要求。stateとブラウザ識別子はハッシュで保存し、nonce・PKCE verifierは短期間だけサーバーDBに保存します。コールバック時に原子的に1回だけ消費し、期限切れ行はTTLで削除します。
- スコープは `openid` のみ。LINEのメール、プロフィール写真、表示名、トーク、友だち一覧は取得しません。アクセストークン・リフレッシュトークン・IDトークンは永続保存しません。
- LINEのIDトークン検証APIを使い、署名等の検証結果に加えてissuer・audience・nonce・有効期限を確認します。通信失敗時はログインさせません。
- state・PKCE・ブラウザとの紐付け・CSRF・操作回数制限・連携時のパスワード確認を適用します。
- LINEでのログイン後もPassportのセッションIDを更新します。MFAを迂回せず、招待・登録の文脈を保持します。
- LINEセッションは連携レコードと現在のパスワード状態を毎回確認します。解除・パスワード変更時は再ログインが必要です。
- 解除は本サービス内の紐付けを削除します。LINEアプリ側の連動アプリ許可は自動解除しません。必要に応じて利用者自身がLINE側でも解除してください。
- 町内会からの退会は共通アカウントの退会とは別です。所属・機能権限はその都度既存の仕組みで判定します。

## 検証

`node --test test/line-login.test.js`。LINE APIとDBはモックを使用します。実際のLINE認証・MongoDBの同時更新・一意制約・Heroku環境での動作は、デプロイ後に上記の確認が必要です。

## 公式資料

- https://developers.line.biz/ja/docs/line-login/integrate-line-login/
- https://developers.line.biz/ja/docs/line-login/integrate-pkce/
- https://developers.line.biz/en/reference/line-login/
- https://developers.line.biz/ja/docs/line-login/login-button/

ログインボタンのアイコンは上記公式ページのテンプレートから取得した画像を使用しています。再配布・変更時もLINEの利用条件・デザインガイドラインに従ってください。
