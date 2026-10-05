# 町内会専用の住所・電話番号の暗号化

## 実装範囲

| コレクション | 暗号化する項目 |
|---|---|
| `households` | `address.postalCode`、`address.street`、`address.building`、`phone` |
| `annual_officers` | `address`、`phone`、`mobilePhone` |
| `annual_leader_assignments` | `address`、`phone`、`mobilePhone` |

AES-256-GCM、暗号化ごとにランダムな96bit IV、128bit認証タグを使用する。鍵バージョン、コレクション、レコードID、項目を認証対象にし、別レコード・別項目への暗号文の移植を検出する。
保存形式は `pii:v1:<鍵バージョン>:<IV>:<認証タグ>:<暗号文>`。
住所・電話の非空の平文は通常のモデル読取で拒否する。未設定値（null・未定義）と旧データの空文字は許可する。新規の空文字は暗号化して保存する。

共有 `users` / `groups`、氏名・ふりがな・メール、公開の町内会所在地・連絡先、他サービスの履歴書データ、自由記述・添付・既存のバックアップは変更しない。
DBだけの漏えいに対する追加保護であり、アプリと鍵の同時侵害、権限ある画面からの持出しは権限管理・監査・運用で対策する。

## 鍵の設定（テスト・本番の両方で必須）

以下のコマンドを利用者のターミナルで実行して、32byteのランダム鍵を生成する。

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

生成した値をテスト環境の `.env`、本番のHeroku Configに設定する。テストと本番は異なる鍵を生成する。

```dotenv
PERSONAL_DATA_ENCRYPTION_KEY=<生成した64桁の16進数>
PERSONAL_DATA_KEY_VERSION=1
PERSONAL_DATA_PREVIOUS_KEYS={}
```

MFAの鍵と共用しない（同じ鍵の場合は拒否）。鍵とバージョンは再起動・デプロイのたびに変更しない。
鍵をGit、チャット、通常のログに貼らない。安全な管理ツール等で、DBバックアップとは別に鍵とバージョンの履歴を保管する。
この実装は毎回設定を検証し、鍵なし・不正・復号失敗時に平文へフォールバックしない。
起動用 `loadConfig()` でも検証するため、設定前のサーバー起動は失敗する。

## 既存データの移行

移行対象は３コレクションの全レコード。過去年度・取消・退会・削除済み世帯も含む。
通常のモデル経由では旧平文を読めないため、以下の移行コマンドが生のDBドライバーで変換する。
接続設定には既存のMongoDB認証・TLS・許可ホスト・任意のSOCKS設定を使用する。

### テスト環境

1. 本番へ接続していない独立したテストDBと、テスト専用の鍵を用意する。
2. `.env` の `MONGODB_URI` がテストDBを指していることを確認する。
3. 事前確認（既定は読取専用）を行う。

```sh
npm run personal-data:migrate -- --dry-run
```

4. アプリの住所・電話更新を止め、バックアップを取得し、適用する。

```sh
npm run personal-data:migrate -- --apply --maintenance-confirmed
```

5. 再度dry-runを行い、全コレクションで `legacyFields: 0`、`invalidFields: 0`、`pendingDocuments: 0` を確認する。
6. アプリを起動し、プロフィール・世帯登録／編集・住人管理・役員／班長一覧・年度コピー・申請画面・削除確認を確認する。

### 本番への反映順序（利用者が実施）

1. 新しい暗号化コード・移行コマンドを含むリリースを準備する。
2. 鍵を設定し、バックアップを取得する。バックアップ時点の鍵・バージョンも別に保管する。
3. Herokuのメンテナンスモードを有効にし、Web／Worker等のDBへ書き込むプロセスを停止する。メンテナンスモードだけではバックグラウンド書込は止まらない。
4. 新しいコードをデプロイし、通常のアプリプロセスを停止したまま、一時実行プロセスで移行する。

```sh
heroku run --app YOUR_APP 'npm run personal-data:migrate -- --dry-run'
heroku run --app YOUR_APP 'npm run personal-data:migrate -- --apply --maintenance-confirmed'
heroku run --app YOUR_APP 'npm run personal-data:migrate -- --dry-run'
```

5. 終了コード0と、dry-runの `legacyFields: 0` / `invalidFields: 0` / `pendingDocuments: 0` を確認する。
6. アプリプロセスを再開し、権限あるアカウントで表示・編集を確認してからメンテナンスを解除する。

`--maintenance-confirmed` は実行者が書込停止・バックアップ済みであることを示すフラグで、Herokuの稼働状態を自動確認するものではない。
旧アプリは暗号文を理解しないため、**移行後に旧コードを再起動しない**。旧コードへのロールバックは書込停止のまま移行前バックアップを復元する手順と組み合わせる。新しい書込がある場合は復元による消失を検討する。
新規データがない空DBも、dry-runで既存値を確認してから起動する。

