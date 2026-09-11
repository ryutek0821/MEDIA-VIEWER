# MARIN 評価ビューア

`~/ClaudeCode/PROJECT-MARIN/output` に届いた画像・動画を、Tailnet 内の端末（iPhone 含む）のブラウザで表示し、✕ バツ / ◯ マル / △ 保留 の3段階で評価するアプリです。

- 評価は MacBook Pro 上の SQLite に保存され、どの端末から評価しても同じ結果になります。
- 画像はファイル内容の SHA-256 で識別します。ファイル名の変更や移動後も評価が引き継がれ、別の場所にあるファイルとも照合できます。
- 元ファイルは読み取るだけで、移動・削除・変更はしません。

## アクセス

```text
https://ryu-macbookpro.tail93b3c7.ts.net:8445/
```

Tailnet に参加している端末からだけ開けます（Tailscale Serve、tailnet only）。MacBook Pro のスリープ中は表示できません。

## 操作

| 評価 | スワイプ | キー | ボタン |
| --- | --- | --- | --- |
| ✕ バツ | 左 | ← | バツ |
| △ 保留 | 上 | ↓ | 保留 |
| ◯ マル | 右 | → | マル |
| 取り消し | — | Backspace / ⌘Z | 取り消し |

- 画面上部の切り替えで「未評価」「保留を見直す」「すべて（評価し直し）」を選べます。
- 新しいファイルは30秒ごとに確認します。書き込み途中のファイルを避けるため、更新から60秒経つまで表示しません。
- 対応形式: JPG / PNG / WebP / GIF / AVIF / MP4 / WebM / M4V / OGV。ドットで始まるファイルとシンボリックリンクは対象外です。

## 評価データと照合

データベース: `~/Library/Application Support/Media Viewer/ratings.sqlite3`

| テーブル | 内容 |
| --- | --- |
| `media` | 見つけたファイルごとの相対パス、SHA-256、種類、サイズ、更新日時、PNG に埋め込まれた ComfyUI の `prompt`、消えたかどうか（`missing`） |
| `ratings` | SHA-256 ごとの現在の評価（`reject` / `keep` / `hold`）、評価日時、評価者（Tailscale ログイン） |
| `rating_events` | 評価・取り消しの全履歴（追記のみ） |

書き出し（1ファイルパス1行、消えたファイルも含む）:

- ブラウザ: 画面右上の「CSV」、または `/api/export.csv`・`/api/export.jsonl`
- コマンド: `npm run export -- csv > ratings.csv`（`jsonl` も可）

照合の例:

```bash
# 手元の画像の評価を調べる
sha=$(shasum -a 256 some.png | cut -d' ' -f1)
sqlite3 ~/Library/Application\ Support/Media\ Viewer/ratings.sqlite3 \
  "SELECT rating, updated_at FROM ratings WHERE sha256 = '$sha';"

# マルを付けた画像とそのプロンプト
sqlite3 ~/Library/Application\ Support/Media\ Viewer/ratings.sqlite3 \
  "SELECT m.rel_path, m.prompt_json FROM ratings r JOIN media m USING (sha256) WHERE r.rating = 'keep' AND m.missing = 0;"
```

## 常駐（launchd + Tailscale Serve）

サーバーは `127.0.0.1:8792` だけで待ち受け、Tailscale Serve が Tailnet 向けに HTTPS で公開します。

```bash
npm ci && npm run build
mkdir -p ~/Library/Logs/MediaViewer
cp deploy/com.ryuheitakeda.media-viewer.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ryuheitakeda.media-viewer.plist
tailscale serve --bg --https=8445 http://127.0.0.1:8792
```

```bash
# 状態・ログ
launchctl print gui/$(id -u)/com.ryuheitakeda.media-viewer
tail -f ~/Library/Logs/MediaViewer/server-error.log

# 更新を反映（ビルド後に再起動）
npm run build && launchctl kickstart -k gui/$(id -u)/com.ryuheitakeda.media-viewer

# 停止（評価データは残ります）
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ryuheitakeda.media-viewer.plist
tailscale serve --https=8445 off
```

## 設定

| 環境変数 | 既定値 |
| --- | --- |
| `MEDIA_ROOT` | `~/ClaudeCode/PROJECT-MARIN/output` |
| `DATA_DIR` | `~/Library/Application Support/Media Viewer` |
| `HOST` / `PORT` | `127.0.0.1` / `8792` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]`（launchd 設定では Tailnet のホスト名を追加。これ以外の Host ヘッダーは DNS リバインディング対策で拒否） |
| `DIST_DIR` | リポジトリの `dist` |

## 開発

Node.js 24 以降（TypeScript を直接実行し、組み込みの `node:sqlite` を使います）。

```bash
npm install
# 本番データに触れないよう、別のフォルダとDBを指定して起動
MEDIA_ROOT=/tmp/media-sample DATA_DIR=/tmp/media-viewer-data PORT=8793 npm run dev:server
PORT=8793 npm run dev:client   # Vite が /api と /media をサーバーへ中継

npm test        # ユニットテスト + 型チェック + ビルド
npm run lint
```
