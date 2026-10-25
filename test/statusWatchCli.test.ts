import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_SRC = join(process.cwd(), "src", "client", "cli.ts");
const KEY = "scottlz0310/review-raven#158";
// 受信より前の時刻。ここより後に受信した項目だけが今回の round になる
const AFTER = "2000-01-01T00:00:00.123456789Z";
const RECEIVED_AT = "2000-01-01T00:00:01.5Z";

interface CliRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  lines: Array<Record<string, unknown>>;
}

/** JSON でない行（--help など）は unparsable として保持する。 */
function parseLine(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { type: "unparsable", raw };
  }
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", ["--import", "tsx/esm", CLI_SRC, ...args], {
      env: {
        ...process.env,
        MCP_PROBE_URL: undefined,
        MCP_PROBE_URI: undefined,
        MCP_PROBE_TIMEOUT_MS: undefined,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const lines = stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => parseLine(line));
      resolvePromise({ exitCode, stdout, stderr, lines });
    });
  });
}

describe("resource-bridge-cli watch-review-status", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mrs-status-watch-"));
    file = join(dir, "review-status.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Squirrel と同じく、一時ファイルへ書いてから置換する（読み取り側が書き込み途中を見ない）。 */
  async function publish(items: unknown[], recent: unknown[] = []): Promise<void> {
    const content = JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), items, recent });
    await writeFile(`${file}.tmp`, content);
    await rename(`${file}.tmp`, file);
  }

  const entry = (state: string, extra: object = {}) => ({
    key: KEY,
    round: 1,
    eventId: "evt_1",
    state,
    receivedAt: RECEIVED_AT,
    ...extra,
  });

  const baseArgs = () => ["watch-review-status", "--key", KEY, "--after", AFTER, "--file", file, "--interval-ms", "30"];

  /** 一定時間ごとにファイルを更新するシナリオを走らせながら、CLI の完了を待つ。 */
  async function runScenario(steps: Array<() => Promise<void>>, args: string[]): Promise<CliRun> {
    const pending = runCli(args);
    for (const step of steps) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
      await step();
    }
    return pending;
  }

  it("実ファイルの更新を状態の変化として 1 行ずつ出し、終了で終了コード 0", async () => {
    await publish([]);
    const result = await runScenario(
      [
        () => publish([entry("waiting", { holdReason: "ciPending", queuePosition: 1 })]),
        // 状態が同じまま updatedAt だけ更新される（heartbeat）。行を増やさない
        () => publish([entry("waiting", { holdReason: "ciPending", queuePosition: 1 })]),
        () => publish([entry("running")]),
        () => publish([], [entry("finished", { outcome: "completed", exitCode: 0 })]),
      ],
      [...baseArgs(), "--timeout-ms", "15000"],
    );

    expect(result.exitCode).toBe(0);
    expect(result.lines.map((line) => [line.type, line.state])).toEqual([
      ["state", "waiting"],
      ["state", "running"],
      ["state", "finished"],
    ]);
    expect(result.lines.at(-1)).toMatchObject({ outcome: "completed", exitCode: 0, terminal: true });
    expect(result.lines.every((line) => line.schemaVersion === 1 && line.key === KEY)).toBe(true);
  });

  it("reviewer の失敗の終了は終了コード 1", async () => {
    await publish([entry("waiting", { holdReason: "ciPending" })]);
    const result = await runScenario(
      [() => publish([], [entry("finished", { outcome: "failed", exitCode: 1 })])],
      [...baseArgs(), "--timeout-ms", "15000"],
    );

    expect(result.exitCode).toBe(1);
    expect(result.lines.at(-1)).toMatchObject({ state: "finished", outcome: "failed", exitCode: 1 });
  });

  it("手動待ちは action_required を出して終了コード 3", async () => {
    await publish([entry("waiting", { holdReason: "manual" })]);
    const result = await runCli([...baseArgs(), "--timeout-ms", "15000"]);

    expect(result.exitCode).toBe(3);
    expect(result.lines.map((line) => line.type)).toEqual(["state", "action_required"]);
  });

  it("ファイルが無ければ unobservable(no_file) を出し、タイムアウトで終了コード 4", async () => {
    const result = await runCli([...baseArgs(), "--timeout-ms", "800"]);

    expect(result.exitCode).toBe(4);
    expect(result.lines.map((line) => line.type)).toEqual(["unobservable", "timeout"]);
    expect(result.lines[0]).toMatchObject({ reason: "no_file" });
  });

  it("前の round の終了だけがあるときは拾わず、not_received", async () => {
    await publish([], [entry("finished", { receivedAt: "1999-12-31T00:00:00Z", outcome: "completed", exitCode: 0 })]);
    const result = await runCli([...baseArgs(), "--not-received-ms", "200", "--timeout-ms", "800"]);

    expect(result.exitCode).toBe(4);
    expect(result.lines.map((line) => line.type)).toEqual(["not_received", "timeout"]);
  });

  it.each([
    { name: "--key がない", args: ["--after", AFTER], message: "--key" },
    { name: "--key の形式が不正", args: ["--key", "no-hash", "--after", AFTER], message: "--key" },
    { name: "--after がない", args: ["--key", KEY], message: "--after" },
    {
      name: "--after に UTC 以外の時刻",
      args: ["--key", KEY, "--after", "2026-10-25T19:00:00+09:00"],
      message: "--after",
    },
    {
      name: "未知のオプション",
      args: ["--key", KEY, "--after", AFTER, "--nope", "1"],
      message: "Unknown option: --nope",
    },
    {
      name: "数値が不正",
      args: ["--key", KEY, "--after", AFTER, "--timeout-ms", "abc"],
      message: "Invalid --timeout-ms",
    },
    { name: "値が欠けている", args: ["--key", KEY, "--after"], message: "Missing value for --after" },
    { name: "位置引数", args: ["--key", KEY, "--after", AFTER, "extra"], message: "Unexpected argument: extra" },
  ])("引数エラー（$name）は終了コード 2 で、error 行を出す", async ({ args, message }) => {
    const result = await runCli(["watch-review-status", ...args, "--file", join(dir, "absent.json")]);

    expect(result.exitCode).toBe(2);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ type: "error", errorCode: "INVALID_ARGUMENT", terminal: true });
    expect(String(result.lines[0].message)).toContain(message);
    expect(result.stderr).toContain(message);
  });

  it("--file を省略し LOCALAPPDATA も無ければ引数エラー", async () => {
    const result = await runCli(["watch-review-status", "--key", KEY, "--after", AFTER], { LOCALAPPDATA: undefined });

    expect(result.exitCode).toBe(2);
    expect(String(result.lines[0].message)).toContain("--file is required");
  });

  it("--file を省略すると LOCALAPPDATA の SquirrelNotifier を読む", async () => {
    await rm(file, { force: true });
    const appDir = join(dir, "SquirrelNotifier");
    await mkdir(appDir);
    await writeFile(
      join(appDir, "review-status.json"),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        items: [entry("waiting", { holdReason: "manual" })],
        recent: [],
      }),
    );

    const result = await runCli(["watch-review-status", "--key", KEY, "--after", AFTER], { LOCALAPPDATA: dir });

    expect(result.exitCode).toBe(3);
  });

  it("--help にサブコマンドと終了コードを載せる", async () => {
    const result = await runCli(["--help"]);

    expect(result.stdout).toContain("watch-review-status");
    expect(result.stdout).toContain("引数エラー 2");
  });
});
