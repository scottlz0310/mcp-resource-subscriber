/**
 * Squirrel Notifier が公開する `review-status.json`（公開契約 v1）の読み取りと、対象 PR の観測の選択。
 * 副作用を持たない。業務上の意味（Verdict・完了の判定）は解釈しない。
 */

/** 公開契約の `schemaVersion`。互換性のない変更があった版は読まない。 */
export const SUPPORTED_STATUS_SCHEMA_VERSION = 1;

/** 小数秒を 9 桁固定の文字列で保持する時刻。秒に切り捨てると、同じ秒の前後関係を失う。 */
export interface PreciseTime {
  seconds: number;
  fraction: string;
}

const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/** UTC（`Z`）の ISO 8601 だけを受け付ける。不正な値は null。 */
export function parsePreciseTime(value: unknown): PreciseTime | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(milliseconds)) {
    return null;
  }
  return { seconds: milliseconds / 1000, fraction: `${match[2] ?? ""}000000000`.slice(0, 9) };
}

/** 秒、次に 9 桁固定の小数部（文字列）の順で比較する。 */
export function comparePreciseTime(a: PreciseTime, b: PreciseTime): -1 | 0 | 1 {
  if (a.seconds !== b.seconds) {
    return a.seconds < b.seconds ? -1 : 1;
  }
  if (a.fraction === b.fraction) {
    return 0;
  }
  return a.fraction < b.fraction ? -1 : 1;
}

/** 経過時間の計算用（ミリ秒）。順序の判定には使わない。 */
export function preciseTimeToMs(time: PreciseTime): number {
  return time.seconds * 1000 + Number(time.fraction.slice(0, 3));
}

/** 停止判定に使った観測値。resetAtは解除の保証ではない。 */
export interface ReviewAutoPauseInfo {
  agentId: string;
  limitId: string;
  usedPercentage: number;
  thresholdPercentage: number;
  observedAt: string;
  resetAt?: string;
}

export interface ReviewStatusEntry {
  key: string;
  state: string;
  receivedAt: string;
  round?: number;
  eventId?: string;
  holdReason?: string;
  queuePosition?: number;
  outcome?: string;
  exitCode?: number;
  autoPause?: ReviewAutoPauseInfo;
}

export interface ReviewStatusDocument {
  schemaVersion: number;
  updatedAt: string;
  items: ReviewStatusEntry[];
  recent: ReviewStatusEntry[];
}

export type ParsedStatusDocument =
  | { kind: "ok"; document: ReviewStatusDocument }
  | { kind: "invalid" }
  | { kind: "unsupported_schema"; schemaVersion: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAutoPauseInfo(value: unknown): ReviewAutoPauseInfo | null {
  if (
    !isRecord(value) ||
    typeof value.agentId !== "string" ||
    value.agentId.length === 0 ||
    typeof value.limitId !== "string" ||
    value.limitId.length === 0 ||
    typeof value.usedPercentage !== "number" ||
    !Number.isFinite(value.usedPercentage) ||
    typeof value.thresholdPercentage !== "number" ||
    !Number.isFinite(value.thresholdPercentage) ||
    typeof value.observedAt !== "string" ||
    parsePreciseTime(value.observedAt) === null ||
    (value.resetAt !== undefined && parsePreciseTime(value.resetAt) === null)
  ) {
    return null;
  }
  return {
    agentId: value.agentId,
    limitId: value.limitId,
    usedPercentage: value.usedPercentage,
    thresholdPercentage: value.thresholdPercentage,
    observedAt: value.observedAt,
    ...(typeof value.resetAt === "string" ? { resetAt: value.resetAt } : {}),
  };
}

function toEntry(value: unknown): ReviewStatusEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { key, state, receivedAt } = value;
  if (typeof key !== "string" || typeof state !== "string" || typeof receivedAt !== "string") {
    return null;
  }
  const entry: ReviewStatusEntry = { key: key.toLowerCase(), state, receivedAt };
  if (typeof value.round === "number") entry.round = value.round;
  if (typeof value.eventId === "string") entry.eventId = value.eventId;
  if (typeof value.holdReason === "string") entry.holdReason = value.holdReason;
  if (typeof value.queuePosition === "number") entry.queuePosition = value.queuePosition;
  if (typeof value.outcome === "string") entry.outcome = value.outcome;
  if (typeof value.exitCode === "number") entry.exitCode = value.exitCode;
  if (state === "waiting" && entry.holdReason === "autoPause" && value.autoPause !== undefined) {
    const details = parseAutoPauseInfo(value.autoPause);
    if (details !== null) entry.autoPause = details;
  }
  return entry;
}

function toEntries(value: unknown): ReviewStatusEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(toEntry).filter((entry): entry is ReviewStatusEntry => entry !== null);
}

