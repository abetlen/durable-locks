import { verifying } from "hono/utils/jwt/jws";
import type { Bindings } from "./bindings";
import {
  grantMatchesLock,
  type LockAccessGrant,
  type LockMetadata,
} from "./lock";
import { LockNamespaceNameSchema, MetadataSchema } from "./utils";
import { z } from "zod";

const SUPPORTED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

type OidcAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

type OidcConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  accessClaim: string;
  accessClaimMode: "grants" | "namespaces";
  algorithms: OidcAlgorithm[];
};

type OidcJwk = JsonWebKey & {
  alg?: string;
  kid?: string;
  use?: string;
};

type CachedJwks = {
  fetchedAt: number;
  expiresAt: number;
  keys: OidcJwk[];
};

type JwtHeader = {
  alg?: unknown;
  crit?: unknown;
  kid?: unknown;
  typ?: unknown;
};

export type Authorization = {
  grants: LockAccessGrant[];
  scopes: string[];
  subject: string | null;
};

export type AuthenticationResult =
  | {
      outcome: "authenticated";
      authorization: Authorization;
    }
  | {
      outcome: "disabled";
    }
  | {
      outcome: "configuration_error";
      error: unknown;
    }
  | {
      outcome: "provider_unavailable";
      error: unknown;
    }
  | {
      outcome: "unauthorized";
      error?: unknown;
    };

const jwksCache = new Map<string, CachedJwks>();

class OidcProviderUnavailableError extends Error {}

const configuredValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const oidcConfig = (env: Bindings): OidcConfig | null => {
  const issuer = configuredValue(env.OIDC_ISSUER);
  const audience = configuredValue(env.OIDC_AUDIENCE);
  const jwksUrl = configuredValue(env.OIDC_JWKS_URL);
  const grantsClaim = configuredValue(env.OIDC_GRANTS_CLAIM);
  const namespaceClaim = configuredValue(env.OIDC_NAMESPACE_CLAIM);
  const configuredAlgorithms = configuredValue(env.OIDC_ALGORITHMS);
  const configuredValues = [
    issuer,
    audience,
    jwksUrl,
    grantsClaim,
    namespaceClaim,
    configuredAlgorithms,
  ];
  if (configuredValues.every((value) => value === undefined)) {
    return null;
  }
  if (
    issuer === undefined ||
    audience === undefined ||
    jwksUrl === undefined ||
    (grantsClaim === undefined) === (namespaceClaim === undefined)
  ) {
    throw new Error("OIDC configuration is incomplete");
  }
  let normalizedJwksUrl: string;
  try {
    normalizedJwksUrl = new URL(jwksUrl as string).toString();
  } catch {
    throw new Error("OIDC_JWKS_URL is invalid");
  }

  const requestedAlgorithms = (configuredAlgorithms ?? "RS256")
    .split(",")
    .map((algorithm) => algorithm.trim())
    .filter((algorithm) => algorithm.length > 0);
  const algorithms = requestedAlgorithms.filter(
    (algorithm): algorithm is OidcAlgorithm =>
      SUPPORTED_ALGORITHMS.includes(algorithm as OidcAlgorithm),
  );
  if (
    algorithms.length === 0 ||
    algorithms.length !== requestedAlgorithms.length
  ) {
    throw new Error("OIDC_ALGORITHMS contains an unsupported algorithm");
  }

  return {
    issuer: issuer as string,
    audience: audience as string,
    jwksUrl: normalizedJwksUrl,
    accessClaim: (grantsClaim ?? namespaceClaim) as string,
    accessClaimMode: grantsClaim === undefined ? "namespaces" : "grants",
    algorithms,
  };
};

const decodeBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const decodeJsonSegment = (value: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as Record<
    string,
    unknown
  >;

const fetchJwks = async (
  jwksUrl: string,
  forceRefresh = false,
): Promise<CachedJwks> => {
  const now = Date.now();
  const cached = jwksCache.get(jwksUrl);
  if (!forceRefresh && cached !== undefined && cached.expiresAt > now) {
    return cached;
  }
  let response: Response;
  try {
    response = await fetch(jwksUrl, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new OidcProviderUnavailableError(
      `failed to fetch the OIDC JWKS: ${String(error)}`,
    );
  }
  if (!response.ok) {
    throw new OidcProviderUnavailableError(
      `OIDC JWKS endpoint returned HTTP ${response.status}`,
    );
  }
  const document = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new OidcProviderUnavailableError(
      "OIDC JWKS document contains no keys",
    );
  }
  const keys = document.keys.filter(
    (key): key is OidcJwk => typeof key === "object" && key !== null,
  );
  if (keys.length !== document.keys.length) {
    throw new OidcProviderUnavailableError(
      "OIDC JWKS document contains an invalid key",
    );
  }
  const fetched = {
    fetchedAt: now,
    expiresAt: now + 5 * 60 * 1000,
    keys,
  };
  jwksCache.set(jwksUrl, fetched);
  return fetched;
};

const matchingKey = (
  keys: OidcJwk[],
  kid: string,
  algorithm: OidcAlgorithm,
): OidcJwk | undefined =>
  keys.find(
    (key) =>
      key.kid === kid &&
      (key.alg === undefined || key.alg === algorithm) &&
      (key.use === undefined || key.use === "sig") &&
      (key.key_ops === undefined || key.key_ops.includes("verify")),
  );

const verifyAccessToken = async (
  token: string,
  config: OidcConfig,
): Promise<Record<string, unknown>> => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("OIDC access token is not a compact JWT");
  }
  const header = decodeJsonSegment(parts[0] as string) as JwtHeader;
  if (
    typeof header.alg !== "string" ||
    !config.algorithms.includes(header.alg as OidcAlgorithm)
  ) {
    throw new Error("OIDC access token uses an untrusted algorithm");
  }
  const algorithm = header.alg as OidcAlgorithm;
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new Error("OIDC access token has no key ID");
  }
  if (
    header.typ !== undefined &&
    (typeof header.typ !== "string" ||
      !["jwt", "at+jwt"].includes(header.typ.toLowerCase()))
  ) {
    throw new Error("OIDC access token has an unsupported type");
  }
  if (header.crit !== undefined) {
    throw new Error("OIDC access token uses unsupported critical headers");
  }

  let jwks = await fetchJwks(config.jwksUrl);
  let key = matchingKey(jwks.keys, header.kid, algorithm);
  if (key === undefined && Date.now() - jwks.fetchedAt >= 30_000) {
    jwks = await fetchJwks(config.jwksUrl, true);
    key = matchingKey(jwks.keys, header.kid, algorithm);
  }
  if (key === undefined) {
    throw new Error("OIDC access token references an unknown key");
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  const verified = await verifying(
    key,
    algorithm,
    decodeBase64Url(parts[2] as string),
    new TextEncoder().encode(signingInput),
  );
  if (!verified) {
    throw new Error("OIDC access token signature does not match");
  }

  const claims = decodeJsonSegment(parts[1] as string);
  const now = Math.floor(Date.now() / 1000);
  const audience = claims.aud;
  if (
    claims.iss !== config.issuer ||
    !(
      audience === config.audience ||
      (Array.isArray(audience) && audience.includes(config.audience))
    )
  ) {
    throw new Error("OIDC access token issuer or audience does not match");
  }
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now - 5
  ) {
    throw new Error("OIDC access token is expired or has no expiration");
  }
  if (
    typeof claims.iat !== "number" ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 5
  ) {
    throw new Error("OIDC access token has an invalid issued-at time");
  }
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== "number" ||
      !Number.isFinite(claims.nbf) ||
      claims.nbf > now + 5)
  ) {
    throw new Error("OIDC access token is not active yet");
  }
  return claims;
};

const stringValues = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.split(/\s+/).filter((entry) => entry.length > 0);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return [];
};

