import {
  type DeviceAuthorization,
  discoverEndpoints,
  type FetchLike,
  OAuthRequestError,
  type PollOptions,
  pollDeviceToken,
  refreshTokenGrant,
  registerClient,
  requestDeviceAuthorization,
} from "./oauthClient.js";
import type { TokenStore } from "./tokenStore.js";

/** Refresh the access token this long before it actually expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * The cached credentials cannot be renewed unattended (refresh token missing,
 * expired, or revoked) — the user must run `--login` again.
 */
export class AuthLoginRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthLoginRequiredError";
  }
}

export type AuthSource = "cache" | "cache-refreshed" | "none";

export interface ResolvedAuth {
  token: string | null;
  source: AuthSource;
}

export interface GatewayAuthOptions extends PollOptions {
  fetchFn?: FetchLike;
}

export interface LoginResult {
  origin: string;
  /** Epoch milliseconds when the new access token expires. */
  expiresAt: number;
}

/**
 * Runs the full interactive login: DCR (reusing a cached client_id when one
 * exists) → device authorization → user approval wait → token persistence.
 * `onVerification` fires once the user_code / verification_uri are known so
 * the CLI can prompt the user while polling continues.
 */
export async function loginToGateway(
  url: string,
  store: TokenStore,
  onVerification: (auth: DeviceAuthorization) => void,
  options: GatewayAuthOptions = {},
): Promise<LoginResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const origin = new URL(url).origin;
  const endpoints = await discoverEndpoints(origin, fetchFn);
  const clientId = store.get(origin)?.clientId ?? (await registerClient(endpoints, fetchFn));
  const deviceAuth = await requestDeviceAuthorization(endpoints, clientId, fetchFn);
  onVerification(deviceAuth);
  const tokens = await pollDeviceToken(endpoints, clientId, deviceAuth, options);
  store.save({
    origin,
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  return { origin, expiresAt: tokens.expiresAt };
}

/**
 * Resolves a usable access token from the cache for the given server URL:
 * returns it as-is while still fresh (with a safety margin), refreshes it
 * unattended when expired, and reports `none` when this origin has never been
 * logged in. Explicit tokens (--auth-token / MCP_PROBE_AUTH_TOKEN) must be
 * handled by the caller before consulting the cache — they always win.
 *
 * Throws AuthLoginRequiredError when refresh is impossible (no refresh token
 * or invalid_grant); other errors (network, gateway 5xx) propagate so callers
 * can distinguish "re-login needed" from "retry later".
 */
export async function resolveCachedToken(
  url: string,
  store: TokenStore,
  options: GatewayAuthOptions = {},
): Promise<ResolvedAuth> {
  const fetchFn = options.fetchFn ?? fetch;
  const nowFn = options.nowFn ?? Date.now;
  const origin = new URL(url).origin;
  const cached = store.get(origin);
  if (!cached) {
    return { token: null, source: "none" };
  }
  if (cached.expiresAt - EXPIRY_MARGIN_MS > nowFn()) {
    return { token: cached.accessToken, source: "cache" };
  }
  if (!cached.refreshToken) {
    throw new AuthLoginRequiredError(
      `cached access token for ${origin} is expired and no refresh token is available; run --login again`,
    );
  }
  const endpoints = await discoverEndpoints(origin, fetchFn);
  let tokens: Awaited<ReturnType<typeof refreshTokenGrant>>;
  try {
    tokens = await refreshTokenGrant(endpoints, cached.clientId, cached.refreshToken, fetchFn);
  } catch (error) {
    if (error instanceof OAuthRequestError && error.oauthError === "invalid_grant") {
      throw new AuthLoginRequiredError(
        `gateway ${origin} rejected the cached refresh token (invalid_grant); run --login again`,
        { cause: error },
      );
    }
    throw error;
  }
  store.save({
    origin,
    clientId: cached.clientId,
    accessToken: tokens.accessToken,
    // The gateway rotates refresh tokens; keep the old one only if the
    // response omitted a replacement.
    refreshToken: tokens.refreshToken ?? cached.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  return { token: tokens.accessToken, source: "cache-refreshed" };
}
