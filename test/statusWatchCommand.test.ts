import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_WATCH_EXIT } from "../src/client/statusWatch.js";
import {
  formatStatusWatchUsageError,
  parseStatusWatchArgs,
  runStatusWatchCommand,
} from "../src/client/statusWatchCommand.js";

const KEY = "scottlz0310/review-raven#158";
const AFTER = "2000-01-01T00:00:00.123456789Z";

function parse(argv: string[], env: NodeJS.ProcessEnv = {}) {
  return parseStatusWatchArgs(argv, env);
}

describe("parseStatusWatchArgs", () => {
  it("必須の引数だけなら、既定値で設定を作り、key を小文字にする", () => {
    const result = parse(["--key", "ScottLz0310/Review-Raven#158", "--after", AFTER, "--file", "/tmp/status.json"]);

    expect(result).toEqual({
      ok: true,
      value: {
        file: "/tmp/status.json",
        options: {
          key: "scottlz0310/review-raven#158",
          after: { seconds: Date.parse("2000-01-01T00:00:00Z") / 1000, fraction: "123456789" },
          intervalMs: 1_000,
          heartbeatMs: 300_000,
          staleMs: 180_000,
          notReceivedMs: 120_000,
          timeoutMs: 1_200_000,
        },
      },
    });
  });

  it("--name=value の形でも読める", () => {
    const result = parse([`--key=${KEY}`, `--after=${AFTER}`, "--file=/tmp/s.json", "--timeout-ms=5000"]);

    expect(result.ok && result.value.options.timeoutMs).toBe(5_000);
    expect(result.ok && result.value.file).toBe("/tmp/s.json");
  });

  it.each([
    { flag: "--interval-ms", field: "intervalMs" },
    { flag: "--heartbeat-ms", field: "heartbeatMs" },
    { flag: "--stale-ms", field: "staleMs" },
    { flag: "--not-received-ms", field: "notReceivedMs" },
    { flag: "--timeout-ms", field: "timeoutMs" },
  ])("$flag が $field を上書きする", ({ flag, field }) => {
    const result = parse(["--key", KEY, "--after", AFTER, "--file", "x", flag, "42"]);

    expect(result.ok && (result.value.options as unknown as Record<string, number>)[field]).toBe(42);
  });

  it("--file を省略すると、LOCALAPPDATA の SquirrelNotifier を使う", () => {
    const result = parse(["--key", KEY, "--after", AFTER], {
      LOCALAPPDATA: join("C:", "Users", "x", "AppData", "Local"),
    });

    expect(result.ok && result.value.file).toBe(
      join("C:", "Users", "x", "AppData", "Local", "SquirrelNotifier", "review-status.json"),
    );
  });

  it.each([
    { name: "--file も LOCALAPPDATA も無い", argv: ["--key", KEY, "--after", AFTER], message: "--file is required" },
    { name: "--key がない", argv: ["--after", AFTER, "--file", "x"], message: "--key" },
    { name: "--key に # がない", argv: ["--key", "owner/repo", "--after", AFTER, "--file", "x"], message: "--key" },
    { name: "--key の番号が 0", argv: ["--key", "owner/repo#0", "--after", AFTER, "--file", "x"], message: "--key" },
    {
      name: "--key の番号が 0 始まり",
      argv: ["--key", "owner/repo#01", "--after", AFTER, "--file", "x"],
      message: "--key",
    },
    { name: "--key に空白", argv: ["--key", "owner/re po#1", "--after", AFTER, "--file", "x"], message: "--key" },
    { name: "--after がない", argv: ["--key", KEY, "--file", "x"], message: "--after" },
    {
      name: "--after が UTC でない",
      argv: ["--key", KEY, "--after", "2026-10-25T10:00:00+09:00", "--file", "x"],
      message: "--after",
    },
    {
      name: "--after が日付として不正",
      argv: ["--key", KEY, "--after", "2026-13-40T10:00:00Z", "--file", "x"],
      message: "--after",
    },
    {
      name: "位置引数",
      argv: ["--key", KEY, "--after", AFTER, "--file", "x", "extra"],
      message: "Unexpected argument: extra",
    },
    {
      name: "未知のオプション",
      argv: ["--key", KEY, "--after", AFTER, "--file", "x", "--nope", "1"],
      message: "Unknown option: --nope",
    },
    { name: "値が欠けている（末尾）", argv: ["--key", KEY, "--after"], message: "Missing value for --after" },
    { name: "値が別のオプション", argv: ["--key", "--after", AFTER], message: "Missing value for --key" },
    { name: "= の右が空", argv: ["--key=", "--after", AFTER], message: "Missing value for --key" },
    {
      name: "数値が文字列",
      argv: ["--key", KEY, "--after", AFTER, "--file", "x", "--timeout-ms", "abc"],
      message: "Invalid --timeout-ms: abc",
    },
    {
      name: "数値が 0",
      argv: ["--key", KEY, "--after", AFTER, "--file", "x", "--interval-ms", "0"],
      message: "Invalid --interval-ms: 0",
    },
    {
      name: "数値が負",
      argv: ["--key", KEY, "--after", AFTER, "--file", "x", "--stale-ms", "-5"],
      message: "Invalid --stale-ms: -5",
    },
  ])("$name は拒否する", ({ argv, message }) => {
    const result = parse(argv, {});

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(message);
  });
});

