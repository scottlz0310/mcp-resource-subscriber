import { describe, expect, it } from "vitest";
import { runStatusWatch, STATUS_WATCH_EXIT, type StatusWatchOptions } from "../src/client/statusWatch.js";
import { parsePreciseTime } from "../src/client/statusWatchModel.js";

const KEY = "scottlz0310/review-raven#158";
const START_MS = Date.parse("2026-10-25T10:00:00Z");
const RECEIVED_AT = "2026-10-25T10:00:00.500Z";

const OPTIONS: StatusWatchOptions = {
  key: KEY,
  after: parsePreciseTime("2026-10-25T09:59:59.900Z") as NonNullable<ReturnType<typeof parsePreciseTime>>,
  intervalMs: 1_000,
  heartbeatMs: 10_000,
  staleMs: 180_000,
  notReceivedMs: 5_000,
  timeoutMs: 60_000,
};

/** 読み取りが応答しない（ネットワークドライブのロックなど）ことを表す。 */
const HANG = Symbol("hang");

type Provider = (elapsedMs: number, nowIso: string) => string | Error | typeof HANG;

interface Run {
  exitCode: number;
  lines: Array<Record<string, unknown>>;
  /** 各行を出した時点の経過時間 */
  elapsedAt: number[];
  reads: number;
  /** readFile に渡された signal が、終了までに中断されたか（止まった読み取りを打ち切れること）。 */
  abortedReads: number;
}

/** 仮想時刻のタイマー。時間は、実行中の処理が待っているときだけ、最も早いタイマーまで進む。 */
class FakeClock {
  now = START_MS;
  private timers: Array<{ at: number; resolve: () => void }> = [];

  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = { at: this.now + ms, resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((candidate) => candidate !== timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });

  /** 対象の処理が終わるまで、処理が待つたびに時間を進める。 */
  async pump<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (;;) {
      // マイクロタスクを使い切らせる
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) {
        return work;
      }
      const next = this.timers.reduce<{ at: number; resolve: () => void } | null>(
        (earliest, timer) => (earliest === null || timer.at < earliest.at ? timer : earliest),
        null,
      );
      if (next === null) {
        throw new Error("deadlock: 待っているタイマーがありません");
      }
      this.timers = this.timers.filter((timer) => timer !== next);
      this.now = Math.max(this.now, next.at);
      next.resolve();
    }
  }
}

/** 偽の時計。readFile は readMs だけ時間をかけて、そのときの経過時間の関数として内容を返す。 */
async function run(
  provider: Provider,
  options: Partial<StatusWatchOptions> = {},
  behavior: { readMs?: number } = {},
): Promise<Run> {
  const clock = new FakeClock();
  let reads = 0;
  let abortedReads = 0;
  const lines: Array<Record<string, unknown>> = [];
  const elapsedAt: number[] = [];
  const exitCode = await clock.pump(
    runStatusWatch(
      { ...OPTIONS, ...options },
      {
        now: () => clock.now,
        sleep: clock.sleep,
        readFile: async (signal) => {
          reads++;
          signal?.addEventListener("abort", () => abortedReads++, { once: true });
          if (behavior.readMs !== undefined) {
            await clock.sleep(behavior.readMs, signal);
          }
          const result = provider(clock.now - START_MS, new Date(clock.now).toISOString());
          if (result === HANG) {
            return new Promise<string>(() => {});
          }
          if (result instanceof Error) {
            throw result;
          }
          return result;
        },
        write: (line) => {
          lines.push(JSON.parse(line));
          elapsedAt.push(clock.now - START_MS);
        },
      },
    ),
  );
  return { exitCode, lines, elapsedAt, reads, abortedReads };
}

function doc(nowIso: string, items: unknown[] = [], recent: unknown[] = [], updatedAt = nowIso): string {
  return JSON.stringify({ schemaVersion: 1, updatedAt, items, recent });
}

