# 優先度Aのセキュリティ対策

## アプリに導入した対策

### 1. 認証関連のレート制限

画面とAPIのログインは同じ制限を共有します。セッション作成より前にIP・入力されたアカウントを確認し、招待送信・パスワード変更にはログイン中のユーザー単位の制限も適用します。

| 操作 | 時間枠 | IPごとの上限 | アカウント／宛先ごとの上限 | ログインユーザーごとの上限 |
| --- | --- | --- | --- | --- |
| 画面・APIログイン | 15分 | 30 | 15 | — |
| 再設定メール・確認メール再送 | 1時間 | 10 | 3（本文にemailがある場合） | — |
| パスワード再設定 | 15分 | 20 | — | — |
| 会員登録 | 1時間 | 10 | 3 | — |
| 家族の招待メール送信 | 1時間 | 20 | 3 | 10 |
| 招待・確認メール・再設定リンク閲覧、招待受諾 | 15分 | 30 | — | — |
| MFAの登録確認・検証・設定変更 | 15分 | 30 | — | 10 |
| プロフィールでのパスワード変更 | 15分 | 10 | — | 5 |

上限は成功・失敗を含む試行回数です。固定時間枠を使用し、枠が切り替わると回数がリセットされます。上限超過にはHTTP 429・Retry-After・日本語の案内を返します。アカウントの存在を調べる前に制限するため、制限の応答で登録状況を明かしません。

本番では `chounaikai_auth_rate_limits` に原子的に回数を保存し、複数dyno・再起動をまたいで共有します。IPとアカウントはセッション秘密鍵によるHMACで識別し、本文・パスワード・招待トークンは保存しません。期限切れのレコードはTTLインデックスで削除します。保存先の障害時は対象操作を503で止め、制限を迂回させません。開発環境のみメモリ保存です。

IPv4とIPv4-mapped IPv6は同じIPに正規化し、IPv6は同じ/64内のアドレスをまとめて制限します。ログインのアカウント制限はIPを変えても維持します。通常の一覧表示、ログアウト、healthにはこの制限を適用しません。

### 2. Helmet

Helmetを全応答に適用し、CSP、nosniff、同一オリジンのフレーム制限、Referrer-Policyなどを設定します。外部への通信は住所検索、iframeは既存のYouTube表示を許可します。資料の同一オリジンPDF埋め込みも継続できます。

既存画面には多数のインラインスクリプト・イベント属性があるため、今回のCSPでは `unsafe-inline` を許可しています。インライン実装を外部JSまたはnonce方式へ移すことは別途必要です。Helmetを入れただけでXSS全体を解決した扱いにはしません。

### 3. HTTPSとHSTS

`NODE_ENV=production` では `PUBLIC_BASE_URL` が資格情報・パス・クエリなしのHTTPS originであることを起動時に検証します。HTTPのGET/HEADはそのoriginへ308で誘導し、Host/X-Forwarded-Hostは転送先に使いません。HTTPのPOSTなどは400で拒否し、HTTPS画面を開き直すよう案内します。認証情報を含むHTTP要求をリダイレクトで自動再送しません。

HTTPS応答には1年間のHSTSを設定します。配下の別サービスへ影響させないため、includeSubDomains・preloadは有効にしません。開発環境のHTTPではHTTPS強制・HSTS・CSPのupgrade-insecure-requestsを適用しません。既存の本番セッションCookieはSecure・HttpOnly・SameSite=Laxを維持します。

`TRUST_PROXY` はHerokuで `1`、単一のNginxなら信頼できるIP/CIDRを設定します。直接公開するNodeサーバーでは `false` です。全送信者を信頼する `true` は禁止しています。ホップ数を指定するときは、アプリへの直接接続経路を設けず、信頼するプロキシが転送ヘッダーを正しく管理することが前提です。

### 4. MongoDB Atlasの認証・TLS・接続元制限

本番は認証済みの専用DBユーザー、TLS、証明書・ホスト名検証を必須にします。無認証URI、TLS無効、tlsInsecure、証明書検証無効、ホスト名検証無効を起動時に拒否します。接続先ホストも `MONGODB_ALLOWED_HOSTS` で明示指定します。このホスト指定は接続先誤設定対策であり、Atlas側の接続元制限を代替しません。

Mongooseとセッション保存は同じMongoDBクライアントを共有します。TLSと任意のSOCKS5プロキシ設定を両方に適用し、DB通信だけを固定IP経由にできます。プロキシが設定済みで接続に失敗した場合に直接接続へ自動フォールバックする処理はありません。

