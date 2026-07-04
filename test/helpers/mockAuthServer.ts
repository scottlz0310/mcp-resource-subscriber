import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";

export interface MockAuthServerOptions {
  /** Number of authorization_pending responses before the device is approved. */
  pendingPolls?: number;
  /** Number of slow_down responses returned before normal poll handling. */
  slowDownPolls?: number;
  deviceOutcome?: "approved" | "denied" | "expired";
  accessTokenExpiresInSec?: number;
  /** When false, /.well-known/oauth-authorization-server returns 404. */
  serveWellKnown?: boolean;
  /** interval (seconds) advertised by /device_authorization; 0 keeps tests fast. */
  deviceInterval?: number;
}

export interface MockAuthServer {
  origin: string;
  counts: { register: number; deviceAuthorization: number; tokenPolls: number; refresh: number };
  /** Refresh tokens the server currently accepts; rotation removes consumed ones. */
  validRefreshTokens: Set<string>;
  issuedAccessTokens: string[];
  /** When set, refresh grants fail with this OAuth error instead of rotating. */
  refreshFailure: { error: string; status: number } | null;
  close(): Promise<void>;
}

/**
 * In-process authorization server mimicking mcp-gateway's OAuth surface:
 * RFC 7591 /register, RFC 8628 /device_authorization + device grant polling,
 * refresh grant with rotation, and RFC 8414 well-known metadata.
 */
export async function startMockAuthServer(options: MockAuthServerOptions = {}): Promise<MockAuthServer> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const counts = { register: 0, deviceAuthorization: 0, tokenPolls: 0, refresh: 0 };
  const validRefreshTokens = new Set<string>();
  const issuedAccessTokens: string[] = [];
  const deviceOutcome = options.deviceOutcome ?? "approved";
  let pendingRemaining = options.pendingPolls ?? 0;
  let slowDownRemaining = options.slowDownPolls ?? 0;
  let origin = "";

  const handle: MockAuthServer = {
    get origin(): string {
      return origin;
    },
    counts,
    validRefreshTokens,
    issuedAccessTokens,
    refreshFailure: null,
    close: async () => {},
  };

  const issueTokens = (): Record<string, unknown> => {
    const accessToken = `at-${randomUUID()}`;
    const refreshToken = `rt-${randomUUID()}`;
    issuedAccessTokens.push(accessToken);
    validRefreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: options.accessTokenExpiresInSec ?? 3600,
      refresh_token: refreshToken,
    };
  };

  if (options.serveWellKnown !== false) {
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.json({
        issuer: origin,
        registration_endpoint: `${origin}/register`,
        device_authorization_endpoint: `${origin}/device_authorization`,
        token_endpoint: `${origin}/token`,
      });
    });
  }

  app.post("/register", (_req, res) => {
    counts.register++;
    res.status(201).json({ client_id: `client-${counts.register}` });
  });

  app.post("/device_authorization", (_req, res) => {
    counts.deviceAuthorization++;
    res.json({
      device_code: "device-code-1",
      user_code: "ABCD-1234",
      verification_uri: `${origin}/activate`,
      verification_uri_complete: `${origin}/activate?user_code=ABCD-1234`,
      expires_in: 900,
      interval: options.deviceInterval ?? 0,
    });
  });

  app.post("/token", (req, res) => {
    const body = req.body as Record<string, string>;
    if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      counts.tokenPolls++;
      if (slowDownRemaining > 0) {
        slowDownRemaining--;
        res.status(400).json({ error: "slow_down" });
        return;
      }
      if (deviceOutcome === "denied") {
        res.status(400).json({ error: "access_denied" });
        return;
      }
      if (deviceOutcome === "expired") {
        res.status(400).json({ error: "expired_token" });
        return;
      }
      if (pendingRemaining > 0) {
        pendingRemaining--;
        res.status(400).json({ error: "authorization_pending" });
        return;
      }
      res.json(issueTokens());
      return;
    }
    if (body.grant_type === "refresh_token") {
      counts.refresh++;
      if (handle.refreshFailure) {
        res.status(handle.refreshFailure.status).json({ error: handle.refreshFailure.error });
        return;
      }
      if (!body.refresh_token || !validRefreshTokens.has(body.refresh_token)) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      validRefreshTokens.delete(body.refresh_token);
      res.json(issueTokens());
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  handle.close = (): Promise<void> =>
    new Promise((resolvePromise, reject) => httpServer.close((err) => (err ? reject(err) : resolvePromise())));
  return handle;
}
