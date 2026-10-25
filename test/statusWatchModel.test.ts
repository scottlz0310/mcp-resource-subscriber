import { describe, expect, it } from "vitest";
import {
  comparePreciseTime,
  describeState,
  observe,
  parsePreciseTime,
  parseStatusDocument,
  type ReviewStatusDocument,
  type ReviewStatusEntry,
} from "../src/client/statusWatchModel.js";

const KEY = "scottlz0310/review-raven#158";

function time(value: string) {
  const parsed = parsePreciseTime(value);
  if (parsed === null) {
    throw new Error(`invalid test time: ${value}`);
  }
  return parsed;
}

function entry(overrides: Partial<ReviewStatusEntry>): ReviewStatusEntry {
  return { key: KEY, state: "waiting", receivedAt: "2026-10-25T10:00:00.500000Z", round: 1, ...overrides };
}

function document(items: ReviewStatusEntry[], recent: ReviewStatusEntry[] = []): ReviewStatusDocument {
  return { schemaVersion: 1, updatedAt: "2026-10-25T10:00:10Z", items, recent };
}

describe("parsePreciseTime", () => {
  it.each([
    { name: "小数秒なし", value: "2026-10-25T10:00:00Z", fraction: "000000000" },
    { name: "1 桁", value: "2026-10-25T10:00:00.9Z", fraction: "900000000" },
    { name: "7 桁（.NET の既定）", value: "2026-10-25T10:00:00.1234567Z", fraction: "123456700" },
    { name: "9 桁", value: "2026-10-25T10:00:00.123456789Z", fraction: "123456789" },
    { name: "10 桁以上は 9 桁で切る", value: "2026-10-25T10:00:00.1234567891Z", fraction: "123456789" },
  ])("$name を 9 桁固定の小数部にする", ({ value, fraction }) => {
    expect(parsePreciseTime(value)?.fraction).toBe(fraction);
  });

  it.each([
    { name: "タイムゾーンなし", value: "2026-10-25T10:00:00" },
    { name: "UTC 以外のオフセット", value: "2026-10-25T19:00:00+09:00" },
    { name: "日付だけ", value: "2026-10-25" },
    { name: "月が範囲外", value: "2026-13-25T10:00:00Z" },
    { name: "文字列でない", value: 123 },
    { name: "null", value: null },
  ])("$name は不正として null", ({ value }) => {
    expect(parsePreciseTime(value)).toBeNull();
  });
});

describe("comparePreciseTime", () => {
  // 秒に切り捨てた比較では、同じ秒の前後関係を失う（レビューで指摘された不具合の再発防止）
  it.each([
    { name: "同一秒で後（0.900 > 0.100）", a: "2026-10-25T10:00:00.900Z", b: "2026-10-25T10:00:00.100Z", expected: 1 },
    { name: "同一秒で前（0.050 < 0.100）", a: "2026-10-25T10:00:00.050Z", b: "2026-10-25T10:00:00.100Z", expected: -1 },
    { name: "同時刻", a: "2026-10-25T10:00:00.100Z", b: "2026-10-25T10:00:00.100Z", expected: 0 },
    { name: "桁数が違っても同時刻", a: "2026-10-25T10:00:00.1Z", b: "2026-10-25T10:00:00.1000000Z", expected: 0 },
    {
      name: "桁数が違う（0.9 > 0.1000000）",
      a: "2026-10-25T10:00:00.9Z",
      b: "2026-10-25T10:00:00.1000000Z",
      expected: 1,
    },
    { name: "秒精度の基準に対する小数秒つき", a: "2026-10-25T10:00:00.5Z", b: "2026-10-25T10:00:00Z", expected: 1 },
    { name: "翌秒", a: "2026-10-25T10:00:01Z", b: "2026-10-25T10:00:00.9999999Z", expected: 1 },
    {
      name: "100ns の差（.NET の精度）",
      a: "2026-10-25T10:00:00.1234568Z",
      b: "2026-10-25T10:00:00.1234567Z",
      expected: 1,
    },
  ])("$name", ({ a, b, expected }) => {
    expect(comparePreciseTime(time(a), time(b))).toBe(expected);
  });
});

