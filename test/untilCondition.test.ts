import { describe, expect, it } from "vitest";
import { evaluateSnapshot, evaluateUntil, parseUntil, UntilParseError } from "../src/client/untilCondition.js";

describe("evaluateSnapshot", () => {
  it.each([
    ["非 JSON 本文は空 Pointer の =null に一致しない", "status: pending\nversion: 1", "", null, false, null],
    ["空文字列は非 JSON として不一致", "", "", null, false, null],
    ["JSON の null 本文は空 Pointer の =null に一致する", "null", "", null, true, null],
    ["JSON object の一致", '{"terminal":true}', "/terminal", true, true, { terminal: true }],
    ["JSON object の不一致", '{"terminal":false}', "/terminal", true, false, { terminal: false }],
  ])("%s", (_name, text, pointer, expected, matched, json) => {
    expect(evaluateSnapshot({ pointer, expected }, text)).toEqual({ json, matched });
  });
});

describe("parseUntil", () => {
  it.each([
    ["/terminal=true", { pointer: "/terminal", expected: true }],
    ['/result/kind="approved"', { pointer: "/result/kind", expected: "approved" }],
    ["/revision=3", { pointer: "/revision", expected: 3 }],
    ["/result=null", { pointer: "/result", expected: null }],
    ["=true", { pointer: "", expected: true }],
    ['/a/b="x=y"', { pointer: "/a/b", expected: "x=y" }],
  ])("%s を解釈する", (raw, expected) => {
    expect(parseUntil(raw)).toEqual(expected);
  });

  it.each([
    ["区切りの = がない", "/terminal"],
    ["Pointer が / で始まらない", "terminal=true"],
    ["値が JSON でない", "/kind=approved"],
    ["値が空", "/kind="],
  ])("%s場合は UntilParseError", (_name, raw) => {
    expect(() => parseUntil(raw)).toThrow(UntilParseError);
  });
});

describe("parseUntil のエラー内容", () => {
  it("Git Bash のパス変換で先頭の / が書き換わった場合は原因を示す", () => {
    expect(() => parseUntil("C:/Program Files/Git/terminal=true")).toThrow(/MSYS_NO_PATHCONV=1/);
  });
});

describe("evaluateUntil", () => {
  const document = {
    terminal: false,
    revision: 2,
    result: { kind: "approved", list: [{ id: "a" }, { id: "b" }] },
    "a/b": 1,
    "m~n": 2,
  };

  it.each([
    ["/terminal", false, true],
    ["/terminal", true, false],
    ["/revision", 2, true],
    ["/revision", "2", false],
    ["/result/kind", "approved", true],
    ["/result/list/1/id", "b", true],
    ["/result/list/2/id", "b", false],
    ["/result/list/01/id", "a", false],
    ["/result", { kind: "approved", list: [{ id: "a" }, { id: "b" }] }, true],
    ["/a~1b", 1, true],
    ["/m~0n", 2, true],
    ["/missing", null, false],
    ["/result/kind/x", "approved", false],
  ])("Pointer %s と期待値 %j の一致判定は %s", (pointer, expected, matched) => {
    expect(evaluateUntil({ pointer, expected }, document)).toBe(matched);
  });

  it.each([
    ["JSON でない本文（null）", null],
    ["プリミティブ", 1],
    ["配列", [1, 2]],
  ])("%s は不一致として扱う", (_name, parsed) => {
    expect(evaluateUntil({ pointer: "/terminal", expected: true }, parsed)).toBe(false);
  });

  it("空 Pointer は文書全体を比較する", () => {
    expect(evaluateUntil({ pointer: "", expected: [1, 2] }, [1, 2])).toBe(true);
  });
});
