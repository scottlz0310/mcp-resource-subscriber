import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthLoginRequiredError,
  AuthTimeoutError,
  loginToGateway,
  resolveCachedToken,
} from "../src/client/auth/gatewayAuth.js";
import { OAuthRequestError } from "../src/client/auth/oauthClient.js";
import { openTokenStore, type TokenStore } from "../src/client/auth/tokenStore.js";
import { type MockAuthServer, startMockAuthServer } from "./helpers/mockAuthServer.js";

const noSleep = async (): Promise<void> => {};

describe("gatewayAuth", () => {
  let dir: string;
  let store: TokenStore;
  let server: MockAuthServer | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mrs-gatewayauth-"));
    store = openTokenStore(join(dir, "tokens.db"));
  });

  afterEach(async () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    await server?.close();
    server = null;
  });

  describe("loginToGateway", () => {
    it("runs DCR → device flow → poll and persists the token set", async () => {
      server = await startMockAuthServer({ pendingPolls: 1 });
      const url = `${server.origin}/mcp/subscribe-probe`;
      let sawUserCode = "";
      const result = await loginToGateway(
        url,
        store,
        (auth) => {
          sawUserCode = auth.userCode;
        },
        { sleepFn: noSleep },
      );
      expect(sawUserCode).toBe("ABCD-1234");
      expect(result.origin).toBe(server.origin);
      const cached = store.get(server.origin);
      expect(cached?.accessToken).toBe(server.issuedAccessTokens[0]);
      expect(cached?.refreshToken).not.toBeNull();
      expect(cached?.clientId).toBe("client-1");
      expect(server.counts.register).toBe(1);
    });

    it("reuses the cached client_id instead of re-registering", async () => {
      server = await startMockAuthServer();
      store.save({
        origin: server.origin,
        clientId: "client-cached",
        accessToken: "at-old",
        refreshToken: null,
        expiresAt: 0,
      });
      await loginToGateway(server.origin, store, () => {}, { sleepFn: noSleep });
      expect(server.counts.register).toBe(0);
      expect(store.get(server.origin)?.clientId).toBe("client-cached");
    });

    it("re-registers when the gateway no longer recognizes the cached client_id (invalid_client)", async () => {
      server = await startMockAuthServer({ pendingPolls: 1 });
      server.rejectedClientIds.add("client-stale");
      store.save({
        origin: server.origin,
        clientId: "client-stale",
        accessToken: "at-old",
        refreshToken: null,
        expiresAt: 0,
      });
      const result = await loginToGateway(server.origin, store, () => {}, { sleepFn: noSleep });
      expect(result.origin).toBe(server.origin);
      expect(server.counts.register).toBe(1);
      expect(store.get(server.origin)?.clientId).toBe("client-1");
    });
  });

  describe("resolveCachedToken", () => {
    it("returns none when the origin was never logged in", async () => {
      const resolved = await resolveCachedToken("http://127.0.0.1:1/mcp", store);
      expect(resolved).toEqual({ token: null, source: "none" });
    });

    it("returns the cached token while it is still fresh, without any network access", async () => {
      store.save({
        origin: "http://127.0.0.1:1",
        clientId: "client-1",
        accessToken: "at-fresh",
        refreshToken: "rt-1",
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      // origin points at a closed port: a network call would fail the test
      const resolved = await resolveCachedToken("http://127.0.0.1:1/mcp", store);
      expect(resolved).toEqual({ token: "at-fresh", source: "cache" });
    });

    it("refreshes an expired token unattended and persists the rotated refresh token", async () => {
      server = await startMockAuthServer();
      server.validRefreshTokens.add("rt-seed");
      store.save({
        origin: server.origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      const resolved = await resolveCachedToken(`${server.origin}/mcp`, store);
      expect(resolved.source).toBe("cache-refreshed");
      expect(resolved.token).toBe(server.issuedAccessTokens[0]);
      const cached = store.get(server.origin);
      expect(cached?.accessToken).toBe(server.issuedAccessTokens[0]);
      expect(cached?.refreshToken).not.toBe("rt-seed");
      expect(server.validRefreshTokens.has(cached?.refreshToken ?? "")).toBe(true);
    });

    it("treats a token expiring within the safety margin as expired", async () => {
      server = await startMockAuthServer();
      server.validRefreshTokens.add("rt-seed");
      store.save({
        origin: server.origin,
        clientId: "client-1",
        accessToken: "at-nearly-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() + 60 * 1000, // inside the 5-minute margin
      });
      const resolved = await resolveCachedToken(`${server.origin}/mcp`, store);
      expect(resolved.source).toBe("cache-refreshed");
    });

    it("requires re-login when the cached entry has no refresh token", async () => {
      store.save({
        origin: "http://127.0.0.1:1",
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: null,
        expiresAt: Date.now() - 1000,
      });
      await expect(resolveCachedToken("http://127.0.0.1:1/mcp", store)).rejects.toThrow(AuthLoginRequiredError);
    });

    it("requires re-login when the gateway rejects the refresh token (invalid_grant)", async () => {
      server = await startMockAuthServer();
      store.save({
        origin: server.origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-revoked",
        expiresAt: Date.now() - 1000,
      });
      await expect(resolveCachedToken(`${server.origin}/mcp`, store)).rejects.toThrow(AuthLoginRequiredError);
    });

    it("requires re-login when the gateway no longer recognizes the cached client (invalid_client)", async () => {
      server = await startMockAuthServer();
      server.rejectedClientIds.add("client-stale");
      store.save({
        origin: server.origin,
        clientId: "client-stale",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      await expect(resolveCachedToken(`${server.origin}/mcp`, store)).rejects.toThrow(AuthLoginRequiredError);
    });

    it("raises AuthTimeoutError instead of hanging when the network calls exceed timeoutMs", async () => {
      server = await startMockAuthServer();
      store.save({
        origin: server.origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      // Mimics a gateway that accepts the connection but never responds:
      // the fetch never resolves on its own, only when its AbortSignal fires.
      // Rejects with the signal's own `reason` (as real fetch() does) so
      // this exercises AbortSignal.timeout()'s actual "TimeoutError" rather
      // than the "AbortError" a manual AbortController.abort() would use.
      const hangingFetch: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        });
      await expect(
        resolveCachedToken(`${server.origin}/mcp`, store, { fetchFn: hangingFetch, timeoutMs: 50 }),
      ).rejects.toThrow(AuthTimeoutError);
    });

    it("counts lock-wait time against the timeout budget, not just the network calls", async () => {
      server = await startMockAuthServer();
      server.validRefreshTokens.add("rt-seed");
      const origin = server.origin;
      store.save({
        origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      // Simulates a concurrent process holding BEGIN IMMEDIATE long enough
      // that lock acquisition alone consumes the entire timeoutMs budget.
      const slowLockStore: TokenStore = {
        ...store,
        withExclusiveLock: async <T>(fn: () => Promise<T>): Promise<T> => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return store.withExclusiveLock(fn);
        },
      };
      await expect(resolveCachedToken(`${origin}/mcp`, slowLockStore, { timeoutMs: 50 })).rejects.toThrow(
        AuthTimeoutError,
      );
      // The already-spent budget must fail fast instead of starting a
      // network call with an already-expired signal.
      expect(server.counts.refresh).toBe(0);
    });

    it("bounds actual SQLite lock-wait time by timeoutMs instead of the connection's busy_timeout default", async () => {
      server = await startMockAuthServer();
      const origin = server.origin;
      store.save({
        origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      // A second connection to the same file holds BEGIN IMMEDIATE so
      // `store`'s own lock acquisition below must actually wait on SQLite's
      // busy_timeout mechanism, not just an application-level mock.
      const holder = openTokenStore(join(dir, "tokens.db"));
      let releaseHolder = (): void => {};
      let resolveAcquired!: () => void;
      const holderLockAcquired = new Promise<void>((resolve) => {
        resolveAcquired = resolve;
      });
      const holderTask = holder.withExclusiveLock(async () => {
        resolveAcquired();
        await new Promise<void>((resolveRelease) => {
          releaseHolder = resolveRelease;
        });
      });
      await holderLockAcquired;
      try {
        const startedAt = Date.now();
        await expect(resolveCachedToken(`${origin}/mcp`, store, { timeoutMs: 200 })).rejects.toThrow(AuthTimeoutError);
        // Generous slack for scheduling jitter, but must stay well under the
        // connection's 5000ms default busy_timeout that caused the original
        // bug (thread-owl measured ~4.6s against an unbounded busy_timeout).
        expect(Date.now() - startedAt).toBeLessThan(2000);
      } finally {
        releaseHolder();
        await holderTask;
        holder.close();
      }
    });

    it("skips the network refresh when another process already refreshed while waiting for the lock", async () => {
      server = await startMockAuthServer();
      const origin = server.origin;
      store.save({
        origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      // Wraps the real store so the re-check inside withExclusiveLock
      // observes another process having already refreshed and persisted
      // fresh tokens while this call was waiting for the lock.
      let checkedInsideLock = false;
      const winnerAwareStore: TokenStore = {
        ...store,
        get(o: string) {
          const result = store.get(o);
          if (!checkedInsideLock) {
            checkedInsideLock = true;
            return result;
          }
          store.save({
            origin,
            clientId: "client-1",
            accessToken: "at-winner",
            refreshToken: "rt-winner",
            expiresAt: Date.now() + 60 * 60 * 1000,
          });
          return store.get(o);
        },
      };
      const resolved = await resolveCachedToken(`${origin}/mcp`, winnerAwareStore);
      expect(resolved).toEqual({ token: "at-winner", source: "cache-refreshed" });
      // The network refresh must have been skipped entirely.
      expect(server.counts.refresh).toBe(0);
    });

    it("keeps the rotated refresh token valid for the next refresh (no family revoke from a double presentation)", async () => {
      server = await startMockAuthServer();
      server.validRefreshTokens.add("rt-seed");
      const origin = server.origin;
      store.save({
        origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      const first = await resolveCachedToken(`${origin}/mcp`, store);
      expect(first.source).toBe("cache-refreshed");
      const rotated = store.get(origin);
      if (!rotated) {
        throw new Error("expected a stored token after the first refresh");
      }
      expect(rotated.refreshToken).not.toBe("rt-seed");

      // Force the (already-fresh) cached entry to look expired again to
      // exercise a second refresh with the rotated token — this only
      // succeeds if "rt-seed" was never presented to the gateway twice.
      store.save({ ...rotated, expiresAt: Date.now() - 1000 });
      const second = await resolveCachedToken(`${origin}/mcp`, store);
      expect(second.source).toBe("cache-refreshed");
      expect(server.counts.refresh).toBe(2);
    });

    it("propagates transient gateway errors so callers can retry instead of re-authenticating", async () => {
      server = await startMockAuthServer();
      server.refreshFailure = { error: "temporarily_unavailable", status: 503 };
      server.validRefreshTokens.add("rt-seed");
      store.save({
        origin: server.origin,
        clientId: "client-1",
        accessToken: "at-expired",
        refreshToken: "rt-seed",
        expiresAt: Date.now() - 1000,
      });
      const error = await resolveCachedToken(`${server.origin}/mcp`, store).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OAuthRequestError);
      expect(error).not.toBeInstanceOf(AuthLoginRequiredError);
      // The cached refresh token must survive a transient failure.
      expect(store.get(server.origin)?.refreshToken).toBe("rt-seed");
    });
  });
});