## 現在の本番確認結果（2026-10-05）

Herokuアプリ `chonaikai-maoyabu` の設定を読み取り、Atlas SRV接続・認証・TLS・証明書検証が有効なことを確認しました。PUBLIC_BASE_URLはHTTPSです。固定IP用アドオンはなく、利用者からも固定IP未確保と回答がありました。Atlas Network Accessの実際の許可リストとDBユーザー権限は未確認です。

今回は利用者の指示により、固定IPの導入とAtlasの接続元制限の変更を見送ります。認証関連のレート制限、Helmet、HTTPS強制・HSTS、MongoDB認証・TLS検証を本番反映の対象にします。SOCKS5接続対応は設定が空のままなので有効になりません。

## 本番導入手順

1. AtlasのDatabase Accessでアプリ専用ユーザーを用意し、利用DB（現在のfinance）へのreadWriteに権限を限定します。アプリ起動時のコレクション・インデックス作成に対応する必要があります。Atlas管理者アカウントとDBユーザーは別です。既存サービスの共通users/groupsへのアクセスは引き続き必要です。専用ユーザーへ切り替える際も共有コレクションへの必要権限を維持します。
2. Heroku Config Varsに `MONGODB_ALLOWED_HOSTS=cluster0.krfxc.mongodb.net`、`TRUST_PROXY=1` を設定します。`MONGODB_URI` は認証付きAtlas URI、`PUBLIC_BASE_URL` は現在のHTTPS originを維持します。秘密値をGit・ターミナル出力に載せません。Atlasの公開CAを使用する通常の接続では `MONGODB_TLS_CA_FILE` は不要です。
3. 固定IP経路を確保します。現在のHeroku構成では、MongoDBのTCP通信に対応するSOCKS5サービスを使用できます。HTTP専用の固定IPプロキシは選びません。Fixie Socksを選ぶ場合、提供される `FIXIE_SOCKS_HOST` をそのまま利用できます。他のSOCKS5サービスなら `MONGODB_SOCKS_PROXY_URL=socks5://USER:URL_ENCODED_PASSWORD@HOST:PORT` を設定します。料金が発生する契約は利用者の承認後に行います。
4. AtlasのNetwork Accessに固定IPを/32で追加します。冗長化用のIPが複数ある場合はすべて追加します。必要な既存サービスの固定接続元・管理用の一時IPも確認します。この段階では既存の許可設定を削除せず、接続経路を確立します。
5. コードをデプロイし、下記の設定検査・接続確認を実行します。ログイン、再設定メール、招待、資料PDF表示、住所検索を確認します。新しい設定が不足している場合、本番アプリは安全でない状態で起動せず、起動を拒否します。
6. 固定IP経由の接続を確認後、Atlasの `0.0.0.0/0` や不要な広いCIDRがあれば削除します。現在のdynoが既存接続で動いているだけの状態を避けるため、再接続も確認します。許可外のネットワークから接続が拒否されることを確認し、health・ログイン・通知配信を再確認します。共有Atlasを使う他サービスの接続元も残します。

固定IPサービスに障害が出た場合はアプリを停止・復旧させ、全IPを再許可する自動処理は行いません。計画的なロールバックには変更前のConfig Varsを安全に保存し、必要な接続元だけを再許可します。

### 設定検査・接続確認

```sh
NODE_ENV=production npm run security:check
NODE_ENV=production npm run security:check -- --connect
```

`--connect` はMongoDBへ読み取り専用のpingを行います。コレクション・ユーザー・インデックス・Network Accessを変更しません。プロキシ未設定も明示します。ただしこのコマンドはAtlasの許可リスト自体を取得しないため、Network Accessの監査はAtlasで行います。

### 固定IPの候補

Fixie SocksのHandlebarは月額上限9 USD、月2,000接続・500 MB、無料Gripは月100接続・100 MBです（2026-10-05に公式料金ページを確認）。無料枠は本番DBの常時監視・再接続も考えると検証用とし、まず有料小容量で実使用量を確認する案です。500 MBを超える利用量なら上位プラン等を検討します。今回の反映では契約・Atlasの接続元制限変更は実施しません。

## 検証

