import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  runStatusWatch,
  STATUS_WATCH_EXIT,
  STATUS_WATCH_SCHEMA_VERSION,
  type StatusWatchDeps,
  type StatusWatchOptions,
} from "./statusWatch.js";
import { parsePreciseTime } from "./statusWatchModel.js";

/** 既定の値。`--timeout-ms` は他のモードと違い 20 分（reviewer の起動前の CI 待ちと実行が、この中に収まる）。 */
const DEFAULTS = {
  intervalMs: 1_000,
  heartbeatMs: 300_000,
  staleMs: 180_000,
  notReceivedMs: 120_000,
  timeoutMs: 1_200_000,
} as const;

const KEY_PATTERN = /^[^/\s#]+\/[^/\s#]+#[1-9]\d*$/;

const NUMERIC_OPTIONS = {
  "interval-ms": "intervalMs",
  "heartbeat-ms": "heartbeatMs",
  "stale-ms": "staleMs",
  "not-received-ms": "notReceivedMs",
  "timeout-ms": "timeoutMs",
} as const;

export interface ParsedStatusWatchArgs {
  options: StatusWatchOptions;
  file: string;
}

export type ParseStatusWatchResult = { ok: true; value: ParsedStatusWatchArgs } | { ok: false; message: string };

function readFlags(argv: string[]): Map<string, string> | string {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      return `Unexpected argument: ${arg}`;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (name !== "key" && name !== "after" && name !== "file" && !(name in NUMERIC_OPTIONS)) {
      return `Unknown option: --${name}`;
    }
    let value: string | undefined;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      value = argv[index + 1];
      index++;
    }
    if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) {
      return `Missing value for --${name}`;
    }
    flags.set(name, value);
  }
  return flags;
}

/** 引数と環境から、監視の設定を作る。副作用を持たない。 */
export function parseStatusWatchArgs(argv: string[], env: NodeJS.ProcessEnv): ParseStatusWatchResult {
  const flags = readFlags(argv);
  if (typeof flags === "string") {
    return { ok: false, message: flags };
  }

  const rawKey = flags.get("key");
  if (rawKey === undefined || !KEY_PATTERN.test(rawKey)) {
    return { ok: false, message: "--key must be owner/repo#N (e.g. scottlz0310/review-raven#158)" };
  }

  const rawAfter = flags.get("after");
  const after = parsePreciseTime(rawAfter);
  if (rawAfter === undefined || after === null) {
    return {
      ok: false,
      message:
        "--after must be a UTC ISO 8601 time with a trailing 'Z', preferably with fractional seconds " +
        "(e.g. 2026-10-25T10:00:00.123456789Z). Use the time just before enqueue_review.",
    };
  }

  let file = flags.get("file");
  if (file === undefined) {
    if (!env.LOCALAPPDATA) {
      return { ok: false, message: "--file is required when LOCALAPPDATA is not set" };
    }
    file = join(env.LOCALAPPDATA, "SquirrelNotifier", "review-status.json");
  }

  const numbers: Record<(typeof NUMERIC_OPTIONS)[keyof typeof NUMERIC_OPTIONS], number> = { ...DEFAULTS };
  for (const [flag, field] of Object.entries(NUMERIC_OPTIONS)) {
    const raw = flags.get(flag);
    if (raw === undefined) {
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, message: `Invalid --${flag}: ${raw}` };
    }
    numbers[field] = value;
  }

  return { ok: true, value: { options: { key: rawKey.toLowerCase(), after, ...numbers }, file } };
}

export function formatStatusWatchUsageError(message: string): string {
  return `${JSON.stringify({
    schemaVersion: STATUS_WATCH_SCHEMA_VERSION,
    type: "error",
    errorCode: "INVALID_ARGUMENT",
    message,
    terminal: true,
  })}\n`;
}

/** 実際のファイル・時計・標準出力に結びつけて実行する。終了コードを返す（`process.exit` は呼ばない）。 */
export async function runStatusWatchCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  overrides: Partial<StatusWatchDeps> = {},
): Promise<number> {
  const parsed = parseStatusWatchArgs(argv, env);
  if (!parsed.ok) {
    console.error(parsed.message);
    process.stdout.write(formatStatusWatchUsageError(parsed.message));
    return STATUS_WATCH_EXIT.usage;
  }
  const { options, file } = parsed.value;
  const deps: StatusWatchDeps = {
    readFile: (signal) => readFile(file, { encoding: "utf8", signal }),
    now: () => Date.now(),
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    write: (line) => {
      process.stdout.write(line);
    },
    ...overrides,
  };
  return runStatusWatch(options, deps);
}
