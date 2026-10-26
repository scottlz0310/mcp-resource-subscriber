# MCP Resource Subscription Compatibility - Codex Desktop / CLI

## English Summary

- Verification date: 2026-05-12
- Client under test: Codex Desktop / Codex CLI 0.130.0
- Native Codex MCP surface reached Level 3: `resources/list` and `resources/read` work, but no agent-visible generic `resources/subscribe` operation is exposed.
- Agent-driven SDK workaround reached Level 7: with shell, Node.js, local dependencies, and localhost network access, the agent can run a separate MCP SDK client, subscribe to `test://review/status`, receive `notifications/resources/updated`, and re-read `version=2`.
- This should be recorded as two separate capabilities, not as unconditional native Codex Level 7 support.

## 概要

- 検証日: 2026-05-12
- 対象クライアント: Codex Desktop / Codex CLI
- Codex CLI version: 0.130.0
- この Desktop セッションの model: gpt-5.5
- OS / shell: Microsoft Windows NT 10.0.26200.0 / PowerShell 7.6.1
- Workspace: `<repo-root>`
- MCP endpoint: `http://127.0.0.1:8089/mcp`
- サーバ起動方法: 元の Desktop セッションでは `npm install` 後に `npm run dev`。後続の CLI 再確認では Docker Compose で起動した同じ endpoint を使用。

今回の結論は、単純に「Codex が Level 7 対応」とは書けない。
Codex の正式な組み込み MCP 操作面と、agent が shell / Node.js / MCP SDK を使って実質的に到達できる操作面を分けて評価する必要がある。

```text
Codex CLI/Desktop native MCP surface: Level 3
Codex agent-driven SDK client workaround: Level 7
```

## 環境について

このセッションは cloud sandbox workspace ではなく、ローカル Windows ホスト上の Codex Desktop 実行環境だった。

観測値:

```text
USERNAME=<username>
COMPUTERNAME=<host>
PROCESSOR_ARCHITECTURE=AMD64
OS=Microsoft Windows NT 10.0.26200.0
```

Codex 側の設定:

```text
sandbox_mode = "danger-full-access"
approval_policy = "never"
[windows]
sandbox = "elevated"
```

つまり、モデル自体はリモートサービス上で動作しているが、filesystem / shell / localhost network への実行権限はこのローカル Windows 環境にある。
今回の検証ではこの点が重要で、agent は許可された shell 実行を使って別の MCP client を起動できた。

## 設定

`%USERPROFILE%\.codex\config.toml` に以下を追加した。

```toml
[mcp_servers.subscribe-probe]
url = "http://127.0.0.1:8089/mcp"
```

`codex mcp list` では次のように表示された。

```text
subscribe-probe  http://127.0.0.1:8089/mcp  enabled  Unsupported
```

ただし、この設定は既に起動済みの Codex Desktop セッションには hot-load されなかった。

## 評価軸

今回の結果は、次の 2 つの能力を分けて扱う。

| 分類                 | 意味                                                                    | 今回の Codex |
| -------------------- | ----------------------------------------------------------------------- | ------------ |
| Native capability    | Codex 本体が正式に agent へ公開している MCP 操作面で到達できる機能      | Level 3      |
| Effective capability | 許可済みの shell / SDK / network を使い、agent が実質的に実現できる機能 | Level 7      |

この区別をしないと、結果を誤読する。

Native capability のアクセス経路:

```text
Codex built-in MCP client
  -> list_mcp_resources
  -> read_mcp_resource
  -> resources/subscribe は未公開
```

Effective capability のアクセス経路:

```text
Codex agent
  -> shell 実行
  -> Node.js / MCP SDK client 起動
  -> localhost の MCP server へ接続
  -> resources/subscribe を直接呼ぶ
```

これは Codex の built-in MCP surface に `resources/subscribe` が公開されていたという意味ではない。
より正確には、agent が MCP プロトコルを理解し、許可された実行環境を使って別 MCP client を構成し、抽象化レイヤーを迂回した、という結果である。

## Active Desktop Session

現在の既に起動済み Desktop thread では、設定追加後も `subscribe-probe` は MCP server として認識されなかった。

- Result level: `0 - no connection`
- `resources/list`: NO
- `resources/read`: NO
- `resources/subscribe`: NO
- `notifications/resources/updated` への反応: NO
- 更新後の再 read: NO

観測結果:

```text
list_mcp_resources -> desktop-commander の resource のみ
list_mcp_resources(server="subscribe-probe") -> unknown MCP server 'subscribe-probe'
```

この段階では server log に、この Desktop thread からの `[initialize]` は出ていない。

解釈:

- Codex Desktop のこの実行中セッションは、`config.toml` の MCP server 追加を hot-load しなかった。
- したがって、この thread では native MCP surface の検証自体が開始できなかった。
- 新しい Codex セッションを起動すると、同じ設定は読み込まれた。

