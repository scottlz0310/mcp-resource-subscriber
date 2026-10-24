import { isDeepStrictEqual } from "node:util";

/** `--until <JSON Pointer>=<JSON値>` で指定する終了条件。業務上の意味（PR/HEAD/Verdict）は解釈しない。 */
export interface UntilCondition {
  pointer: string;
  expected: unknown;
}

export class UntilParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntilParseError";
  }
}

/** 最初の `=` でPointerと値を分ける。Pointerに `=` を含むキーは指定できない。 */
export function parseUntil(raw: string): UntilCondition {
  const separator = raw.indexOf("=");
  if (separator === -1) {
    throw new UntilParseError("--until must be <JSON Pointer>=<JSON value> (e.g. /terminal=true)");
  }

  const pointer = raw.slice(0, separator);
  if (pointer !== "" && !pointer.startsWith("/")) {
    throw new UntilParseError(
      `--until JSON Pointer must be empty or start with '/': ${pointer} (Git Bash は先頭の '/' を Windows パスへ変換します。MSYS_NO_PATHCONV=1 を設定してください)`,
    );
  }

  let expected: unknown;
  try {
    expected = JSON.parse(raw.slice(separator + 1));
  } catch {
    throw new UntilParseError('--until value must be valid JSON (quote strings, e.g. /kind="approved")');
  }

  return { pointer, expected };
}

function resolvePointer(document: unknown, pointer: string): { found: boolean; value: unknown } {
  let current = document;
  if (pointer === "") {
    return { found: true, value: current };
  }

  for (const rawToken of pointer.split("/").slice(1)) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false, value: undefined };
    }
  }

  return { found: true, value: current };
}

/** JSONとして解釈できない本文・Pointerの不在は「不一致」として扱い、待機を継続させる。 */
export function evaluateUntil(condition: UntilCondition, document: unknown): boolean {
  const resolved = resolvePointer(document, condition.pointer);
  return resolved.found && isDeepStrictEqual(resolved.value, condition.expected);
}

/**
 * snapshot 本文を JSON として解釈して終了条件を評価する。解析失敗は JSON の `null` と
 * 区別し、必ず不一致にする（空 Pointer の `=null` が非 JSON 本文に一致しないようにする）。
 */
export function evaluateSnapshot(condition: UntilCondition, text: string): { json: unknown | null; matched: boolean } {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { json: null, matched: false };
  }
  return { json, matched: evaluateUntil(condition, json) };
}
