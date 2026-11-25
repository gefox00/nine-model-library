# MCPでライブラリを使う

MCPクライアントから、Nine print model hubの登録モデルを検索し、メタデータ、OpenSCADプリセット、キャッシュ済みサムネイルを取得できます。サーバーはクライアントが起動するローカルの **stdio** 子プロセスです。通常のアプリとは別に動き、SQLiteを読み取り専用で開きます。

## Windows配布版から接続

stdio対応クライアントに、次の内容を登録します。`<APP_FOLDER>` は展開した `win-unpacked` フォルダの絶対パスに置き換えてください。`mcpServers` の書式を採用していないクライアントでは、同じ実行ファイル、引数、環境変数を各設定欄に入れます。

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

この起動設定はMCPサーバープロセスに対して使います。通常のデスクトップアプリは従来どおり `起動.cmd` から起動できます。

## ソースから接続

Node.js 24以降でリポジトリの `npm ci` を実行してから、クライアントの `command` に `node` またはNodeの実行ファイルの絶対パス、`args` に `<REPOSITORY>/electron/mcp-server.cjs` の絶対パスを指定します。引数一覧はリポジトリで `node electron/mcp-server.cjs --help` を実行すると表示できます。

どちらの接続方法も、通常はWindowsのユーザーデータ領域にある従来の `Nine Model Library/library.sqlite3` を使います。v0.6.0以降で作成した既存ライブラリに対応します。別のライブラリを使うときは、引数に `--database` とSQLiteファイルのパスを追加します。アプリの `NINE_DATA_DIR` を使う構成では、クライアントの環境変数にも同じディレクトリを指定できます。

## ツール

| ツール | 引数と動作 |
| --- | --- |
| `search_models` | `query` で名前・タグを部分一致検索。`format`、`missing`、`favorite` で絞り込み。モデルIDやサイズ、更新日時を取得。 |
| `get_model` | 検索で得た `id` の詳細を取得。`includePath`、`includeNotes` は起動時の追加許可が必要。 |
| `list_scad_presets` | SCADモデルの `id` に保存されたプリセットの名前とパラメータ上書き値を取得。 |
| `get_thumbnail` | `id` のキャッシュ済み画像をMCPの画像コンテンツとして取得。画像が未生成の場合は `found: false`。 |

検索とプリセット一覧は `limit`（既定20、最大50）と `offset` に対応します。続きがある場合は応答の `nextOffset` を次の `offset` に指定します。例えば「お気に入りのSCADを探して、候補のプリセットを比べて」なら、各候補のモデルIDをそのままプリセット一覧に渡せます。

元ファイルへの絶対パスとメモを使うクライアントでは、起動引数に `--allow-private-metadata` を追加します。その場合も `get_model` で `includePath: true` または `includeNotes: true` と指定した項目だけが返ります。ファイル名・タグ・プリセット・画像もクライアントへ渡るデータです。接続するクライアント側の処理先を確認して使ってください。

MCPではライブラリの登録・更新・削除、元ファイルの読み込み、サムネイル生成、スライス、印刷送信を公開していません。SQLiteのWALモードでは、読み取り専用接続でもユーザーデータディレクトリや補助ファイルへのアクセスが必要になる場合があります。