describe("formatStatusWatchUsageError", () => {
  it("terminal の error 行を 1 行 1 JSON で返す", () => {
    const line = formatStatusWatchUsageError("bad");

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      schemaVersion: 1,
      type: "error",
      errorCode: "INVALID_ARGUMENT",
      message: "bad",
      terminal: true,
    });
  });
});

describe("runStatusWatchCommand（プロセス内）", () => {
  let dir: string;
  let file: string;
  let stdout: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mrs-status-cmd-"));
    file = join(dir, "review-status.json");
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const lines = () =>
    stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const status = (items: unknown[], recent: unknown[] = []) =>
    JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), items, recent });
  const entry = (state: string, extra: object = {}) => ({
    key: KEY,
    round: 1,
    state,
    receivedAt: "2000-01-01T00:00:01Z",
    ...extra,
  });

  it("引数エラーは終了コード 2 で、標準出力に error 行、標準エラーに理由を出す", async () => {
    const code = await runStatusWatchCommand(["--key", "bad"], {});

    expect(code).toBe(STATUS_WATCH_EXIT.usage);
    expect(lines()).toEqual([
      expect.objectContaining({ type: "error", errorCode: "INVALID_ARGUMENT", terminal: true }),
    ]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--key"));
  });

  it("実ファイル・実時計・標準出力で動き、状態の変化を出して終了する", async () => {
    await writeFile(file, status([entry("waiting", { holdReason: "ciPending" })]));
    // 監視が始まってから、reviewer が終了したことを表すファイルに置き換える
    setTimeout(() => {
      void writeFile(file, status([], [entry("finished", { outcome: "completed", exitCode: 0 })]));
    }, 150);

    const code = await runStatusWatchCommand(
      ["--key", KEY, "--after", AFTER, "--file", file, "--interval-ms", "30", "--timeout-ms", "10000"],
      {},
    );

    expect(code).toBe(STATUS_WATCH_EXIT.finishedCompleted);
    expect(lines().map((line) => line.state)).toEqual(["waiting", "finished"]);
  });

  it("ファイルが無ければ unobservable を出し、上限で終了コード 4", async () => {
    const code = await runStatusWatchCommand(
      [
        "--key",
        KEY,
        "--after",
        AFTER,
        "--file",
        join(dir, "absent.json"),
        "--interval-ms",
        "20",
        "--timeout-ms",
        "200",
      ],
      {},
    );

    expect(code).toBe(STATUS_WATCH_EXIT.timeout);
    expect(lines().map((line) => line.type)).toEqual(["unobservable", "timeout"]);
  });

  it("依存を差し替えられる（出力先・時計・読み取り）", async () => {
    const written: string[] = [];

    const code = await runStatusWatchCommand(
      ["--key", KEY, "--after", AFTER, "--file", "ignored"],
      {},
      {
        readFile: async () => status([], [entry("finished", { outcome: "failed", exitCode: 1 })]),
        write: (line) => written.push(line),
      },
    );

    expect(code).toBe(STATUS_WATCH_EXIT.finishedFailed);
    expect(written).toHaveLength(1);
    expect(stdout).toBe("");
  });
});
