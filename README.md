# CLIVA LINE Webhookサーバー

LINE公式アカウントと連携し、患者からの予約をLINE上で受け付けるWebhookサーバーです。

## 会話フロー

1. 診療科を選択（クイックリプライ）
2. 日時を選択（クイックリプライ、直近3日×4枠）
3. お名前を入力
4. 電話番号を入力
5. 症状・相談内容を入力
6. 予約確定 → 予約番号を発行してデータベースに保存

## セットアップ手順

### 1. Supabaseプロジェクトを作成

1. [supabase.com](https://supabase.com/) でアカウント作成・新規プロジェクト作成
2. 「SQL Editor」で `schema.sql` の内容を実行
3. 「Project Settings」→「API」から `Project URL` と `service_role` キーを控える

### 2. 環境変数を設定

`.env.example` を `.env` にコピーし、以下を埋める。

- `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`：LINE Developersコンソールで取得（別途お渡し済みの「LINE公式アカウント開設・初期設定ガイド」を参照）
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`：Supabaseの管理画面から取得

### 3. ローカルで動作確認

```bash
npm install
npm run dev
```

別ターミナルでngrokなどを使い、一時的な公開URLを発行します。

```bash
ngrok http 3000
```

発行されたHTTPS URL（例: `https://xxxx.ngrok-free.app/webhook`）を、LINE Developersコンソールの「Messaging API設定」→「Webhook URL」に登録し、「Webhookの利用」をオンにします。

### 4. 本番デプロイ（Render の例）

1. このプロジェクトをGitHubリポジトリにpush
2. [render.com](https://render.com/) で「New Web Service」→ リポジトリを選択
3. Build Command: `npm install` / Start Command: `npm start`
4. 環境変数（`.env` の中身）をRenderの管理画面で設定
5. デプロイ完了後に発行されるURL＋`/webhook` をLINE Developersコンソールに登録

## 未実装・今後の課題

- 予約枠の重複チェック（`available_slots` テーブルは用意済み、ロジック未実装）
- キャンセル・日時変更のLINE上での受付
- 管理画面（デモ画面）と実データの連携
- リマインド配信（前日通知など）
- エラー時のリトライ・LINEへのエラーメッセージ返信

## ファイル構成

```
line-bot/
├── index.js         Webhookサーバー本体
├── schema.sql        Supabase用DBスキーマ
├── package.json
├── .env.example
└── README.md
```