## New Codex CLI Session - Native MCP Surface

同じ設定を使って新規 `codex exec` セッションを起動すると、`subscribe-probe` は読み込まれた。

- Result level: `3 - read initial resource`
- `resources/list`: YES
- `resources/read`: YES, `version=1`
- `resources/subscribe`: NO
- agent に公開された first-class subscribe tool: NO

server log:

```text
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
```

この時点で確認できたこと:

- Codex CLI 0.130.0 の built-in MCP client は Streamable HTTP MCP server に接続できる。
- `resources/list` と `resources/read` は agent-visible な MCP resource tool として使える。
- しかし、generic な `resources/subscribe` を呼ぶ agent-visible primitive は提供されていない。
- そのため、native MCP surface としては Level 3 止まり。

## New Codex CLI Session - SDK Workaround

同じ新規 `codex exec` セッション内で、agent は shell 実行を使って Node.js MCP SDK client を起動した。
この SDK client は Codex built-in MCP client ではなく、agent が実行環境上で別途構成した protocol client である。

- Result level: `7 - agent context updated`
- `resources/subscribe`: YES
- `notifications/resources/updated`: YES
- 更新通知後の `resources/read`: YES
- final content: `status: reviewed`, `version: 2`

server log:

```text
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
[resources/subscribe] uri=test://review/status
[resource/update] uri=test://review/status version=2
[notification/send] notifications/resources/updated uri=test://review/status
[resources/read] uri=test://review/status version=2
[resources/unsubscribe] uri=test://review/status
```

SDK output:

```text
capabilities {"subscribe":true,"listChanged":true}
resource-found true
initial
status: pending
version: 1
message: Waiting for simulated review result.
notification test://review/status
final
status: reviewed
version: 2
message: Simulated review result is now available.
```

この結果は server 側の実装が正しく `resources/subscribe` / `notifications/resources/updated` / post-notification read のフローを処理できることを示している。
ただし、Codex の native MCP resource 操作面が `resources/subscribe` を公開している証拠ではない。

## 重要な分類

今回の結果は「セキュリティ境界を破った」というより、「抽象化レイヤーを迂回した」と分類するのが正確。

許可されていたもの:

```text
- shell 実行
- npm / node 実行
- localhost への network 接続
- リポジトリ内 node_modules の利用
- 一時的な protocol client の起動
```

未公開だったもの:

```text
- Codex built-in MCP surface の resources/subscribe
```

結果:

```text
- native MCP surface からは subscribe に到達できない
- shell + SDK を使うと agent は subscribe に到達できる
```

したがって、評価表では次のように分けて記録するべき。

```text
Codex CLI/Desktop native MCP surface: Level 3
Codex agent-driven SDK client workaround: Level 7
```

単に `Codex: Level 7` と書くと、Codex 本体が generic MCP resource subscription を正式サポートしているように読めてしまうため不正確。

## 権限モデル上の示唆

今回の検証から得られる設計上の教訓は以下。

```text
agent に汎用 shell 実行を渡している時点で、
個別 tool surface の非公開は強い制限ではない。
```

`resources/subscribe` を built-in MCP tool surface から隠していても、ローカルで強い shell 権限を持つ agent は、自前の MCP client を起動して protocol method を直接呼べる。

これは必ずしも悪い挙動ではない。
今回の環境では、shell 実行、Node.js 実行、localhost 接続がすべて許可されていた。
その許可範囲の中で agent が MCP SDK を使っただけであり、外部の認可境界を破ったわけではない。

一方で、MCP tool surface を capability boundary と見なす設計では注意が必要。
強権限 agent に shell と network を渡す場合、MCP client が公開していない操作でも、protocol client を自作できるなら実効的には到達可能になる。

## 結論

Codex CLI / Desktop の native MCP surface は、今回の検証対象 server に対して `resources/list` と `resources/read` までは到達した。
しかし、generic `resources/subscribe` は agent-visible な built-in operation として公開されていないため、native capability は Level 3 と評価する。

一方で、shell 実行が許可された Codex agent は Node.js MCP SDK client を起動し、同じ server に対して `resources/subscribe` を直接呼び、更新通知を受け取り、更新後 resource を再 read できた。
この effective capability は Level 7 と評価できる。

最終評価:

| 経路                                          | Level | 説明                                                                     |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| Active Codex Desktop thread after config edit | 0     | 実行中 thread は MCP server 追加を hot-load しなかった                   |
| New Codex CLI native MCP surface              | 3     | `resources/list` / `resources/read` まで。`resources/subscribe` は未公開 |
| Agent-driven Node.js MCP SDK workaround       | 7     | shell + SDK により protocol-level subscribe と通知後再 read に成功       |
