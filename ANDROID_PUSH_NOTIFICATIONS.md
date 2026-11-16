# Androidアプリへの通知配信

お知らせ・緊急/危険情報・対応依頼を、既存の通知キューからFirebase Cloud Messaging（FCM）経由でAndroidアプリへ配信します。iPhone向け（APNs）、Web Push、メールは従来どおり独立して配信され、この機能の追加で動作は変わりません。町内会の通知設定でpushが無効ならAndroidにも配信しません。会話通知は対象外です（iPhone向けと同じ）。

## 追加したファイル

| ファイル | 役割 |
| --- | --- |
| `src/models/androidFcmSubscription.js` | Android端末の登録（ユーザー、FCMトークン、パッケージ名、ログインセッション、有効期限） |
| `src/services/androidFcmService.js` | FCM（HTTP v1）への送信、端末登録の検証、サービスアカウント認証 |
| `src/routes/androidPushDevices.js` | 端末登録API（`/api/android-push-devices`） |
| `test/android-fcm.test.js` | モックを使ったテスト（実際の通知は送りません） |

既存ファイルへの変更は追加のみです: `src/app.js`（ルート登録）、`src/routes/auth.js`（ログアウト時にAndroid端末の登録も解除）、`src/services/notificationService.js`（配信にAndroidを追加）、`src/models/notification.js`（`delivery.androidFcm`を追加）。

## 本番で必要な設定

1. Firebaseコンソールでプロジェクトを作成し、Androidアプリを `com.masayukioyabu.machinodengonban`（アプリのapplicationId）で登録します。
2. 「プロジェクトの設定 → サービスアカウント」で新しい秘密鍵（JSON）を発行します。このJSONはリポジトリやチャットに保存しないでください。
3. サーバーの秘密情報管理（HerokuのConfig Vars）に以下を設定し、このサーバーコードを反映します。

| 環境変数 | 値 |
| --- | --- |
| `FCM_PROJECT_ID` | JSONの `project_id` |
| `FCM_CLIENT_EMAIL` | JSONの `client_email` |
| `FCM_PRIVATE_KEY` | JSONの `private_key`（PEM全文。実際の改行、または `\n` を使用可能） |
| `FCM_ANDROID_PACKAGE` | 省略可。既定は `com.masayukioyabu.machinodengonban` |
| `PUBLIC_BASE_URL` | 既存の値（iPhone向けと共通。アプリの接続先と一致させる） |

4. Androidアプリ側には、FirebaseコンソールからダウンロードしたAndroid用の設定ファイル（`google-services.json`）を配置します。これはAndroidプロジェクトの `app/` に置き、Gitには入れません。

## 端末登録・解除

- `GET /api/android-push-devices`: ログイン必須。CSRFトークンとサーバー設定の有無（`configured`）を返します。
- `POST /api/android-push-devices`: ログイン・CSRF検証後に `{ "_csrf": "...", "token": "FCMトークン" }` を登録します。成功は204。サーバー設定が未完了なら503（`push_not_configured`）。パッケージ名はサーバーが決め、クライアントの値は使いません。同一トークンは一つのアカウントだけに紐付きます。
- `DELETE /api/android-push-devices`: ログイン・CSRF検証後に現在のセッションの登録だけを解除します。
- `POST /api/auth/logout`（既存）はAndroid端末の登録も解除してからセッションを破棄します。
- 配信前にもログインセッションの有効期限とユーザーを照合します。Web経由のログアウトや期限切れにも対応します。
- FCMが `UNREGISTERED`（またはHTTP 404）、`SENDER_ID_MISMATCH` を返した端末だけを無効化し、ほかの端末への配信は継続します。ペイロードの不備（`INVALID_ARGUMENT`）は端末の無効化ではなく失敗として記録します。

## 配信内容

- `notification`: `title`（80文字まで）、`body`（300文字まで）
- `data`: `notificationId`、`recipientId`、`server`（`PUBLIC_BASE_URL` のorigin）。iPhone向けと同じキーです。
- Android設定: 通知チャネルID `notifications`、優先度 `HIGH`、有効期間1時間、通知IDごとに置き換え（`collapse_key`）。

アプリ側は、`notifications` という通知チャネルを作成しておく必要があります。

## 確認方法

`node --test test/android-fcm.test.js test/apns.test.js test/notification-delivery.test.js test/notification-settings.test.js test/notification-inbox.test.js`

`test/android-fcm.test.js` はモックを使用し、認証署名・端末分離・ログアウト・期限切れ・権限判定を検証します。

本番設定後は、テスト用アカウントで3種類の通知を発生させ、アプリ起動中・バックグラウンド・終了中の受信、通知タップによる詳細表示、ログアウト後に新規通知が届かないことを実機で確認してください。Androidの省電力設定や通知のオフにより、表示が遅延・抑制される場合があります。

結果は通知レコードの `delivery.androidFcm` に記録されます。既存キューと同様、配信処理で確保した通知の失敗を自動再送する機能はありません。過去の通知の一括再送は行いません。
