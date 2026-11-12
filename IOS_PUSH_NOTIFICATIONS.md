# iPhoneアプリへの通知配信

お知らせ・緊急/危険情報・対応依頼を既存の通知キューからAPNsへ配信します。Web Push・メールは従来どおり独立して配信します。町内会の通知設定でpushが無効ならAPNsも配信しません。会話通知は今回の対象外です。

## 本番で必要な設定

1. Apple DeveloperのIdentifiersで `com.MasayukiOyabu.machinodengonban` のPush Notificationsを有効にします。Xcodeの署名用Teamは `T7NYCH5XE2` です。
2. 同じTeamでAPNs用の認証キーを作成します。開発環境と本番環境を利用する場合は両方を許可したキーを使います。取得した `.p8` はリポジトリやチャットに保存しないでください。
3. サーバーの秘密情報管理で以下を設定し、今回のサーバーコードを反映します。

| 環境変数 | 値 |
| --- | --- |
| `APNS_KEY_ID` | Apple Developerに表示されるKey ID |
| `APNS_TEAM_ID` | キーを発行したTeam ID |
| `APNS_PRIVATE_KEY` | `.p8` のPEM全文。実際の改行、または `\n` を使用可能 |
| `APNS_TOPIC` | `com.MasayukiOyabu.machinodengonban` |
| `PUBLIC_BASE_URL` | アプリが接続する本番サーバーのHTTPS URL |

`PUBLIC_BASE_URL` のoriginとアプリの接続先が一致する必要があります。APIやログに秘密鍵・端末トークンを表示しないでください。

4. Push Notifications対応の署名プロファイルでアプリをビルドし、実機に入れます。開発用署名はsandbox、TestFlight/App Store配布はproductionを使用します。アプリは埋め込みプロファイルの `aps-environment` を読みます。配布時はXcodeの通常のArchive/Exportフローで署名してください。
5. ログイン後の通知許可で「許可」を選択します。「マイページ → 設定 → アプリの通知」で登録結果を確認できます。許可を拒否した場合は同画面からiPhoneの通知設定へ移動できます。

## 端末登録・解除

- `GET /api/push-devices`: ログイン必須。CSRFトークンとサーバー設定の有無を返します。
- `POST /api/push-devices`: ログイン・CSRF検証後にtoken/environmentを登録します。user/topicはサーバーで決定します。同一token/environment/topicは一つのアカウントだけに紐付きます。
- `DELETE /api/push-devices`: ログイン・CSRF検証後に現在のセッションの登録だけを解除します。
- アプリのログアウトはサーバーで端末登録を解除してからセッションを破棄します。失敗時はログアウト完了と表示しません。
- 配信前にもログインセッションの有効期限とユーザーを照合します。Web経由のログアウトや期限切れにも対応します。
- 410、BadDeviceTokenなどは該当端末だけを無効化し、ほかの端末の配信を継続します。

## 確認方法

`node --test test/apns.test.js test/notification-delivery.test.js test/notification-settings.test.js test/notification-inbox.test.js`

上記はモックを使用し、実際の通知を送らずに認証署名・端末分離・ログアウト・期限切れ・権限判定を検証します。

本番設定後は、テスト用アカウントで3種類の通知を発生させ、アプリ起動中・バックグラウンド・終了中の受信、通知タップによる詳細表示、ログアウト後に新規通知が届かないことを実機で確認してください。通知許可、集中モード、通信状況によりiOSでの表示が遅延・抑制される場合があります。

結果は通知レコードの `delivery.apns` に記録されます。既存キューと同様、配信処理で確保した通知の失敗を自動再送する機能はありません。過去の通知の一括再送は行いません。