const scopesFromClaims = (claims: Record<string, unknown>): string[] => [
  ...new Set([
    ...stringValues(claims.scope),
    ...stringValues(claims.scp),
  ]),
];

const GrantNamespaceSchema = z.union([
  LockNamespaceNameSchema,
  z.literal("*"),
]);

const LockAccessGrantClaimSchema = z
  .object({
    namespace: GrantNamespaceSchema,
    metadata: MetadataSchema.optional().default({}),
  })
  .strict();

const LockAccessGrantsClaimSchema = z.array(LockAccessGrantClaimSchema);

const grantsFromClaim = (value: unknown): LockAccessGrant[] => {
  const parsed = LockAccessGrantsClaimSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

const namespaceGrantsFromClaim = (value: unknown): LockAccessGrant[] =>
  stringValues(value)
    .filter(
      (namespace) =>
        namespace === "*" ||
        LockNamespaceNameSchema.safeParse(namespace).success,
    )
    .map((namespace) => ({ namespace, metadata: {} }));

const accessGrantsFromClaims = (
  claims: Record<string, unknown>,
  config: OidcConfig,
): LockAccessGrant[] =>
  config.accessClaimMode === "grants"
    ? grantsFromClaim(claims[config.accessClaim])
    : namespaceGrantsFromClaim(claims[config.accessClaim]);

export const authenticate = async (
  env: Bindings,
  token: string | undefined,
): Promise<AuthenticationResult> => {
  let config: OidcConfig | null;
  try {
    config = oidcConfig(env);
  } catch (error) {
    return { outcome: "configuration_error", error };
  }
  if (config === null) {
    return { outcome: "disabled" };
  }
  if (token === undefined) {
    return { outcome: "unauthorized" };
  }

  try {
    const claims = await verifyAccessToken(token, config);
    return {
      outcome: "authenticated",
      authorization: {
        grants: accessGrantsFromClaims(claims, config),
        scopes: scopesFromClaims(claims),
        subject: typeof claims.sub === "string" ? claims.sub : null,
      },
    };
  } catch (error) {
    if (error instanceof OidcProviderUnavailableError) {
      return { outcome: "provider_unavailable", error };
    }
    return { outcome: "unauthorized", error };
  }
};

export const hasScope = (
  authorization: Authorization | null,
  scope: "locks:read" | "locks:write" | "locks:admin",
): boolean => authorization === null || authorization.scopes.includes(scope);

const grantAppliesToNamespace = (
  authorization: Authorization,
  grant: LockAccessGrant,
  namespace: string,
): boolean =>
  grant.namespace === namespace ||
  (grant.namespace === "*" &&
    authorization.scopes.includes("locks:admin"));

export const hasNamespaceAccess = (
  authorization: Authorization | null,
  namespace: string,
): boolean =>
  authorization === null ||
  authorization.grants.some(
    (grant) => grantAppliesToNamespace(authorization, grant, namespace),
  );

export const hasLockAccess = (
  authorization: Authorization | null,
  namespace: string,
  metadata: LockMetadata,
): boolean =>
  authorization === null ||
  authorization.grants.some(
    (grant) =>
      grantAppliesToNamespace(authorization, grant, namespace) &&
      grantMatchesLock(grant, namespace, metadata),
  );

export const namespaceMetadataGrants = (
  authorization: Authorization | null,
  namespace: string,
): LockMetadata[] | undefined => {
  if (authorization === null) {
    return undefined;
  }
  return authorization.grants
    .filter(
      (grant) => grantAppliesToNamespace(authorization, grant, namespace),
    )
    .map((grant) => grant.metadata);
};

export const directLockGrants = (
  authorization: Authorization | null,
): LockAccessGrant[] | undefined => {
  if (authorization === null) {
    return undefined;
  }
  return authorization.grants.filter(
    (grant) =>
      grant.namespace !== "*" ||
      authorization.scopes.includes("locks:admin"),
  );
};
