# ガイドブック: 別のPCでresource-bridge-cliへ移行する

作成日: 2026-10-08。2026-10-07にdevホストで実施・検証した手順を基にする。

## 1. 対象と移行後の構成

Windows / PowerShell 7で、旧`mcp-resource-subscriber`を使っているレビュー環境を新CLIへ移行する。既存のGateway・thread-owl・review-raven・CLIエージェントが利用できることを前提とする。レビュー基盤を新規構築する手順ではない。

`resource-bridge-cli`は**シェルから実行する外部CLIクライアント**である。MCPサーバーとして登録したり、MCP alias/tool探索で探したりしない。GitHub repo名は`mcp-resource-subscriber`のまま。

今回揃える検証済みの組み合わせは次のとおり。新しい版へ既に移行済みのPCは、ここに合わせてダウングレードせず、その版の移行手順を確認する。

| 対象 | 基準 |
|---|---|
| Node.js | 26.10.0以上。今回の実機検証は26.10.0 |
| 新CLI | `resource-bridge-cli@0.7.0` |
| Mcp-DockerホストCLI | `mcp-docker 2.31.1` |
| reviewer skill | `thread-owl-pr-reviewer` rev 22 |
| reviewed skill | `review-raven-thread-owl-cycle` rev 29 |
| Squirrel Notifier | 0.19.0 |

公開済みの配布元:

