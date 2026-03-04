# Kindle Capture Extension 問題修正プラン（`problem-review.md` 5件対応）

## Summary
- 目的は、停止時の部分保存保証・ページ送り二重実行防止・フレーム起因の不安定化抑止・分割保存ハング防止・メモリリーク要因除去。
- 実装対象は `background/content/offscreen/manifest` の4領域。
- 方針は「top-frame優先」「分割保存タイムアウト時は即中断＋明示エラー」で固定。

## Key Changes
- **キャプチャ制御（停止時部分保存）**
  - `STOP_LOOP` は即 `isCapturing=false` にせず、`stopRequested=true` を立てる方式に変更。
  - ループ終了後、`pagesInCurrentBatch > 0` なら停止時でも最終バッチ保存を必ず実行。
  - 分割ON時は既存 part 番号を維持し、停止時の未保存バッチを最後の part として保存。
  - ステータス通知を「停止要求受付」「部分PDF保存中」「停止完了（保存済み）」に分離。

- **ページ送りの単発化（1ループ1アクション保証）**
  - `performPageTurn()` を「成功した手段で即 return」へ変更。
  - 優先順は `selector click -> coordinate click -> keyboard`、後段は前段失敗時のみ実行。
  - 戻り値ステータスに実行手段を含め、デバッグ時に重複実行の有無を確認しやすくする。

- **フレーム戦略の安定化（top-frame固定）**
  - `content_scripts.all_frames` を無効化（削除または `false`）。
  - `sendMessage` は `frameId: 0` を明示してトップフレームへ限定送信。
  - 受信不能時（`Could not establish connection`）は即エラー化し、キャプチャ処理を継続させない。

- **分割保存待機のハング対策**
  - `savePdfBatch()` を `savePdfAndWait(batchIndex, timeoutMs)` に統合し、以下を実装:
  - `PDF_GENERATED` 受信で resolve、`PDF_GENERATION_FAILED` またはタイムアウトで reject。
  - listener/timeout の必ず一度だけ実行されるクリーンアップ処理を追加。
  - `SAVE_PDF` 送信自体の `runtime.lastError` も reject。
  - 失敗時はループを即中断し、Popup に原因付きステータスを表示。

- **Blob URL解放漏れ解消**
  - Offscreen の未使用 `URL.createObjectURL(blob)` を削除。
  - Base64 化（`FileReader.readAsDataURL`）のみを使用し、不要 URL 生成を廃止。

## Public Interface / Message Contract Changes
- 追加メッセージ: `PDF_GENERATION_FAILED`
  - payload: `batchIndex`（任意）, `error`（文字列）
- `STOP_LOOP` の意味を「停止フラグ設定＋部分保存フェーズへ遷移」に明確化（即終了ではない）。

## Test Plan
1. **通常完走（分割なし）**
   - 10ページ実行で最終PDFが1つ生成され、エラー終了しないこと。
2. **停止時部分保存（分割なし）**
   - 実行中に停止し、停止時点までのページを含むPDFが生成されること。
3. **停止時部分保存（分割あり）**
   - `splitLimit=5` で途中停止し、確定済みpart + 最終未確定part が保存されること。
4. **ページ送り重複防止**
   - 連続実行でページ飛びが再現しないこと（ログの実行手段が1ループ1回）。
5. **分割保存タイムアウト経路**
   - `PDF_GENERATED` 非到達を意図的に発生させ、タイムアウト後に即中断＋明示エラーとなること。
6. **メモリリーク要因除去（静的確認）**
   - Offscreen に `createObjectURL` が残っていないことを確認。

## Assumptions / Defaults
- タイムアウトは初期値 `30,000ms`（必要なら定数化して調整可能）。
- UI追加は行わず、既存ステータス表示テキスト更新のみで対応。
- Kindle Reader がトップフレームで操作可能である前提（互換性課題が出た場合は別途 frame 探索ロジックを追加）。