const waiting = (holdReason: string | undefined, extra: object = {}) => ({
  key: KEY,
  round: 2,
  eventId: "evt_1",
  state: "waiting",
  receivedAt: RECEIVED_AT,
  queuePosition: 1,
  ...(holdReason ? { holdReason } : {}),
  ...extra,
});
const running = { key: KEY, round: 2, eventId: "evt_1", state: "running", receivedAt: RECEIVED_AT };
const finished = (outcome: string, exitCode: number) => ({
  key: KEY,
  round: 2,
  eventId: "evt_1",
  state: "finished",
  receivedAt: RECEIVED_AT,
  outcome,
  exitCode,
});

function types(result: Run): string[] {
  return result.lines.map((line) => String(line.type));
}

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("runStatusWatch: 通常の経過", () => {
  it("保留理由が同じでも根拠の更新を配送し、実行中と終了へ持ち越さない", async () => {
    const pause = {
      agentId: "agy",
      limitId: "3p-weekly",
      usedPercentage: 96,
      thresholdPercentage: 95,
      observedAt: new Date(START_MS).toISOString(),
      resetAt: new Date(START_MS + 600_000).toISOString(),
    };
    const result = await run((elapsed, now) => {
      if (elapsed < 1_000) return doc(now, [waiting("autoPause", { autoPause: pause })]);
      if (elapsed < 2_000) return doc(now, [waiting("autoPause", { autoPause: { ...pause, usedPercentage: 98 } })]);
      if (elapsed < 3_000) return doc(now, [{ ...running, autoPause: pause }]);
      return doc(now, [], [{ ...finished("completed", 0), autoPause: pause }]);
    });
    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.finishedCompleted);
    const states = result.lines.filter((line) => line.type === "state");
    expect(states.map((line) => line.autoPause)).toEqual([
      pause,
      { ...pause, usedPercentage: 98 },
      undefined,
      undefined,
    ]);
    expect(states.map((line) => line.state)).toEqual(["waiting", "waiting", "running", "finished"]);
  });

  it("受信前 → CI 待ち → 行列待ち → 実行中 → 終了を、状態の変化ごとに 1 行だけ出す", async () => {
    // updatedAt は毎回変わる（Squirrel の 60 秒ごとの更新）が、状態が同じなら出力しない
    const result = await run(
      (elapsed, nowIso) => {
        if (elapsed < 3_000) return doc(nowIso);
        if (elapsed < 8_000) return doc(nowIso, [waiting("ciPending")]);
        if (elapsed < 12_000) return doc(nowIso, [waiting("busy")]);
        if (elapsed < 16_000) return doc(nowIso, [running]);
        return doc(nowIso, [], [finished("completed", 0)]);
      },
      { heartbeatMs: 600_000 },
    );

    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.finishedCompleted);
    expect(types(result)).toEqual(["state", "state", "state", "state"]);
    expect(result.lines.map((line) => [line.state, line.holdReason ?? null])).toEqual([
      ["waiting", "ciPending"],
      ["waiting", "busy"],
      ["running", null],
      ["finished", null],
    ]);
    expect(result.lines.map((line) => line.terminal ?? false)).toEqual([false, false, false, true]);
    expect(result.lines[0]).toMatchObject({ schemaVersion: 1, key: KEY, round: 2, queuePosition: 1 });
    expect(result.lines[0].detail).toBe("CI確定待ち(起動前)");
  });

  it.each([
    { name: "completed・exit 0", outcome: "completed", exitCode: 0, expected: STATUS_WATCH_EXIT.finishedCompleted },
    { name: "failed・exit 1", outcome: "failed", exitCode: 1, expected: STATUS_WATCH_EXIT.finishedFailed },
    { name: "completed だが exit 非 0", outcome: "completed", exitCode: 2, expected: STATUS_WATCH_EXIT.finishedFailed },
    { name: "未知の outcome", outcome: "killed", exitCode: 0, expected: STATUS_WATCH_EXIT.finishedFailed },
  ])("終了の $name は終了コード $expected", async ({ outcome, exitCode, expected }) => {
    const result = await run((_, nowIso) => doc(nowIso, [], [finished(outcome, exitCode)]));

    expect(result.exitCode).toBe(expected);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ type: "state", state: "finished", outcome, exitCode, terminal: true });
  });

  it("失敗の終了は、waiting から直接でも検知する（running を経由しない短い失敗）", async () => {
    const result = await run((elapsed, nowIso) =>
      elapsed < 2_000 ? doc(nowIso, [waiting("ciPending")]) : doc(nowIso, [], [finished("failed", 1)]),
    );

    expect(types(result)).toEqual(["state", "state"]);
    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.finishedFailed);
  });

  it("手動待ちは、state に続けて action_required を出して終了コード 3", async () => {
    const result = await run((_, nowIso) => doc(nowIso, [waiting("manual")]));

    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.actionRequired);
    expect(types(result)).toEqual(["state", "action_required"]);
    expect(result.lines[1].terminal).toBe(true);
  });
});

