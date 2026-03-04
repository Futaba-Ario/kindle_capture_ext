# Kindle Capture Extension 問題点チェック

作成日: 2026-03-05

## 概要
- 対象: `manifest.json`, `src/popup`, `src/content`, `src/background`, `src/offscreen`
- 目的: 実装上の不具合・不安定要因の洗い出し

## 問題点（重大度順）

### 1. [P1] 停止時に途中までのPDFが保存されない
- 現状:
  - `STOP_LOOP` で `isCapturing = false` にした後、保存処理が `if (isCapturing)` の中にある。
  - そのため停止ボタンで中断した場合、途中までキャプチャしたページを保存せず終了する。
- 影響:
  - READMEにある「停止時はそこまでのPDFを生成」と実動作が矛盾する。
- 参照:
  - `src/background/service_worker.js` の `STOP_LOOP` 分岐
  - `src/background/service_worker.js` の `if (isCapturing) { ... SAVE_PDF ... }`

### 2. [P1] 1回のページ送りで2ページ進む可能性
- 現状:
  - `content.js` で座標クリック後に `return` せず、続けて ArrowLeft のキーボードイベントも送っている。
- 影響:
  - 環境依存で1ループ中に二重ページ送りが発生し、撮影対象ページが飛ぶ可能性がある。
- 参照:
  - `src/content/content.js` の座標クリック処理
  - `src/content/content.js` のキーボード送出処理

### 3. [P2] all_frames + frame未指定送信により動作が不安定化する可能性
- 現状:
  - `manifest.json` で `all_frames: true`。
  - `chrome.tabs.sendMessage(tabId, ...)` で `frameId` 指定がない。
- 影響:
  - 複数フレームへの配信や予期しないフレームでの実行により、ページ送りが重複/不安定化する可能性がある。
- 参照:
  - `manifest.json` の `content_scripts[].all_frames`
  - `src/background/service_worker.js` の `sendPageTurn()`

### 4. [P2] 分割保存待機がハングする経路
- 現状:
  - `savePdfBatch()` は `PDF_GENERATED` を待つだけでタイムアウトや失敗時 `reject` がない。
  - Offscreen側の `FileReader` 完了通知が来ないと待機解除できない。
- 影響:
  - 分割保存中に処理全体が停止したように見える。
- 参照:
  - `src/background/service_worker.js` の `savePdfBatch()`
  - `src/offscreen/offscreen.js` の `FileReader.onloadend`

### 5. [P3] Blob URLの解放漏れ
- 現状:
  - `URL.createObjectURL(blob)` を作成しているが実使用せず、`URL.revokeObjectURL()` も呼ばれない。
- 影響:
  - 長時間利用や大量処理で不要なメモリ保持の一因になる。
- 参照:
  - `src/offscreen/offscreen.js` の Blob URL 作成箇所

## 補足
- 実行環境に `node` コマンドが無く、構文チェックは未実施。
- 上記はコード読み取りに基づくレビュー結果。
