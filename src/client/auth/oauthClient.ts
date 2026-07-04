/**
 * Minimal OAuth 2.0 client for mcp-gateway style authorization servers:
 * RFC 8414 metadata discovery, RFC 7591 dynamic client registration,
 * RFC 8628 device authorization grant, and RFC 6749 §6 refresh grant.
 *
 * All network access goes through an injectable fetch so tests can point at
 * an in-process mock authorization server.
 */

export type FetchLike = typeof fetch;

export interface OAuthEndpoints {
  registrationEndpoint: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum polling interval in seconds. */
  interval: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

/** OAuth error responses (RFC 6749 §5.2) surfaced with their error code. */
export class OAuthRequestError extends Error {
  constructor(
    readonly oauthError: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OAuthRequestError";
  }
}

const CLIENT_NAME = "mcp-resource-subscriber";

async function readOAuthError(response: Response, context: string): Promise<OAuthRequestError> {
  let oauthError = "unknown_error";
  let description = "";
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === "string") {
      oauthError = body.error;
    }
    if (typeof body.error_description === "string") {
      description = body.error_description;
    }
  } catch {
    // non-JSON error body — keep the generic code
  }
  const detail = description ? `: ${description}` : "";
  return new OAuthRequestError(oauthError, response.status, `${context} failed (${oauthError}${detail})`);
}

/**
 * Discovers OAuth endpoints via RFC 8414 well-known metadata, falling back to
 * mcp-gateway's fixed layout (/register, /device_authorization, /token) when
 * the metadata document is unavailable or incomplete.
 */
export async function discoverEndpoints(
  origin: string,
  fetchFn: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<OAuthEndpoints> {
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", origin).href;
  let response: Response;
  try {
    response = await fetchFn(metadataUrl, { signal });
  } catch (error) {
    throw new Error(`Failed to reach authorization server at ${origin}: ${String(error)}`, { cause: error });
  }
  if (response.ok) {
    const doc = (await response.json()) as Record<string, unknown>;
    if (
      typeof doc.registration_endpoint === "string" &&
      typeof doc.device_authorization_endpoint === "string" &&
      typeof doc.token_endpoint === "string"
    ) {
      return {
        registrationEndpoint: doc.registration_endpoint,
        deviceAuthorizationEndpoint: doc.device_authorization_endpoint,
        tokenEndpoint: doc.token_endpoint,
      };
    }
  }
  return {
    registrationEndpoint: new URL("/register", origin).href,
    deviceAuthorizationEndpoint: new URL("/device_authorization", origin).href,
    tokenEndpoint: new URL("/token", origin).href,
  };
}

/** Registers a public client via RFC 7591 DCR and returns the issued client_id. */
export async function registerClient(endpoints: OAuthEndpoints, fetchFn: FetchLike = fetch): Promise<string> {
  const response = await fetchFn(endpoints.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });
  if (!response.ok) {
    throw await readOAuthError(response, "dynamic client registration");
  }
  const doc = (await response.json()) as { client_id?: unknown };
  if (typeof doc.client_id !== "string" || doc.client_id === "") {
    throw new Error("dynamic client registration response is missing client_id");
  }
  return doc.client_id;
}

export async function requestDeviceAuthorization(
  endpoints: OAuthEndpoints,
  clientId: string,
  fetchFn: FetchLike = fetch,
): Promise<DeviceAuthorization> {
  const response = await fetchFn(endpoints.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  if (!response.ok) {
    throw await readOAuthError(response, "device authorization request");
  }
  const doc = (await response.json()) as Record<string, unknown>;
  if (typeof doc.device_code !== "string" || typeof doc.user_code !== "string") {
    throw new Error("device authorization response is missing device_code or user_code");
  }
  const verificationUriComplete =
    typeof doc.verification_uri_complete === "string" ? doc.verification_uri_complete : null;
  const verificationUri = typeof doc.verification_uri === "string" ? doc.verification_uri : verificationUriComplete;
  if (!verificationUri) {
    throw new Error("device authorization response is missing verification_uri");
  }
  return {
    deviceCode: doc.device_code,
    userCode: doc.user_code,
    verificationUri,
    verificationUriComplete,
    expiresIn: typeof doc.expires_in === "number" ? doc.expires_in : 900,
    interval: typeof doc.interval === "number" ? doc.interval : 5,
  };
}

function parseTokenResponse(doc: Record<string, unknown>, now: number): TokenSet {
  if (typeof doc.access_token !== "string" || doc.access_token === "") {
    throw new Error("token response is missing access_token");
  }
  const expiresInSec = typeof doc.expires_in === "number" ? doc.expires_in : 0;
  return {
    accessToken: doc.access_token,
    refreshToken: typeof doc.refresh_token === "string" ? doc.refresh_token : null,
    expiresAt: now + expiresInSec * 1000,
  };
}

export interface PollOptions {
  fetchFn?: FetchLike;
  /** Injectable sleep so tests can run the polling loop without real delays. */
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the token endpoint until the user approves the device (RFC 8628 §3.4/§3.5):
 * waits `interval` seconds between polls, adds 5 seconds on `slow_down`, keeps
 * polling on `authorization_pending`, and fails on any other OAuth error.
 */
export async function pollDeviceToken(
  endpoints: OAuthEndpoints,
  clientId: string,
  deviceAuth: DeviceAuthorization,
  options: PollOptions = {},
): Promise<TokenSet> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const nowFn = options.nowFn ?? Date.now;
  let intervalSec = deviceAuth.interval;
  const deadline = nowFn() + deviceAuth.expiresIn * 1000;

  while (true) {
    await sleepFn(intervalSec * 1000);
    if (nowFn() > deadline) {
      throw new OAuthRequestError("expired_token", 0, "device code expired before the user approved the device");
    }
    const response = await fetchFn(endpoints.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceAuth.deviceCode,
        client_id: clientId,
      }).toString(),
    });
    if (response.ok) {
      return parseTokenResponse((await response.json()) as Record<string, unknown>, nowFn());
    }
    const error = await readOAuthError(response, "device token request");
    switch (error.oauthError) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalSec += 5;
        continue;
      default:
        throw error;
    }
  }
}

/**
 * Exchanges a refresh token for a fresh token set (RFC 6749 §6). mcp-gateway
 * rotates refresh tokens on every exchange, so callers must persist the
 * returned refreshToken immediately — the presented one is now consumed.
 * An `invalid_grant` OAuthRequestError means the refresh token is dead and a
 * new interactive login is required.
 */
export async function refreshTokenGrant(
  endpoints: OAuthEndpoints,
  clientId: string | null,
  refreshToken: string,
  fetchFn: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (clientId) {
    params.set("client_id", clientId);
  }
  const response = await fetchFn(endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal,
  });
  if (!response.ok) {
    throw await readOAuthError(response, "refresh token grant");
  }
  return parseTokenResponse((await response.json()) as Record<string, unknown>, Date.now());
}