/**
 * 公開契約を読む。知らないフィールドは無視する（契約: 省略可能な追加は schemaVersion を上げない）。
 * 壊れた項目は捨て、文書全体の形が不正なときだけ invalid にする。
 */
export function parseStatusDocument(text: string): ParsedStatusDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(raw) || typeof raw.schemaVersion !== "number" || parsePreciseTime(raw.updatedAt) === null) {
    return { kind: "invalid" };
  }
  if (raw.schemaVersion !== SUPPORTED_STATUS_SCHEMA_VERSION) {
    return { kind: "unsupported_schema", schemaVersion: raw.schemaVersion };
  }
  // 省略は旧版でも合法だが、既知の詳細が不正なときは観測値として採用しない。
  if (
    [raw.items, raw.recent].some(
      (items) =>
        Array.isArray(items) &&
        items.some(
          (entry) =>
            isRecord(entry) &&
            entry.state === "waiting" &&
            entry.holdReason === "autoPause" &&
            entry.autoPause !== undefined &&
            parseAutoPauseInfo(entry.autoPause) === null,
        ),
    )
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "ok",
    document: {
      schemaVersion: raw.schemaVersion,
      updatedAt: raw.updatedAt as string,
      items: toEntries(raw.items),
      recent: toEntries(raw.recent),
    },
  };
}

export type Observation =
  | { kind: "none"; previousRound: { state: string; round: number | null } | null }
  | {
      kind: "active";
      state: string;
      holdReason: string | null;
      round: number | null;
      eventId: string | null;
      queuePosition: number | null;
      autoPause?: ReviewAutoPauseInfo;
    }
  | {
      kind: "finished";
      outcome: string | null;
      exitCode: number | null;
      round: number | null;
      eventId: string | null;
    };

/** `receivedAt` が `after` より後の項目のうち、最も新しいもの。同時刻は「より後」に含めない。 */
function latestAfter(entries: ReviewStatusEntry[], key: string, after: PreciseTime): ReviewStatusEntry | null {
  let best: { entry: ReviewStatusEntry; at: PreciseTime } | null = null;
  for (const entry of entries) {
    if (entry.key !== key) {
      continue;
    }
    const at = parsePreciseTime(entry.receivedAt);
    if (at === null || comparePreciseTime(at, after) <= 0) {
      continue;
    }
    if (best === null || comparePreciseTime(at, best.at) > 0) {
      best = { entry, at };
    }
  }
  return best?.entry ?? null;
}

/**
 * 対象 PR（小文字の `owner/repo#N`）の、`after` より後に受信した項目を選ぶ。
 * `items[]`（起動待ち・実行中）を先に、無ければ `recent[]`（終了）を見る。前の round の項目は拾わない。
 */
export function observe(document: ReviewStatusDocument, key: string, after: PreciseTime): Observation {
  const normalizedKey = key.toLowerCase();
  const active = latestAfter(document.items, normalizedKey, after);
  if (active !== null) {
    return {
      kind: "active",
      state: active.state,
      holdReason: active.holdReason ?? null,
      round: active.round ?? null,
      eventId: active.eventId ?? null,
      queuePosition: active.queuePosition ?? null,
      ...(active.autoPause ? { autoPause: active.autoPause } : {}),
    };
  }
  const finished = latestAfter(document.recent, normalizedKey, after);
  if (finished !== null) {
    return {
      kind: "finished",
      outcome: finished.outcome ?? null,
      exitCode: finished.exitCode ?? null,
      round: finished.round ?? null,
      eventId: finished.eventId ?? null,
    };
  }
  const previous = document.items.find((entry) => entry.key === normalizedKey);
  return {
    kind: "none",
    previousRound: previous ? { state: previous.state, round: previous.round ?? null } : null,
  };
}

/** 状態の短い日本語の説明（LLM と人が、行だけで読めるようにする）。 */
export function describeState(state: string, holdReason: string | null, autoPause?: ReviewAutoPauseInfo): string {
  if (state === "waiting") {
    switch (holdReason) {
      case "ciPending":
        return "CI確定待ち(起動前)";
      case "busy":
        return "別のレビュー実行中のため待機";
      case "manual":
        return "利用者の操作待ち(自動起動off)";
      case "autoPause":
        return autoPause
          ? `Auto-Pause: ${autoPause.agentId}/${autoPause.limitId} 使用率${autoPause.usedPercentage}%（閾値${autoPause.thresholdPercentage}%）、リセット予定${autoPause.resetAt ?? "不明"}。解除には最新使用率の確認が必要`
          : "自動起動が一時停止中";
      default:
        return "起動待ち(評価中)";
    }
  }
  if (state === "running") {
    return "レビュー実行中";
  }
  if (state === "finished") {
    return "プロセス終了(Verdictは別途PRで確認)";
  }
  return state;
}