describe("runStatusWatch: 静かなまま詰まらない", () => {
  it("対象が現れなければ not_received を 1 回だけ出し、タイムアウトで終了コード 4", async () => {
    const result = await run((_, nowIso) => doc(nowIso), { heartbeatMs: 600_000, timeoutMs: 20_000 });

    expect(types(result)).toEqual(["not_received", "timeout"]);
    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.timeout);
    expect(result.lines[0].waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(result.lines[1]).toMatchObject({ terminal: true, elapsedMs: 20_000 });
  });

  it("前の round が実行中のままなら、not_received に previousRound を添える", async () => {
    const previous = { key: KEY, round: 1, state: "running", receivedAt: "2026-10-25T09:00:00Z" };
    const result = await run((_, nowIso) => doc(nowIso, [previous]), { timeoutMs: 8_000, heartbeatMs: 600_000 });

    expect(result.lines[0]).toMatchObject({ type: "not_received", previousRound: { state: "running", round: 1 } });
  });

  it("ファイルが無ければ unobservable(no_file) を 1 回だけ出し、現れたら recovered と state", async () => {
    const result = await run(
      (elapsed, nowIso) => (elapsed < 4_000 ? errorWithCode("ENOENT") : doc(nowIso, [running])),
      { timeoutMs: 10_000, heartbeatMs: 600_000 },
    );

    expect(types(result).slice(0, 3)).toEqual(["unobservable", "recovered", "state"]);
    expect(result.lines[0]).toMatchObject({ reason: "no_file" });
    expect(types(result).filter((type) => type === "unobservable")).toHaveLength(1);
  });

  it("更新が止まっている（updatedAt が古い）と unobservable(stale) を出し、更新されたら recovered", async () => {
    const result = await run(
      (elapsed, nowIso) =>
        elapsed < 5_000
          ? doc(nowIso, [running], [], new Date(START_MS - 10 * 60_000).toISOString())
          : doc(nowIso, [running]),
      { timeoutMs: 12_000, heartbeatMs: 600_000 },
    );

    expect(types(result).slice(0, 3)).toEqual(["unobservable", "recovered", "state"]);
    expect(result.lines[0]).toMatchObject({ reason: "stale" });
    expect(result.lines[0].ageMs).toBeGreaterThan(180_000);
  });

  it("非対応の schemaVersion は読まず、unobservable(unsupported_schema)", async () => {
    const result = await run(() => JSON.stringify({ schemaVersion: 2, updatedAt: "2026-10-25T10:00:00Z" }), {
      timeoutMs: 5_000,
      heartbeatMs: 600_000,
    });

    expect(result.lines[0]).toMatchObject({ type: "unobservable", reason: "unsupported_schema" });
  });

  it.each([
    { name: "JSON が壊れている", content: () => "{" },
    { name: "読み取りの権限がない", content: () => errorWithCode("EACCES") },
  ])("$name が続くと、数回やり直したあと unobservable(unreadable)", async ({ content }) => {
    const result = await run(content, { timeoutMs: 3_000, heartbeatMs: 600_000 });

    expect(result.lines[0]).toMatchObject({ type: "unobservable", reason: "unreadable" });
    expect(result.reads).toBeGreaterThanOrEqual(3);
  });

  it("書き込み途中の読み取り（一時的に壊れた JSON）は、やり直しで吸収して通知しない", async () => {
    let reads = 0;
    const result = await run(
      (_, nowIso) => {
        reads++;
        return reads === 1 ? '{"schemaVersion":1,' : doc(nowIso, [], [finished("completed", 0)]);
      },
      { timeoutMs: 5_000 },
    );

    expect(types(result)).toEqual(["state"]);
    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.finishedCompleted);
  });

  it("状態が変わらないまま heartbeat の間隔が過ぎたら、heartbeat を出す", async () => {
    const result = await run((_, nowIso) => doc(nowIso, [waiting("busy")]), { heartbeatMs: 10_000, timeoutMs: 35_000 });

    expect(types(result)).toEqual(["state", "heartbeat", "heartbeat", "heartbeat", "timeout"]);
    expect(result.lines[1]).toMatchObject({ state: "waiting" });
    // heartbeat は直前の出力から間隔が空いたときだけ（連続して出さない）
    expect(result.elapsedAt[2] - result.elapsedAt[1]).toBeGreaterThanOrEqual(10_000);
  });

  it("全体の上限に達したら timeout（terminal）を出して終了コード 4", async () => {
    const result = await run((_, nowIso) => doc(nowIso, [running]), { heartbeatMs: 600_000, timeoutMs: 15_000 });

    expect(result.lines.at(-1)).toMatchObject({ type: "timeout", terminal: true });
    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.timeout);
  });
});