- [resource-bridge-cliのnpm package](https://www.npmjs.com/package/resource-bridge-cli)、[v0.7.0の変更内容](https://github.com/scottlz0310/mcp-resource-subscriber/releases/tag/v0.7.0)
- [Mcp-Docker v2.31.1](https://github.com/scottlz0310/Mcp-Docker/releases/tag/v2.31.1)
- [Squirrel Notifier v0.19.0](https://github.com/scottlz0310/squirrel-notifier/releases/tag/v0.19.0)

このPCへの移行でnpm login・npm publish・npm trust・Git tag作成は不要。公開済みの成果物を利用する。

## 2. 実施順序

1. 実行中のreviewer/reviewedがないことを確認し、既存設定と配布物を退避する。
2. Node要件を満たし、新CLIを追加する。旧CLIは残す。
3. Mcp-DockerホストCLIを更新し、使用する各エージェントへskillを再配布する。
4. 共通instruction正本と、そのPCの各CLI入口を確認する。
5. Squirrelを更新し、本人の保存済みコマンドパスを新CLIへ切り替える。
6. 購読と通常の実レビューサイクルを確認し、環境ごとの結果を記録する。

## 3. 事前確認と退避

PowerShellで現在の実行先を確認する。未導入のコマンドは未導入として記録する。

```powershell
node --version
pnpm --version
Get-Command node, pnpm, mcp-resource-subscriber, mcp-docker -ErrorAction SilentlyContinue |
    Select-Object Name, Source
mcp-docker --version
mcp-docker skill status --agent all --skill thread-owl-pr-reviewer,review-raven-thread-owl-cycle
mcp-docker instruction status
```

SquirrelのRecent activityを確認する。状態ファイルがあるPCでは、次も確認する。`concurrency.active = 0`かつ`items`が空になってから更新する。状態ファイルがないだけで、他のCLIセッションのレビューが終了したとは判断しない。

```powershell
$statusPath = Join-Path $env:LOCALAPPDATA 'SquirrelNotifier\review-status.json'
if (Test-Path -LiteralPath $statusPath) {
    $reviewState = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $reviewState | Select-Object concurrency, items | ConvertTo-Json -Depth 5
}
```

Squirrelのトレイメニューから終了する。設定の退避先は、そのPC内の同期・公開されない場所にする。

```powershell
$migrationDir = Join-Path $env:LOCALAPPDATA ('resource-bridge-migration\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $migrationDir -ErrorAction Stop | Out-Null
$settingsPath = Join-Path $env:LOCALAPPDATA 'SquirrelNotifier\settings.json'
if (Test-Path -LiteralPath $settingsPath) {
    Copy-Item -LiteralPath $settingsPath -Destination (Join-Path $migrationDir 'settings-before.json')
}
```

旧mcp-docker.exeの実体と、`instruction status`で表示された**instruction正本**も同じ退避先へコピーする。設定本文には機密情報が含まれ得るため、チャット・GitHub・共有ログへ貼らない。旧CLIの実行パスと版も控える。

## 4. Nodeと新CLI

`node --version`が26.10.0以上なら、Node変更は不要。未満なら、そのPCで使っているNode管理方式で要件を満たす。Windowsのnvmを使うPCの例:

```powershell
# 未インストールの場合だけ実行する
nvm install 26.10.0
# PCの既定Nodeも変わるため、利用者の合意を得て実行する
nvm use 26.10.0
node --version
```

対話シェルだけの一時PATH変更では、Squirrelやログイン時の自動起動に反映されない場合がある。常駐アプリを再起動し、その子プロセスでも要件を満たすことを後で確認する。

既存のpnpm環境を使って新CLIを追加する。

```powershell
pnpm add --global resource-bridge-cli@0.7.0
resource-bridge-cli --version
resource-bridge-cli --help
Get-Command resource-bridge-cli.cmd | Select-Object Source
```

期待表示は`resource-bridge-cli v0.7.0`。別PCではglobal binの場所が異なるため、固定の絶対パスをコピーしない。PATH/global binの解決に失敗したら、先にそのPCのpnpm配置を整える。

旧CLIをアンインストールしない。`MCP_PROBE_*`環境変数、認証cacheの形式・保存先・Gateway originは維持される。Windowsの既定cacheは`%LOCALAPPDATA%\mcp-resource-subscriber\tokens.db`。名称変更だけを理由にDBを移動・削除しない。他PCのtoken DBもコピーしない。

## 5. Mcp-DockerホストCLIとskill

リポジトリの`git pull`だけでは、PATH上のmcp-docker.exeと埋め込みskillは更新されない。Windows版の公開ZIPとchecksumを取得する。以下はGitHub CLI（`gh`）が利用できるPCの例。

```powershell
$dockerAssets = Join-Path $migrationDir 'mcp-docker-v2.31.1'
New-Item -ItemType Directory -Path $dockerAssets | Out-Null
gh release download v2.31.1 --repo scottlz0310/Mcp-Docker `
    --pattern mcp-docker-windows-amd64.zip --pattern checksums.txt --dir $dockerAssets
if ($LASTEXITCODE -ne 0) { throw 'Mcp-Dockerの取得に失敗しました' }
$checksumLine = Get-Content (Join-Path $dockerAssets 'checksums.txt') |
    Where-Object { $_ -match '  mcp-docker-windows-amd64\.zip$' }
if (@($checksumLine).Count -ne 1) { throw 'Windows ZIPのchecksumが一意に見つかりません' }
$expectedHash = ($checksumLine -split '\s+')[0]
$actualHash = (Get-FileHash (Join-Path $dockerAssets 'mcp-docker-windows-amd64.zip') -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'Mcp-Dockerのchecksumが一致しません' }
Expand-Archive -LiteralPath (Join-Path $dockerAssets 'mcp-docker-windows-amd64.zip') `
    -DestinationPath (Join-Path $dockerAssets 'expanded')
& (Join-Path $dockerAssets 'expanded\mcp-docker.exe') --version
```

期待表示は`mcp-docker 2.31.1`。退避済みの、`Get-Command mcp-docker`が指すexeを展開した新版へ置き換える。新規導入なら、本人が使用するPATH内の配置先を選ぶ。配置後に`Get-Command mcp-docker`と`mcp-docker --version`を再確認する。

```powershell
# まず計画だけを確認する。想定外の上書き・巻き戻しがあれば、ここで止める
mcp-docker skill install --agent all --skill thread-owl-pr-reviewer,review-raven-thread-owl-cycle --dry-run
# 計画を確認してから実行する
mcp-docker skill install --agent all --skill thread-owl-pr-reviewer,review-raven-thread-owl-cycle --yes
mcp-docker skill status --agent all --skill thread-owl-pr-reviewer,review-raven-thread-owl-cycle
```

`all`はClaude/Copilot/Codex/Antigravityの全対象。使用先だけなら、例えば`--agent codex,antigravity`に置き換える。dry-runが管理外上書き・巻き戻し・ローカル改変を示した場合は、通常更新として強行せず内容を確認する。

基準版では、使用する各エージェントでreviewer rev 22 / reviewed rev 29・「最新」になることを確認する。配置先のSKILL.mdを直接編集しない。MCPサーバー登録やGateway routeを改名する作業はない。

## 6. 共通instruction

```powershell
mcp-docker instruction status
```

sourceの実体と各CLI入口のリンク先を確認する。Dropbox等で同じ正本を共有しており、既に新名へ更新済みなら、本文の再編集は不要。別正本なら、旧CLIを**実行する指示**だけを次の内容へ整合させる。

> enqueueの直後に、シェルで実行する外部CLIクライアントresource-bridge-cli（v0.7.0以降、Node >=26.10.0）で、小文字のreview://status/owner/repo/prNumberを購読する。MCPサーバー登録・alias/tool探索の対象にせず、同じセッションでJSON結果を受信する。

repo名・GitHub URL・認証cacheパス中の`mcp-resource-subscriber`はそのまま。一括置換しない。ack・URI・最終status・固定HEAD・未解決thread確認の指示も維持する。

正本のリンク配置が未設定のPCだけ、本人の正本パスでconfigureし、dry-runを確認してlinkする。

```powershell
# パスはそのPCの正本に置き換える（抽象例）
mcp-docker instruction configure --source '<path-to-user-instructions.md>'
mcp-docker instruction link --dry-run
mcp-docker instruction link --yes
mcp-docker instruction status
```

既存入口の置換はdry-runの内容を確認して行う。正しいリンクは作り直さない。各エージェントの新しいセッションでinstructionとskillが実際に読まれることも確認する。リンク状態だけでは読込みの証明にならない。

## 7. Squirrel更新と個人設定の切替

[v0.19.0のRelease](https://github.com/scottlz0310/squirrel-notifier/releases/tag/v0.19.0)から次の3ファイルを取得する。GitHub CLIなら:

```powershell
$squirrelAssets = Join-Path $migrationDir 'squirrel-v0.19.0'
New-Item -ItemType Directory -Path $squirrelAssets | Out-Null
gh release download v0.19.0 --repo scottlz0310/squirrel-notifier --dir $squirrelAssets
if ($LASTEXITCODE -ne 0) { throw 'Squirrelの取得に失敗しました' }
$checksumLines = @(Get-Content (Join-Path $squirrelAssets 'checksums-x64.txt'))
if ($checksumLines.Count -ne 2) { throw 'MSIとZIPの2件のchecksumが必要です' }
$seenAssets = @{}
foreach ($line in $checksumLines) {
    if ($line -notmatch '^([A-Fa-f0-9]{64})  (SquirrelNotifier-Setup-0\.19\.0-x64\.(msi|zip))$') {
        throw 'checksumの対象または形式が想定と異なります'
    }
    $expectedHash = $Matches[1]
    $assetName = $Matches[2]
    if ($seenAssets.ContainsKey($assetName)) { throw 'checksumの対象が重複しています' }
    $seenAssets[$assetName] = $true
    $actualHash = (Get-FileHash (Join-Path $squirrelAssets $assetName) -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) { throw "checksumが一致しません: $assetName" }
}
```

対象は`SquirrelNotifier-Setup-0.19.0-x64.msi`、同名の`.zip`、`checksums-x64.txt`。checksumにMSI/ZIPの両方があることを確認する。exeの基準ProductVersionは`0.19.0+d698255c690ec8f258a9d1f2df1a16d2278a9218`。

1. reviewer/reviewedが終了済みで、Squirrelをトレイメニューから終了したことを再確認する。
2. MSIで通常の更新インストールを行う。既存のZIP配置を使っているPCは、その配置方式を維持してZIPから更新する。両方式を重複導入しない。
3. アプリを起動し、Settings → Command Pathを、手順4で確認した**そのPCのresource-bridge-cli.cmd絶対パス**へ変更する。新規設定の既定値は新名だが、保存済み旧CLI名・絶対パス・カスタムパスは自動更新されない。
4. Gateway URL、Resource URI、追加引数、タイムアウト、launcher/model設定等は維持する。通常のqueue URIは既存の設定値を使用する。
5. 購読を再開する。必要ならアプリを再起動して、新Node環境で起動させる。

MSIの標準配置は`%LOCALAPPDATA%\Programs\SquirrelNotifier\SquirrelNotifier.WinUI3.exe`。既存の自動起動タスクが正しいexeと`--tray`を指すことを確認する。タスクがない場合は、アプリの設定または同版ZIPのinstall手順で登録する。

## 8. 接続と実レビューの確認

そのPCで既存cacheが使えれば再ログイン不要。`AUTH_LOGIN_REQUIRED`になった場合だけ、そのPCの正しいGateway MCP URLへ対話ログインする。

```powershell
resource-bridge-cli --login --url '<そのPCのGatewayのMCP URL>'
```

URLは既存設定から確認し、localhost・ホスト名・証明書設定を別PCから推測でコピーしない。token値・OAuth応答・cookieは記録しない。

Squirrelの確認項目:

- 起動exeのProductVersionが対象版/SHAと一致する。
- `%LOCALAPPDATA%\SquirrelNotifier\review-status.json`の`app.version = 0.19.0`、`subscription.state = running`。
- 新CLIの子nodeプロセスがNode >=26.10.0で起動する。
- 保存済み設定の変更はCommand Pathだけで、他の設定と旧cacheは保持される。
- UIでは購読中のStopButtonが有効。StatusTextの文言だけで成否を決めない。

次の通常PRで実レビューを一周させる。既に完了したPRへただ購読しても新通知がなくtimeoutになる場合があるため、移行確認のためだけに完了PRを再enqueueしない。

実装側は現行skillに従い、対象HEADを固定してenqueueを1回行い、直後に新CLIで購読する。URLは実環境から解決する。例のowner/repoは小文字に置き換える。

```powershell
resource-bridge-cli --url '<thread-owlのMCP URL>' `
    --uri 'review://status/<owner>/<repo>/<prNumber>' `
    --timeout-ms 1200000 --json
```

CLIの既定タイムアウトは15秒なので、レビュー待機では20分を明示する。動的URIでlist確認を省く必要がある環境だけ、現行設定に従って`--skip-resource-list-check`を追加する。購読URIは必須で、暗黙のtest URIはない。

queue登録とreviewer起動は別操作。Squirrelの自動起動記録、または「レビューする」からの独立reviewer起動を確認する。実装側で自己レビューしない。

結果JSONを**同じ実装セッションで受信**し、`listenAcknowledged = true`、`honoredUris`、`resourceUri`、最終status、owner/repo/PR、期待HEADと現在HEADの一致を確認する。その後、未解決threadと独立Verdict・同一HEAD CIを取得する。CLI exit 0やstatus=reviewedだけでapprove・マージ可能とは判断しない。

timeout・URI/HEAD不一致・認証失敗は完了扱いにしない。原因とSquirrelの保留理由を確認し、再購読の可否は配布済みskillのreview-wait手順に従う。再enqueueを繰り返したり、LLMの反復ポーリングへ戻したりしない。

## 9. 切り戻し

1. 実行中のレビューが終わってからSquirrelを停止する。
2. 新CLI固有の接続問題なら、Command Pathを控えてある旧CLIパスへ戻して購読を確認する。共通cacheは初期化しない。
3. instruction変更が原因なら、正本の差分を確認して戻す。共有正本の復元は他PCにも影響するため、他PCの移行状況も確認する。
4. skillまで戻す必要がある場合は、退避した旧mcp-docker.exeを使い、対象skillのdry-runを確認して旧内容を再配布する。旧バイナリの差し替えだけでは配置済みskillは戻らない。新revisionからの巻き戻しには明示確認が必要で、対象を確認してから実行する。
5. 新版Squirrel本体の問題は、旧配布物と設定backupを保持して切り戻しを判断する。MSIのdowngradeは拒否され得るため、設定を退避せずアンインストールや上書きを強行しない。

成功確認と利用者の許可が揃うまで、旧CLI・旧exe・設定backupを削除しない。

## 10. 完了記録

PCごとに次を記録し、各CLI/モデルを未検証のまま一括で成功扱いにしない。

| 項目 | 記録する内容 |
|---|---|
| 環境 | PC識別名、OS、Node版、実行パス |
| 配布 | 新CLI/Mcp-Docker/Squirrel版、agentごとのskill revision |
| 指示 | 正本の場所、各CLIのリンクと実際の読込み |
| 実レビュー | agent/model、対象PR/HEAD、enqueue reason、独立reviewer起動経路 |
| 配送 | 同じセッションでのack/URI/status/HEAD一致、thread取得、成否 |
| 復旧 | 問題・保留理由、切り戻しの有無、backup場所 |

関連する参照:

- [CLI移行仕様（本リポジトリ）](../cli-migration.md)
- [Mcp-Docker リポジトリ](https://github.com/scottlz0310/Mcp-Docker)
- [Squirrel Notifier リポジトリ](https://github.com/scottlz0310/squirrel-notifier)
- [resource-bridge-cli npm package](https://www.npmjs.com/package/resource-bridge-cli)
