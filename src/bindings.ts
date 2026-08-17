import type { Lock, LockNamespace } from "./lock";

export type Bindings = {
  DEFAULT_LOCK_NAMESPACE?: string;
  OIDC_ALGORITHMS?: string;
  OIDC_AUDIENCE?: string;
  OIDC_GRANTS_CLAIM?: string;
  OIDC_ISSUER?: string;
  OIDC_JWKS_URL?: string;
  OIDC_NAMESPACE_CLAIM?: string;
  LOCK: DurableObjectNamespace<Lock>;
  LOCK_NAMESPACE: DurableObjectNamespace<LockNamespace>;
};
