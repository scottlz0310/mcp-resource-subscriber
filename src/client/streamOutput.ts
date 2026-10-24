import type { ResourceStreamResult, StreamEvent } from "./streamClient.js";

/** `--jsonl` の行 schema。行の追加・必須項目の変更は版を上げ、既存の版の項目は変えない。 */
export const STREAM_SCHEMA_VERSION = 1;

export interface StreamEndLine {
  schemaVersion: typeof STREAM_SCHEMA_VERSION;
  type: "end";
  reason: "until-matched" | "error";
  closeReason: ResourceStreamResult["closeReason"];
  errorCode: string | null;
  notificationCount: number;
  recommendedNextAction: string | null;
}

function toLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function formatStreamEvent(event: StreamEvent): string {
  return toLine({ schemaVersion: STREAM_SCHEMA_VERSION, ...event });
}

export function formatStreamEnd(result: ResourceStreamResult): string {
  const line: StreamEndLine = {
    schemaVersion: STREAM_SCHEMA_VERSION,
    type: "end",
    reason: result.matched ? "until-matched" : "error",
    closeReason: result.closeReason,
    errorCode: result.errorCode,
    notificationCount: result.notificationCount,
    recommendedNextAction: null,
  };
  return toLine(line);
}

/** ack 前の失敗（引数・認証・接続）。購読結果を持たないため end 行だけで報告する。 */
export function formatStreamError(errorCode: string, recommendedNextAction: string | null = null): string {
  const line: StreamEndLine = {
    schemaVersion: STREAM_SCHEMA_VERSION,
    type: "end",
    reason: "error",
    closeReason: null,
    errorCode,
    notificationCount: 0,
    recommendedNextAction,
  };
  return toLine(line);
}
