# MCPでライブラリを使う

MCPクライアントから Nine print model hub の登録モデルを検索し、メタデータ、OpenSCADプリセット、保存済みサムネイルを取得できます。クライアントがローカルの **stdio** 子プロセスを起動し、各ツール呼び出しでSQLiteを読み取り専用で開きます。デスクトップアプリは起動中でも終了中でも使えます。最初に一度アプリを開いてライブラリを作成してください。

このガイドはv0.9.1の読み取り専用インターフェイスを説明します。v1.0で予定するファイルコピー、STL出力、ベッドに並べた3MF出力と、操作ごとの確認手順は [ロードマップ](roadmap.md#エージェント向けのライブラリ操作) に記載しています。

## Windows配布版から接続

stdio対応クライアントに、次の内容を登録します。`<APP_FOLDER>` は配布版の `win-unpacked` フォルダの絶対パスに置き換えます。`mcpServers` の形式を使わないクライアントでは、実行ファイル、引数、環境変数を各設定欄に入力します。

```json
{
  "mcpServers": {
    "nine-model-library": {
      "command": "<APP_FOLDER>/Nine print model hub.exe",
      "args": ["<APP_FOLDER>/resources/app.asar/electron/mcp-server.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE` はクライアントが起動するMCPプロセスに指定します。デスクトップアプリは `起動.cmd` または配布版の実行ファイルから開きます。

## ソースから接続

Node.js 24以降を使います。リポジトリで `npm ci` を実行したあと、クライアントの `command` に `node` またはNode.jsの実行ファイルの絶対パスを指定します。`args` の最初の要素に `<REPOSITORY>/electron/mcp-server.cjs` の絶対パスを入れます。オプションはリポジトリ直下の `node electron/mcp-server.cjs --help` で確認できます。

## 接続先のライブラリ

次の順でデータベースを選びます。

1. 引数の `--database` に続けて指定したSQLiteファイル。
2. MCPプロセスの `NINE_DATA_DIR` が指すフォルダ内の `library.sqlite3`。アプリと同じフォルダを指定すると同じライブラリを読めます。
3. Windowsの既定データベース `%APPDATA%/Nine Model Library/library.sqlite3`。

スキーマ1と2を読み取れます。データベースが見つからない場合、ツール呼び出しにエラーが返ります。アプリを開いてデータベースを作るか、クライアントの接続先を確認してください。WALを使用するSQLiteでは、読み取り接続にも同じフォルダにある補助ファイルへのアクセスが必要になる場合があります。

## ツール

| ツール | 引数と動作 |
| --- | --- |
| `search_models` | `query` でモデル名・タグを大文字小文字を区別せず部分一致検索。`format`（`stl`、`step`、`3mf`、`scad`）、`missing`、`favorite` で絞り込み。STPは `step` に含めます。結果は更新日時の新しい順で、モデルIDやサイズ、タグ、サムネイルの有無を含みます。 |
| `get_model` | 検索で得た `id` の詳細を `model` に返します。登録が見つからない場合は `model: null`。`includePath` と `includeNotes` には起動時の追加許可が必要です。 |
| `list_scad_presets` | SCADモデルの `id` に保存されたプリセットの名前と上書き値 `values` を返します。`values` に含まれないパラメータにはモデルの既定値が適用されます。 |
| `get_thumbnail` | `id` の保存済みPNG・JPEG・WebP画像をMCPの画像コンテンツとして取得します。取得できる保存画像がない場合は `found: false`。 |

検索とプリセット一覧は `limit`（既定20、最大50）と `offset` に対応します。初回は `offset` を省略し、続きがある場合は応答の `nextOffset` を指定します。`nextOffset: null` が最後のページです。例えば `search_models` に `{ "format": "scad", "favorite": true }` を渡すと、お気に入りのSCADを取得できます。候補の `id` を `list_scad_presets` に渡すとプリセットを比較できます。

## 共有するデータと権限

元ファイルへの絶対パスとメモをクライアントに渡す場合は、起動引数に `--allow-private-metadata` を加えます。そのうえで `get_model` の `includePath: true` または `includeNotes: true` を指定した項目が返ります。通常のツール呼び出しでも、ファイル名、タグ、プリセット、画像はクライアントへ渡ります。クライアントが送信・保存するデータの範囲を確認してください。

登録・編集・削除、元ファイルの読み込み、画像生成、スライスや印刷送信はデスクトップ側の操作です。接続先や追加許可を設定するファイルはローカルに保持してください。

## 開発時の検証

ソース版ではリポジトリ直下で次のコマンドを実行します。

```powershell
node --test tests/mcp-catalog.test.cjs tests/mcp-server.test.cjs
```

配布版のstdio接続は `npm run package` のあと、テスト用シェルで次のコマンドを実行します。両方の検証がテスト用のSQLiteを使います。

```powershell
$env:NINE_MCP_PACKAGED_DIR = 'release/win-unpacked'
node --test tests/mcp-server.test.cjs
```
