# リリースの準備と公開

prepare / publish / finalize は release-automate の同じ固定 SHA を使う。
公開 CLI の版の正本は package.json で、fixture サーバーもそこから版を読む。

1. 利用者の版指定後、main の `Prepare Release` に先頭の v を除いた版を指定する。
   npm 戦略は通常版・RC を受け付け、metadata は版が失われるため更新前に拒否する。
2. Release bot が作成する準備 PR の原稿・比較リンク・同一 HEAD CI・独立レビュー・未解決0を確認する。
   版・対象コミット・内容の公開許可後に `chore(release): vX.Y.Z` で squash merge する。
3. トリガー SHA のタグと draft を作成し、同じ SHA で frozen install、check/build/typecheck/test、pack を実行する。
4. 配布 tarball に CLI があり fixture がないこと、展開した CLI の `--version` が
   package.json/タグと一致することを確認する。
5. **従来と同じ publish.yml の通常 job** から npm の OIDC Trusted Publishing で
   その tarball を公開する。再利用 workflow 内に npm publish を移さず、workflow ファイル名を維持する。
   通常版は latest、RC は next に公開する。新しい npm token や外部登録の変更は要求しない。
6. registry の当該版から tarball を再取得し、同じ run が生成した tarball との byte 一致と
   provenance URL の存在を確認する。provenance の暗号検証を実施したという意味ではない。
7. 検証成功後だけ GitHub Release を finalize し、共通書式で対象 SHA・run・依存ジョブの成功を追記する。
   原稿は CHANGELOG で、自動生成の What's Changed は併記しない。

`Publish` の手動実行は、回復用入力を指定しなければ build/test のみで公開しない。通常の導入 PR のマージでも公開しない。

公開コマンド失敗後の復旧では、まず npm の対象版が未公開であることと GitHub Release が draft であることを確認する。利用者が対象版の公開を許可した後、既定ブランチから `Publish` を手動実行し、`recovery_tag` にタグ（例: `v0.9.0`）、`recovery_sha` にそのタグの40桁コミット SHA を指定する。両方が空の場合は従来どおり非公開の検証だけを行う。回復時は draft・タグと SHA・既定ブランチ履歴・npm 未公開を確認してから、対象 SHA のビルド、同じ workflow からの OIDC 公開、tarball 再取得・比較、provenance の存在確認、finalize を行う。registry エラー、既公開、SHA 不一致は停止する。タグの付け替えや別版の自動採番は行わない。
prepare は Organization の RELEASE_BOT_CLIENT_ID/PRIVATE_KEY、GitHub Release は GITHUB_TOKEN、
npm は従来の id-token: write を使う。

npm への公開が成功して再取得検証だけが失敗した場合は、原因を確認して同じ run の failed jobs を再実行する。
公開コマンド自体が失敗した場合は registry の状態も確認し、公開済みなのに未公開として扱わない。
すでに成功した npm job を含む全 job の再実行や、別版での自動再試行は行わない。
GitHub 公開後の本文追記だけが失敗した場合は failed finalize を再実行する。
初回の実公開では OIDC の成功、registry の版/配布物/provenance、GitHub のタグ SHA/公開状態/本文を確認する。

参照: [npm Trusted Publishing の workflow ファイル名の契約](https://docs.npmjs.com/trusted-publishers/)。
2026-10-26 の公開 attestation の読み取りでは resource-bridge-cli v0.8.0 の公開元が
`.github/workflows/publish.yml` だった。npm 側の現在の登録画面や移行後の実認証は別の確認である。
