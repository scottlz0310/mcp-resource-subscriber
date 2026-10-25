import {
  describeState,
  type Observation,
  observe,
  type PreciseTime,
  parsePreciseTime,
  parseStatusDocument,
  preciseTimeToMs,
} from "./statusWatchModel.js";

/** 行の schema。項目の追加は版を上げずに行い、既存の項目の意味は変えない。 */
export const STATUS_WATCH_SCHEMA_VERSION = 1;

/** 終了コード。`call` の 0/1/2/3 とは別の体系（このサブコマンドだけの契約）。 */
export const STATUS_WATCH_EXIT = {
  /** reviewer のプロセスが正常終了した（Verdict の投稿は別途 PR で確認する）。 */
  finishedCompleted: 0,
  /** reviewer のプロセスが失敗で終了した（`outcome` が completed 以外、または exitCode が 0 以外）。 */
  finishedFailed: 1,
  usage: 2,
  /** 利用者の操作待ち（`holdReason = manual`）。 */
  actionRequired: 3,
  timeout: 4,
} as const;

export interface StatusWatchOptions {
  /** 小文字の `owner/repo#N`。 */
  key: string;
  /** `enqueue_review` の直前の時刻。これより後に受信した項目だけを対象にする。 */
  after: PreciseTime;
  intervalMs: number;
  heartbeatMs: number;
  /** `updatedAt` がこれより古ければ、観測できないとみなす。 */
  staleMs: number;
  notReceivedMs: number;
  timeoutMs: number;
}

export interface StatusWatchDeps {
  /** ファイルの内容を返す。存在しなければ `code: "ENOENT"` の Error を投げる。 */
  readFile(): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 1 イベント 1 行（末尾の改行を含む）。 */
  write(line: string): void;
}

/** 書き込み途中の読み取りに備えた、読み取りのやり直し。Squirrel は原子的に置換するため、通常は 1 回で足りる。 */
const READ_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 200;

type ReadResult =
  | { kind: "ok"; updatedAt: PreciseTime; observation: Observation }
  | { kind: "unobservable"; reason: "no_file" | "unreadable" | "unsupported_schema" };

export async function runStatusWatch(options: StatusWatchOptions, deps: StatusWatchDeps): Promise<number> {
  const startedAt = deps.now();
  let lastEmitAt = startedAt;
  let previousFingerprint: string | null = null;
  let unobservableReason: string | null = null;
  let notReceivedReported = false;
  /** heartbeat に載せる、直近に出した観測の状態名（まだ何も出していなければ none）。 */
  let lastState = "none";

  function emit(type: string, fields: Record<string, unknown> = {}, terminal = false): void {
    const line: Record<string, unknown> = {
      schemaVersion: STATUS_WATCH_SCHEMA_VERSION,
      type,
      key: options.key,
      at: new Date(deps.now()).toISOString(),
      ...fields,
    };
    if (terminal) {
      line.terminal = true;
    }
    deps.write(`${JSON.stringify(line)}\n`);
    lastEmitAt = deps.now();
  }

  async function read(): Promise<ReadResult> {
    for (let attempt = 1; ; attempt++) {
      let text: string;
      try {
        text = await deps.readFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "unobservable", reason: "no_file" };
        }
        if (attempt < READ_ATTEMPTS) {
          await deps.sleep(READ_RETRY_DELAY_MS);
          continue;
        }
        return { kind: "unobservable", reason: "unreadable" };
      }
      const parsed = parseStatusDocument(text);
      if (parsed.kind === "unsupported_schema") {
        return { kind: "unobservable", reason: "unsupported_schema" };
      }
      if (parsed.kind === "invalid") {
        if (attempt < READ_ATTEMPTS) {
          await deps.sleep(READ_RETRY_DELAY_MS);
          continue;
        }
        return { kind: "unobservable", reason: "unreadable" };
      }
      // parseStatusDocument が updatedAt を検証済み
      const updatedAt = parsePreciseTime(parsed.document.updatedAt) as PreciseTime;
      return { kind: "ok", updatedAt, observation: observe(parsed.document, options.key, options.after) };
    }
  }

  /** 観測を状態の変化として出す。終了する場合は終了コードを返す。 */
  function handleObservation(observation: Observation): number | null {
    if (observation.kind === "none") {
      const waitedMs = deps.now() - startedAt;
      if (!notReceivedReported && waitedMs >= options.notReceivedMs) {
        emit("not_received", {
          waitedMs,
          ...(observation.previousRound ? { previousRound: observation.previousRound } : {}),
        });
        notReceivedReported = true;
      }
      return null;
    }

    const fingerprint = JSON.stringify(observation);
    if (fingerprint === previousFingerprint) {
      return null;
    }
    previousFingerprint = fingerprint;
    lastState = observation.kind === "finished" ? "finished" : observation.state;

    if (observation.kind === "finished") {
      emit(
        "state",
        {
          state: "finished",
          round: observation.round,
          outcome: observation.outcome,
          exitCode: observation.exitCode,
          detail: describeState("finished", null),
        },
        true,
      );
      return observation.outcome === "completed" && (observation.exitCode ?? 0) === 0
        ? STATUS_WATCH_EXIT.finishedCompleted
        : STATUS_WATCH_EXIT.finishedFailed;
    }

    emit("state", {
      state: observation.state,
      holdReason: observation.holdReason,
      round: observation.round,
      queuePosition: observation.queuePosition,
      detail: describeState(observation.state, observation.holdReason),
    });
    if (observation.state === "waiting" && observation.holdReason === "manual") {
      emit("action_required", { detail: "Squirrelの「レビューする」か、別CLIでreviewerを起動してください" }, true);
      return STATUS_WATCH_EXIT.actionRequired;
    }
    return null;
  }

  for (;;) {
    const now = deps.now();
    if (now - startedAt >= options.timeoutMs) {
      emit("timeout", { elapsedMs: now - startedAt }, true);
      return STATUS_WATCH_EXIT.timeout;
    }

    const result = await read();

    let reason: string | null = null;
    let ageMs: number | null = null;
    if (result.kind === "unobservable") {
      reason = result.reason;
    } else {
      ageMs = deps.now() - preciseTimeToMs(result.updatedAt);
      if (ageMs > options.staleMs) {
        reason = "stale";
      }
    }

    if (reason !== null) {
      if (reason !== unobservableReason) {
        emit("unobservable", ageMs === null ? { reason } : { reason, ageMs });
        unobservableReason = reason;
      }
    } else if (result.kind === "ok") {
      if (unobservableReason !== null) {
        emit("recovered");
        unobservableReason = null;
      }

      const exit = handleObservation(result.observation);
      if (exit !== null) {
        return exit;
      }
    }

    if (deps.now() - lastEmitAt >= options.heartbeatMs) {
      const elapsedMs = deps.now() - startedAt;
      emit("heartbeat", { state: unobservableReason !== null ? "unobservable" : lastState, elapsedMs });
    }

    await deps.sleep(options.intervalMs);
  }
}
