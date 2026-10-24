import { describe, expect, it } from "vitest";
import type { ResourceStreamResult, StreamEvent } from "../src/client/streamClient.js";
import { formatStreamEnd, formatStreamError, formatStreamEvent } from "../src/client/streamOutput.js";

const parse = (line: string): unknown => JSON.parse(line.trimEnd());

describe("streamOutput", () => {
  it.each([
    [
      "ack",
      { type: "ack", resourceUri: "r://a", honoredUris: ["r://a"] } satisfies StreamEvent,
      { schemaVersion: 1, type: "ack", resourceUri: "r://a", honoredUris: ["r://a"] },
    ],
    [
      "snapshot",
      {
        type: "snapshot",
        source: "notification",
        notificationUri: "r://a",
        text: '{"x":1}',
        json: { x: 1 },
        matched: false,
      } satisfies StreamEvent,
      {
        schemaVersion: 1,
        type: "snapshot",
        source: "notification",
        notificationUri: "r://a",
        text: '{"x":1}',
        json: { x: 1 },
        matched: false,
      },
    ],
  ])("%s 行は schemaVersion を先頭に持つ1行1JSONになる", (_name, event, expected) => {
    const line = formatStreamEvent(event);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(line.startsWith('{"schemaVersion":1,')).toBe(true);
    expect(parse(line)).toEqual(expected);
  });

  it.each([
    [
      "条件一致",
      { matched: true, errorCode: null, closeReason: "local", notificationCount: 3 },
      { reason: "until-matched", errorCode: null, closeReason: "local", notificationCount: 3 },
    ],
    [
      "timeout",
      { matched: false, errorCode: "NOTIFICATION_TIMEOUT", closeReason: "local", notificationCount: 1 },
      { reason: "error", errorCode: "NOTIFICATION_TIMEOUT", closeReason: "local", notificationCount: 1 },
    ],
  ])("end 行（%s）", (_name, partial, expected) => {
    const result = { listenAcknowledged: true, honoredUris: ["r://a"], ...partial } as ResourceStreamResult;
    expect(parse(formatStreamEnd(result))).toEqual({
      schemaVersion: 1,
      type: "end",
      recommendedNextAction: null,
      ...expected,
    });
  });

  it.each([
    ["既定", undefined, null],
    ["対処案つき", "再ログインしてください", "再ログインしてください"],
  ])("ack 前の失敗は end 行だけで報告する（%s）", (_name, hint, expectedHint) => {
    expect(parse(formatStreamError("AUTH_LOGIN_REQUIRED", hint))).toEqual({
      schemaVersion: 1,
      type: "end",
      reason: "error",
      closeReason: null,
      errorCode: "AUTH_LOGIN_REQUIRED",
      notificationCount: 0,
      recommendedNextAction: expectedHint,
    });
  });
});
