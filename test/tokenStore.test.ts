import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTokenStore, type StoredToken, type TokenStore } from "../src/client/auth/tokenStore.js";

describe("tokenStore", () => {
  let dir: string;
  let store: TokenStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mrs-tokenstore-"));
    store = openTokenStore(join(dir, "tokens.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const token = (overrides: Partial<StoredToken> = {}): StoredToken => ({
    origin: "http://127.0.0.1:8080",
    clientId: "client-1",
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 1_900_000_000_000,
    ...overrides,
  });

  it("returns null for an unknown origin", () => {
    expect(store.get("http://unknown.example")).toBeNull();
  });

  it("round-trips a saved token set", () => {
    store.save(token());
    expect(store.get("http://127.0.0.1:8080")).toEqual(token());
  });

  it.each([
    ["clientId", { clientId: null }],
    ["refreshToken", { refreshToken: null }],
  ])("preserves null %s", (_field, overrides) => {
    store.save(token(overrides));
    expect(store.get("http://127.0.0.1:8080")).toEqual(token(overrides));
  });

  it("upserts on the same origin (refresh token rotation)", () => {
    store.save(token());
    store.save(token({ accessToken: "at-2", refreshToken: "rt-2", expiresAt: 1_900_000_100_000 }));
    expect(store.get("http://127.0.0.1:8080")).toEqual(
      token({ accessToken: "at-2", refreshToken: "rt-2", expiresAt: 1_900_000_100_000 }),
    );
  });

  it("keeps tokens for different origins independent", () => {
    store.save(token());
    store.save(token({ origin: "http://127.0.0.1:9090", accessToken: "at-other" }));
    expect(store.get("http://127.0.0.1:8080")?.accessToken).toBe("at-1");
    expect(store.get("http://127.0.0.1:9090")?.accessToken).toBe("at-other");
  });

  it("deletes a stored token", () => {
    store.save(token());
    store.delete("http://127.0.0.1:8080");
    expect(store.get("http://127.0.0.1:8080")).toBeNull();
  });

  it("persists across store instances", () => {
    store.save(token());
    store.close();
    store = openTokenStore(join(dir, "tokens.db"));
    expect(store.get("http://127.0.0.1:8080")).toEqual(token());
  });
});