describe("parseStatusDocument", () => {
  const valid = {
    schemaVersion: 1,
    updatedAt: "2026-10-25T10:00:10Z",
    items: [{ key: "Owner/Repo#1", state: "running", receivedAt: "2026-10-25T10:00:00Z", extra: "ignored" }],
    recent: [],
    unknownTopLevel: true,
  };

  it("知らないフィールドを無視し、key を小文字にして読む", () => {
    const parsed = parseStatusDocument(JSON.stringify(valid));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.document.items[0].key).toBe("owner/repo#1");
    }
  });

  it("壊れた項目だけを捨てる", () => {
    const parsed = parseStatusDocument(JSON.stringify({ ...valid, items: [{ key: 1 }, null, valid.items[0]] }));
    expect(parsed.kind === "ok" && parsed.document.items).toHaveLength(1);
  });

  it.each([
    { name: "JSON でない", text: "{", expected: { kind: "invalid" } },
    { name: "配列", text: "[]", expected: { kind: "invalid" } },
    {
      name: "updatedAt が不正",
      text: JSON.stringify({ ...valid, updatedAt: "yesterday" }),
      expected: { kind: "invalid" },
    },
    {
      name: "schemaVersion が非対応",
      text: JSON.stringify({ ...valid, schemaVersion: 2 }),
      expected: { kind: "unsupported_schema", schemaVersion: 2 },
    },
  ])("$name", ({ text, expected }) => {
    expect(parseStatusDocument(text)).toEqual(expected);
  });
});

describe("observe", () => {
  const after = time("2026-10-25T10:00:00.100Z");

  it.each([
    {
      name: "起動待ち（CI 確定待ち）",
      items: [entry({ holdReason: "ciPending", queuePosition: 1 })],
      expected: { kind: "active", state: "waiting", holdReason: "ciPending", round: 1, queuePosition: 1 },
    },
    {
      name: "実行中",
      items: [entry({ state: "running" })],
      expected: { kind: "active", state: "running", holdReason: null, round: 1, queuePosition: null },
    },
    {
      name: "同一秒で受信が後の項目を拾う",
      items: [entry({ receivedAt: "2026-10-25T10:00:00.900Z" })],
      expected: { kind: "active", state: "waiting" },
    },
  ])("$name", ({ items, expected }) => {
    expect(observe(document(items), KEY, after)).toMatchObject(expected);
  });

  it.each([
    { name: "同一秒で受信が前", receivedAt: "2026-10-25T10:00:00.050Z" },
    { name: "同時刻（より後のみ）", receivedAt: "2026-10-25T10:00:00.100Z" },
    { name: "前の round", receivedAt: "2026-10-25T09:00:00Z" },
  ])("$name の項目は拾わず、前の round として報告する", ({ receivedAt }) => {
    expect(observe(document([entry({ receivedAt, state: "running", round: 1 })]), KEY, after)).toEqual({
      kind: "none",
      previousRound: { state: "running", round: 1 },
    });
  });

  it("別の PR の項目は拾わない", () => {
    expect(observe(document([entry({ key: "scottlz0310/other#1" })]), KEY, after)).toEqual({
      kind: "none",
      previousRound: null,
    });
  });

  it("key の大文字小文字を区別しない", () => {
    expect(observe(document([entry({})]), "ScottLz0310/Review-Raven#158", after).kind).toBe("active");
  });

  it("終了（recent）を、今回の round の分だけ拾う", () => {
    const recent = [
      entry({ state: "finished", receivedAt: "2026-10-25T09:00:00Z", outcome: "completed", exitCode: 0, round: 1 }),
      entry({ state: "finished", receivedAt: "2026-10-25T10:00:01Z", outcome: "failed", exitCode: 1, round: 2 }),
    ];
    expect(observe(document([], recent), KEY, after)).toEqual({
      kind: "finished",
      outcome: "failed",
      exitCode: 1,
      round: 2,
      eventId: null,
    });
  });

  it("items と recent の両方にあれば、実行中（items）を優先する", () => {
    const result = observe(
      document(
        [entry({ state: "running", receivedAt: "2026-10-25T10:00:02Z" })],
        [entry({ state: "finished", receivedAt: "2026-10-25T10:00:01Z", outcome: "completed" })],
      ),
      KEY,
      after,
    );
    expect(result.kind).toBe("active");
  });

  it("複数あれば、受信が最も新しい項目を選ぶ", () => {
    const result = observe(
      document([
        entry({ round: 1, receivedAt: "2026-10-25T10:00:01Z" }),
        entry({ round: 2, receivedAt: "2026-10-25T10:00:05Z" }),
      ]),
      KEY,
      after,
    );
    expect(result).toMatchObject({ kind: "active", round: 2 });
  });
});

describe("describeState", () => {
  it.each([
    { state: "waiting", hold: "ciPending", expected: "CI確定待ち(起動前)" },
    { state: "waiting", hold: "busy", expected: "別のレビュー実行中のため待機" },
    { state: "waiting", hold: "manual", expected: "利用者の操作待ち(自動起動off)" },
    { state: "waiting", hold: "autoPause", expected: "自動起動が一時停止中" },
    { state: "waiting", hold: null, expected: "起動待ち(評価中)" },
    { state: "running", hold: null, expected: "レビュー実行中" },
    { state: "finished", hold: null, expected: "プロセス終了(Verdictは別途PRで確認)" },
    { state: "unknown-state", hold: null, expected: "unknown-state" },
  ])("$state/$hold", ({ state, hold, expected }) => {
    expect(describeState(state, hold)).toBe(expected);
  });
});