describe("runStatusWatch: --timeout-ms の期限", () => {
  it("期限後に読み取りが終わった finished は、成功にせず timeout にする", async () => {
    // 上限 1000ms で、読み取りに 2000ms かかる
    const result = await run(
      (_, nowIso) => doc(nowIso, [], [finished("completed", 0)]),
      { timeoutMs: 1_000 },
      { readMs: 2_000 },
    );

    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.timeout);
    expect(types(result)).toEqual(["timeout"]);
  });

  it("監視間隔が上限より長くても、上限で timeout を出す", async () => {
    const result = await run((_, nowIso) => doc(nowIso, [running]), {
      intervalMs: 60_000,
      timeoutMs: 1_000,
      heartbeatMs: 600_000,
    });

    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.timeout);
    expect(types(result)).toEqual(["state", "timeout"]);
    expect(result.elapsedAt.at(-1)).toBe(1_000);
  });

  it("読み取りが止まっても、上限で timeout を出し、読み取りを中断する", async () => {
    const result = await run(() => HANG, { timeoutMs: 5_000 });

    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.timeout);
    expect(types(result)).toEqual(["timeout"]);
    expect(result.elapsedAt.at(-1)).toBe(5_000);
    expect(result.abortedReads).toBe(1);
  });

  it("再試行の待ちも上限に収まり、上限を超えて待たない", async () => {
    // 壊れた JSON が続き、再試行（200ms × 2）が上限 300ms を超える
    const result = await run(() => "{", { timeoutMs: 300, heartbeatMs: 600_000 });

    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.timeout);
    expect(result.lines.at(-1)).toMatchObject({ type: "timeout", terminal: true });
    expect(result.elapsedAt.at(-1)).toBe(300);
  });

  it("上限の直前に終わった読み取りは、通常どおり処理する", async () => {
    const result = await run(
      (_, nowIso) => doc(nowIso, [], [finished("completed", 0)]),
      { timeoutMs: 1_000 },
      { readMs: 999 },
    );

    expect(result.exitCode).toBe(STATUS_WATCH_EXIT.finishedCompleted);
  });
});

describe("runStatusWatch: 時刻の順序", () => {
  // enqueue と受信が同じ秒に起きても、受信が後なら今回の round として拾う（小数秒を保持した比較）
  it.each([
    { name: "同一秒で受信が後", receivedAt: "2026-10-25T09:59:59.950Z", picked: true },
    { name: "同一秒で受信が前", receivedAt: "2026-10-25T09:59:59.850Z", picked: false },
    { name: "同時刻", receivedAt: "2026-10-25T09:59:59.900Z", picked: false },
  ])("$name", async ({ receivedAt, picked }) => {
    const result = await run((_, nowIso) => doc(nowIso, [{ ...running, receivedAt }]), {
      timeoutMs: 8_000,
      heartbeatMs: 600_000,
    });

    expect(result.lines[0].type).toBe(picked ? "state" : "not_received");
  });
});