### 再実行・エラー

- 移行は小分けに読み取り、１レコード単位で更新する。中断後は同じコマンドで再開できる。
- 既に暗号化済みの値は検証してスキップし、二重暗号化しない。
- 適用前に全体の読取専用検査を行い、不正な暗号文・不正な型・鍵の不足を検出した場合は書き込まず終了する。
- 適用中も各レコードを検証し、不正な値があるレコードは変更しない。検査・更新の間に状態が変わった可能性があるため、終了コードと適用後検査を必ず確認する。
- 比較更新で、読み取り後に住所・電話が変わったレコードの上書きを避ける。競合は `conflicts` に数え、終了コード1を返す。書込停止を確認して再実行する。
- ログは件数のみ。住所・電話・ID・鍵・接続URLは出力しない。
- 移行は旧バックアップ・メール・添付ファイル内の情報を暗号化しない。旧平文バックアップのアクセス権と保持期限は別途管理する。

## 鍵交換

1. DBと現在／過去の鍵を保管し、書込を停止する。
2. 新しい鍵を生成し、バージョンを変更する（例: `2`）。旧鍵を `PERSONAL_DATA_PREVIOUS_KEYS` に残す。

```dotenv
PERSONAL_DATA_KEY_VERSION=2
PERSONAL_DATA_ENCRYPTION_KEY=<新しい鍵>
PERSONAL_DATA_PREVIOUS_KEYS={"1":"<以前の鍵>"}
```

3. 以下の順で実行する。

```sh
npm run personal-data:migrate -- --dry-run --rotate
npm run personal-data:migrate -- --apply --maintenance-confirmed --rotate
npm run personal-data:migrate -- --dry-run --rotate
```

4. `legacyFields: 0`、`invalidFields: 0`、`pendingDocuments: 0` を確認し、表示・編集を確認する。
5. DBが現在の鍵に移行済みなら、アプリ設定から旧鍵を除くことができる。ただし古いバックアップの復旧用に旧鍵を別途保管する。

暗号文はレコードID・コレクション名に紐付く。同じコレクション名とIDでバックアップを復元する場合、対応する鍵で復号できる。
別コレクションへのコピーやID変更では、元の鍵・文脈で復号してコピー先へ再暗号化する必要がある。

## アプリでの利用と開発上の制約

- 権限・対象町内会の条件は既存ルートで確認する。モデルは読取時に復号するので、ルートから必要範囲のデータだけを取得する。
- `find` / `findOne`、通常ドキュメント、`lean`、`populate`、`select` の結果で住所・電話を復号する。
- `save` / `create`、単一 `_id` を指定した `$set` / `$setOnInsert`、`insertMany`（通常オブジェクト）は保存境界で暗号化する。
- 保存後と保存失敗時に、アプリ内ドキュメントを平文へ戻す。年度コピーは復号済み値を新IDへ再暗号化する。
- 保護項目の検索・並び替え・`distinct`、`_id` を除く取得、更新パイプライン、置換、`aggregate`、`bulkWrite` は拒否する。
- 住所・電話を更新する `updateMany` や単一 `_id` がない更新は拒否する。対象IDごとの対応APIを使う。関連ID・状態だけの複数更新は従来どおり可能。
- `insertMany` の `lean` / `rawResult`、Mongoose Document入力は対応外。平文の通常オブジェクトを渡す。
- `.collection` / 生ドライバーはミドルウェアを迂回する。移行・検証以外のアプリ機能で対象コレクションへ直接書き込まない。将来のMongoose更新時は境界テストを再実行する。

住所を年度設定・役員・班長一覧の検索用属性と検索案内から除いた。氏名・メール・地区／班・役職等の既存の部分一致検索とID絞込を維持する。表示／編集用の住所・電話は権限ある画面で従来どおり表示する。

## 検証コマンド

```sh
npm run test:security
npm run test:personal-data
```

通常の個人情報テストは暗号化・改ざん・鍵管理を検証する。DBテストは既定でスキップする。
実DBテストでは `PERSONAL_DATA_TEST_MONGODB_URI` に**一時的なローカルMongoDB**を指定する。Atlas・プロキシ・ローカル以外は拒否し、ランダム名の専用DBを作成し、終了後にそのDBだけを削除する。本番DB・通常の開発DBを指定しない。
検証内容: 生DB値の暗号化、通常／lean／populate／select、保存再試行、更新・削除、年度コピー、旧データの移行と再実行、対象外データの保持、不正値検出、鍵交換、バックアップ復元。