`test/auth-rate-limit.test.js`、`test/security-config.test.js`、`test/security-http.test.js` で制限対象、画面/APIの共有制限、宛先・ユーザー制限、IPv6、同時実行、DB保存障害、MongoDBの安全でない設定の拒否、SOCKS5設定、実際のHTTP応答を検証します。HTTPテストはローカルの一時ポートを使い、本番DBには接続しません。

## 公式資料

- [Helmet](https://helmetjs.github.io/)
- [Expressのプロキシ設定](https://expressjs.com/en/guide/behind-proxies.html)
- [Atlasのネットワークセキュリティ](https://www.mongodb.com/docs/atlas/architecture/current/network-security/)
- [MongoDBドライバーのSOCKS5設定](https://www.mongodb.com/docs/drivers/node/current/security/socks/)
- [HerokuのFixie Socks連携](https://devcenter.heroku.com/articles/fixie-socks)
- [Fixie Socksの公式料金](https://elements.heroku.com/addons/fixie-socks)

## 管理者の多要素認証

初期設定ではシステム管理者と有効な町内会管理者権限を持つアカウントにTOTP認証を必須にします。システム管理者が `/admin/security` でサイト全体の使用を切り替えられます。登録済みの管理者による切り替えには、現在のパスワードと追加認証が必要です。設定と変更履歴は原子的に保存し、再有効化で古い追加認証済みセッションを失効させます。
既存ログイン、画面、APIを共通のミドルウェアで保護し、パスワード再設定後もMFAを維持します。
MFAの秘密は専用コレクションで暗号化し、復旧コードはハッシュだけを保存します。

本番反映前に **MFA_ENCRYPTION_KEY** の新規設定が必要です。
今回のMFA作業はテスト環境までとし、GitHub・Herokuへは反映しません。
具体的な利用・反映・検証手順は [MFA.md](MFA.md) を参照してください。

## 個人情報の閲覧監査

対象画面/API/ファイルは個人情報を返す前に `chounaikai_privacy_access_logs` へ記録します。監査ログはシステム管理者だけが閲覧でき、サイトのMFAが有効な場合は追加認証も必要です。その閲覧も記録します。ログへの個人情報の複製を抑え、書き込み失敗時は503で遮断します。保管期限は未設定（自動削除なし）です。対象と運用上の境界は [PRIVACY_AUDIT.md](PRIVACY_AUDIT.md) を参照してください。

## 本番エラー応答の詳細非表示

本番は `NODE_ENV=production` を設定してください。`createApp` の環境指定をExpressの `env` にも明示し、HTTPエラーのHTML・API・AJAX応答へ共通の保護を適用します。

- 400・401・403・404・409・413・429・5xxの本文は固定の日本語メッセージにします。例外の `message`、`stack`、内部の詳細、DB接続文字列、秘密情報、内部ファイルパスを応答へコピーしません。
- 個別ルートが直接返すエラー画面・JSON・文字列も本番用の共通処理を通します。JSONの認証状態を示す公開コードは明示した許可リストだけを保持し、内部エラーコードや付随情報は返しません。
- 入力フォームの `formError` とフラッシュの `errorMessage` も固定文言にします。入力フォームは維持しますが、本番では詳細な入力エラー理由は表示しません。
- エラー画面はテンプレートに依存しない固定HTMLを使います。EJS生成が失敗してもExpressの標準スタック表示へフォールバックしません。
- 存在しない経路にも共通404を返し、リクエストURLをエラー本文へ反映しません。不正JSON・入力サイズ超過も共通処理を通します。
- エラー応答は `Cache-Control: no-store` とします。ファイル送信などで応答開始後にエラーが発生した場合は接続を閉じ、例外情報を追記しません。

サーバー側の診断ログはブラウザへの応答と分離します。5xxの例外詳細は従来どおりサーバーログに記録するため、ログを閲覧する権限は管理者に限定してください。開発環境では従来の入力確認メッセージを利用できますが、サーバーエラーは汎用メッセージを返します。

ローカルで本番モードの応答を含む確認テストを実行できます。本番DB・Atlasへの接続や外部への配信は行いません。

```sh
npm run test:security
```

`test/production-errors.test.js` は、接続文字列・認証情報・内部パスを含む疑似例外を発生させ、HTML/API/AJAX、直接応答、フォーム、テンプレート失敗、不正JSON、大きすぎる入力、404、送信開始後のエラーの非開示を検証します。本番の設定確認には従来どおり `NODE_ENV=production npm run security:check` を使用します。今回の変更による追加の環境変数はありません。
