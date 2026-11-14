# recalm

Overwatch の試合後に、行動のレベルで振り返りを手入力するための記録アプリです。

- 記録は手入力だけです。ゲームのデータや画面には触れません。
- 記録はこのブラウザの IndexedDB にだけ保存されます。外部には送信しません。
- Blizzard のマップ・ヒーロー画像は含みません。

## 使い方

ビルドは不要です。`index.html` を直接開くと `data/master.json` を読み込めないので、フォルダでローカルサーバーを起動します。

```bash
python -m http.server 8000
```

`http://localhost:8000/` を開きます。

| 画面 | 内容 |
| --- | --- |
| 記録 | モード・ロール・マッチの質・マップ・ヒーローを選び、Victory / Defeat で保存 |
| 履歴 | 1日ずつの試合の一覧。振り返りの追記・編集・削除 |
| 集計 | 改善点記入率(負けた試合)、時間帯別の勝率 |
| 設定 | お気に入りヒーロー、バックアップ |

## バックアップ

ブラウザのサイトデータを消すと、記録も消えます。設定画面の「バックアップ」から JSON に書き出せます。

- 書き出したファイル(`recalm-backup-*.json`)は個人の記録です。このリポジトリにはコミットしません(`.gitignore` 済み)。
- 読み込むと、いまの記録をすべて置き換えます。実行前に確認が出ます。
- データはオリジン(URL とポート)ごとに別々です。`localhost:8000` と別のポートや公開URLの記録は、バックアップで移します。

## マップ・ヒーローの更新

`data/master.json` を直します。アプリ内の編集画面はありません。

## テスト

```bash
npm test
```

## 権利表記

本アプリケーションは個人が開発した非公式・非商用のファンアプリであり、Blizzard Entertainment 社とは一切関係ありません。
Overwatch をはじめとするゲームタイトル、および関連するすべての商標・知的財産は、Blizzard Entertainment, Inc. に帰属します。

This is an unofficial, non-commercial fan project and is not affiliated with or endorsed by Blizzard Entertainment, Inc.
Overwatch and all related properties are trademarks or registered trademarks of Blizzard Entertainment, Inc.
