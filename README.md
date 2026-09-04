# メディア仕分け

画像と動画を「いる・いらない」に素早く仕分け、結果をCSVへ保存するローカルWebアプリです。メディアは外部へ送信されず、元ファイルの移動・削除・変更も行いません。

## 起動方法

必要環境は Node.js 22.13以降と、Google ChromeまたはMicrosoft Edgeです。

```bash
npm install
npm run dev
```

表示された `http://localhost:3000/` をChromeまたはEdgeで開きます。

## 使い方

1. サブフォルダの対象範囲と表示順を選びます。
2. 「フォルダを選ぶ」から、仕分けるフォルダへの読み書きを許可します。
3. 左スワイプまたは左キーで「いらない」、右スワイプまたは右キーで「いる」を選びます。
4. 全件完了すると、選択フォルダ直下に `media-decisions-日時.csv` が保存されます。

途中経過はブラウザ内へ自動保存されます。同じフォルダを再選択すると続きから再開できます。保存されるのはファイル情報と判定だけで、画像・動画本体は保存されません。

## 対応形式

- 画像: JPG、JPEG、PNG、WebP、GIF、AVIF
- 動画: MP4、WebM、M4V、OGV

HEIC、RAW、HEVC/MOVは対象外です。対応拡張子でもブラウザがコーデックを再生できない場合は、ファイル名を確認して判定できます。

## 確認コマンド

```bash
npm test
npm run lint
```

## Tailnet版

Raspberry Pi上のDockerコンテナをTailscale Serve経由で公開します。LANやインターネットにはポートを公開せず、Tailnet参加端末からだけHTTPSでアクセスできます。

```text
https://ryu-raspberrypi.tail93b3c7.ts.net:8445/
```

ブラウザで選択する画像・動画は、アクセス元端末のローカルファイルです。ファイル本体がRaspberry Piへ送信されることはありません。
