import { afterEach, describe, expect, it } from "vitest";
import {
  discoverEndpoints,
  type OAuthEndpoints,
  OAuthRequestError,
  pollDeviceToken,
  refreshTokenGrant,
  registerClient,
  requestDeviceAuthorization,
} from "../src/client/auth/oauthClient.js";
import { type MockAuthServer, startMockAuthServer } from "./helpers/mockAuthServer.js";

const noSleep = async (): Promise<void> => {};

describe("oauthClient against a mock authorization server", () => {
  let server: MockAuthServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const endpointsOf = (origin: string): OAuthEndpoints => ({
    registrationEndpoint: `${origin}/register`,
    deviceAuthorizationEndpoint: `${origin}/device_authorization`,
    tokenEndpoint: `${origin}/token`,
  });

  it("discovers endpoints from RFC 8414 well-known metadata", async () => {
    server = await startMockAuthServer();
    const endpoints = await discoverEndpoints(server.origin);
    expect(endpoints).toEqual(endpointsOf(server.origin));
  });

  it("falls back to the fixed gateway layout when well-known metadata is absent", async () => {
    server = await startMockAuthServer({ serveWellKnown: false });
    const endpoints = await discoverEndpoints(server.origin);
    expect(endpoints).toEqual(endpointsOf(server.origin));
  });

  it("fails discovery with context when the server is unreachable", async () => {
    await expect(discoverEndpoints("http://127.0.0.1:1")).rejects.toThrow(/Failed to reach authorization server/);
  });

  it("registers a client and returns the issued client_id", async () => {
    server = await startMockAuthServer();
    const clientId = await registerClient(endpointsOf(server.origin));
    expect(clientId).toBe("client-1");
    expect(server.counts.register).toBe(1);
  });

  it("requests device authorization and parses the response", async () => {
    server = await startMockAuthServer();
    const auth = await requestDeviceAuthorization(endpointsOf(server.origin), "client-1");
    expect(auth.deviceCode).toBe("device-code-1");
    expect(auth.userCode).toBe("ABCD-1234");
    expect(auth.verificationUriComplete).toContain("user_code=ABCD-1234");
    expect(auth.expiresIn).toBe(900);
  });

  it("polls through authorization_pending until approval and returns a token set", async () => {
    server = await startMockAuthServer({ pendingPolls: 2, accessTokenExpiresInSec: 3600 });
    const endpoints = endpointsOf(server.origin);
    const auth = await requestDeviceAuthorization(endpoints, "client-1");
    const before = Date.now();
    const tokens = await pollDeviceToken(endpoints, "client-1", auth, { sleepFn: noSleep });
    expect(server.counts.tokenPolls).toBe(3);
    expect(tokens.accessToken).toBe(server.issuedAccessTokens[0]);
    expect(tokens.refreshToken).not.toBeNull();
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it("increases the polling interval by 5 seconds on slow_down (RFC 8628 §3.5)", async () => {
    server = await startMockAuthServer({ slowDownPolls: 1, deviceInterval: 1 });
    const endpoints = endpointsOf(server.origin);
    const auth = await requestDeviceAuthorization(endpoints, "client-1");
    const sleeps: number[] = [];
    await pollDeviceToken(endpoints, "client-1", auth, {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([1000, 6000]);
  });

  it.each([
    ["denied", "access_denied"],
    ["expired", "expired_token"],
  ] as const)("stops polling when the device grant is %s", async (outcome, expectedError) => {
    server = await startMockAuthServer({ deviceOutcome: outcome });
    const endpoints = endpointsOf(server.origin);
    const auth = await requestDeviceAuthorization(endpoints, "client-1");
    const error = await pollDeviceToken(endpoints, "client-1", auth, { sleepFn: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthRequestError);
    expect((error as OAuthRequestError).oauthError).toBe(expectedError);
  });

  it("gives up when the device code expires before approval", async () => {
    server = await startMockAuthServer({ pendingPolls: 1000 });
    const endpoints = endpointsOf(server.origin);
    const auth = await requestDeviceAuthorization(endpoints, "client-1");
    let now = Date.now();
    const error = await pollDeviceToken(endpoints, "client-1", auth, {
      sleepFn: async () => {
        now += 500 * 1000; // each poll advances the clock past the 900s budget quickly
      },
      nowFn: () => now,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthRequestError);
    expect((error as OAuthRequestError).oauthError).toBe("expired_token");
  });

  it("refreshes a token and rotates the refresh token", async () => {
    server = await startMockAuthServer();
    server.validRefreshTokens.add("rt-seed");
    const tokens = await refreshTokenGrant(endpointsOf(server.origin), "client-1", "rt-seed");
    expect(tokens.accessToken).toBe(server.issuedAccessTokens[0]);
    expect(tokens.refreshToken).not.toBe("rt-seed");
    expect(server.validRefreshTokens.has("rt-seed")).toBe(false);
  });

  it("surfaces invalid_grant when the refresh token is unknown", async () => {
    server = await startMockAuthServer();
    const error = await refreshTokenGrant(endpointsOf(server.origin), "client-1", "rt-unknown").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OAuthRequestError);
    expect((error as OAuthRequestError).oauthError).toBe("invalid_grant");
  });
});
