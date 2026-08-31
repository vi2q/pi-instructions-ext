# INSTRUCTIONS

## 現在の指示

- [ ] Reddit用の紹介ドラフト（英語）を作成する — 対象: instructions-ext
  - 構成: 概要 / アーキテクチャ（session_start, before_agent_start, /instr clean）/ 強み4点 / 細部（重複排除、tombstone、isIdleチェック）
  - [x] ドラフト作成済み。デスクトップに書き出し完了: ~/Desktop/reddit-post-instructions-ext.md（ユーザーがコピーしやすいようにファイルで提供）
  - [x] 内容検証済み：ドラフトの全技術細部（重複排除、tombstone、isIdleチェック、gitNudge）と index.ts 実装・README の記述が一致していることを確認

## 完了済み

- [x] この拡張機能（instructions-ext）について見て欲しい（コード・設計の確認・評価）
- [x] git追跡の促し（コミット推奨）をINIT_MESSAGEに追加し、コミット＆push完了（commit 71c464d, main → origin/main）。.gitignoreにpackage.jsonを追加（ローカルdev依存のピン留め） → 実装済み。gitNudge() を追加：ファイルが存在するが未コミット（未追跡・変更あり）の場合のみ、常設ルール末尾に「コミットを勧める一文」を付与。git未使用・未初期化・既にコミット済みなら何も付けない。tsc検証済み（既存のimplicit-any警告はベースラインから存在、新規エラーなし）
