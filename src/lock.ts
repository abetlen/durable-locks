import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./bindings";

export const DEFAULT_LOCK_NAMESPACE = "default";
export const MAX_LOCK_TTL_SECONDS = 60 * 60;

type LockRegistryState = "creating" | "active";

type LockRegistryRow = {
  id: string;
  name: string;
  max_ttl_seconds: number;
  metadata: string;
  created_at: number;
  state: LockRegistryState;
};

type LockConfigRow = {
  id: string;
  namespace: string;
  name: string;
  max_ttl_seconds: number;
  metadata: string;
  created_at: number;
  epoch: number;
  active_lease: string | null;
  signing_jwk: string;
};

type StoredLeaseRow = {
  name: string;
  lease_id: string;
  ttl_seconds: number;
  acquired_at_ms: number;
  expires_at_ms: number;
  fencing_token: string | null;
};

export type FencingPublicJwk = {
  kty: "EC";
  crv: "P-256";
  alg: "ES256";
  use: "sig";
  kid: string;
  x: string;
  y: string;
};

export type LockJwks = {
  keys: [FencingPublicJwk];
};

export type LockMetadata = Record<string, string>;

export type LockAccessGrant = {
  namespace: string;
  metadata: LockMetadata;
};

export const grantMatchesLock = (
  grant: LockAccessGrant,
  namespace: string,
  metadata: LockMetadata,
): boolean =>
  (grant.namespace === namespace || grant.namespace === "*") &&
  Object.entries(grant.metadata).every(
    ([key, value]) => metadata[key] === value,
  );

export type LockLease = {
  name: string;
  lease_id: string;
  epoch: number;
  ttl_seconds: number;
  acquired_at: number;
  expires_at: number;
  fencing_token: string;
};

export type LockLeaseSummary = {
  id: string;
  name: string;
  ttl_seconds: number;
  acquired_at: number;
  expires_at: number;
};

export type LockSnapshot = {
  namespace: string;
  name: string;
  max_ttl_seconds: number;
  metadata: LockMetadata;
  created_at: number;
  epoch: number;
  lease: LockLeaseSummary | null;
};

export type LockCreationResult =
  | {
      outcome: "created" | "existing";
      id: string;
      snapshot: LockSnapshot;
    }
  | {
      outcome: "conflict";
      reason: "max_ttl_mismatch" | "metadata_mismatch";
    };

export type LockAcquireResult =
  | {
      outcome: "created" | "existing";
      lease: LockLease;
    }
  | {
      outcome: "conflict";
      reason: "already_leased" | "name_mismatch";
      expires_at?: number;
    }
  | {
      outcome: "invalid";
      reason: "ttl_exceeds_maximum";
      max_ttl_seconds: number;
    }
  | {
      outcome: "not_found";
    };

type LockAcquirePreparation =
  | {
      outcome: "created" | "existing";
      lease: StoredLeaseRow;
      epoch: number;
    }
  | {
      outcome: "conflict";
      reason: "already_leased" | "name_mismatch";
      expires_at?: number;
    }
  | {
      outcome: "invalid";
      reason: "ttl_exceeds_maximum";
      max_ttl_seconds: number;
    }
  | {
      outcome: "not_found";
    };

export type LockReleaseResult =
  | { outcome: "released" | "absent" }
  | { outcome: "conflict"; reason: "different_active_lease" }
  | { outcome: "not_found" };

export type LockDeleteResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" };

export type LockListItem = {
  id: string;
  name: string;
  max_ttl_seconds: number;
  metadata: LockMetadata;
  created_at: number;
};

export type LockCursor = {
  created_at_ms: number;
  rowid: number;
};

export type LockPage = {
  data: LockListItem[];
  has_more: boolean;
  next_position: LockCursor | null;
};

const serializeMetadata = (metadata: LockMetadata): string =>
  JSON.stringify(
    Object.fromEntries(
      // oxlint-disable-next-line unicorn/no-array-sort -- Object.entries returns a fresh array.
      Object.entries(metadata).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );

type FencingPrivateJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  alg: "ES256";
  use: "sig";
  kid: string;
  x: string;
  y: string;
  d: string;
};

type SignedStoredLeaseRow = StoredLeaseRow & {
  fencing_token: string;
};

const publicJwk = (key: FencingPrivateJwk): FencingPublicJwk => ({
  kty: key.kty,
  crv: key.crv,
  alg: key.alg,
  use: key.use,
  kid: key.kid,
  x: key.x,
  y: key.y,
});

const base64UrlEncode = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const base64UrlEncodeJson = (value: unknown): string =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

const publicLease = (
  lease: SignedStoredLeaseRow,
  epoch: number,
): LockLease => ({
  name: lease.name,
  lease_id: lease.lease_id,
  epoch,
  ttl_seconds: lease.ttl_seconds,
  acquired_at: Math.floor(lease.acquired_at_ms / 1000),
  expires_at: Math.floor(lease.expires_at_ms / 1000),
  fencing_token: lease.fencing_token,
});

const leaseSummary = (
  lease: StoredLeaseRow,
): LockLeaseSummary => ({
  id: lease.lease_id,
  name: lease.name,
  ttl_seconds: lease.ttl_seconds,
  acquired_at: Math.floor(lease.acquired_at_ms / 1000),
  expires_at: Math.floor(lease.expires_at_ms / 1000),
});

export class Lock extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS lock_config (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          name TEXT NOT NULL,
          max_ttl_seconds INTEGER NOT NULL,
          metadata TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          epoch INTEGER NOT NULL,
          active_lease TEXT,
          signing_jwk TEXT NOT NULL
        )
      `);
    });
  }

  private config(): LockConfigRow | undefined {
    return this.ctx.storage.sql
      .exec<LockConfigRow>(
        `SELECT id, namespace, name, max_ttl_seconds, metadata, created_at,
                epoch, active_lease, signing_jwk
         FROM lock_config
         WHERE singleton = 1`,
      )
      .toArray()[0];
  }

  private accessAllowed(
    config: LockConfigRow,
    grants: LockAccessGrant[] | undefined,
  ): boolean {
    if (grants === undefined) {
      return true;
    }
    const metadata = JSON.parse(config.metadata) as LockMetadata;
    return grants.some((grant) =>
      grantMatchesLock(grant, config.namespace, metadata),
    );
  }

  private readSigningKey(config: LockConfigRow): FencingPrivateJwk {
    const key = JSON.parse(config.signing_jwk) as FencingPrivateJwk;
    if (
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      key.alg !== "ES256" ||
      key.use !== "sig" ||
      typeof key.kid !== "string" ||
      typeof key.x !== "string" ||
      typeof key.y !== "string" ||
      typeof key.d !== "string"
    ) {
      throw new Error("lock signing key is invalid");
    }
    return key;
  }

  private async generateSigningKey(): Promise<FencingPrivateJwk> {
    const generated = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const exportedPrivate = (await crypto.subtle.exportKey(
      "jwk",
      generated.privateKey,
    )) as JsonWebKey;
    if (
      typeof exportedPrivate.x !== "string" ||
      typeof exportedPrivate.y !== "string" ||
      typeof exportedPrivate.d !== "string"
    ) {
      throw new Error("generated signing key is invalid");
    }

    const keyId = `key-${crypto.randomUUID().replaceAll("-", "")}`;
    return {
      ...exportedPrivate,
      kty: "EC",
      crv: "P-256",
      x: exportedPrivate.x,
      y: exportedPrivate.y,
      d: exportedPrivate.d,
      alg: "ES256",
      use: "sig",
      kid: keyId,
      key_ops: ["sign"],
    };
  }

  private async signFencingToken(
    config: LockConfigRow,
    lease: StoredLeaseRow,
    key: FencingPrivateJwk,
  ): Promise<string> {
    const header = {
      alg: "ES256",
      typ: "JWT",
      kid: key.kid,
    };
    const claims = {
      iss: "durable-locks",
      sub: config.id,
      jti: lease.lease_id,
      iat: Math.floor(lease.acquired_at_ms / 1000),
      exp: Math.floor(lease.expires_at_ms / 1000),
      epoch: config.epoch,
      namespace: config.namespace,
      lock_name: config.name,
      lease_name: lease.name,
    };
    const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  jwks(lockId: string): LockJwks | null {
    const config = this.config();
    if (config === undefined) {
      return null;
    }
    if (config.id !== lockId) {
      throw new Error(`lock is already identified as ${config.id}`);
    }
    return { keys: [publicJwk(this.readSigningKey(config))] };
  }

  private storedLease(config: LockConfigRow): StoredLeaseRow | undefined {
    return config.active_lease === null
      ? undefined
      : JSON.parse(config.active_lease) as StoredLeaseRow;
  }

  private pruneActiveLease(config: LockConfigRow, now: number): LockConfigRow {
    const lease = this.storedLease(config);
    if (lease === undefined || lease.expires_at_ms > now) {
      return config;
    }
    this.ctx.storage.sql.exec(
      "UPDATE lock_config SET active_lease = NULL WHERE singleton = 1",
    );
    return { ...config, active_lease: null };
  }

  private activeLease(
    config: LockConfigRow,
    now: number,
  ): StoredLeaseRow | undefined {
    const lease = this.storedLease(config);
    return lease !== undefined && lease.expires_at_ms > now
      ? lease
      : undefined;
  }

  private snapshot(config: LockConfigRow, now: number): LockSnapshot {
    const active = this.activeLease(config, now);
    return {
      namespace: config.namespace,
      name: config.name,
      max_ttl_seconds: config.max_ttl_seconds,
      metadata: JSON.parse(config.metadata) as LockMetadata,
      created_at: Math.floor(config.created_at / 1000),
      epoch: config.epoch,
      lease: active === undefined ? null : leaseSummary(active),
    };
  }

  async init(
    id: string,
    namespace: string,
    name: string,
    maxTtlSeconds: number,
    metadata: LockMetadata,
    createdAtMs: number,
  ): Promise<LockSnapshot> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<LockSnapshot> => {
      const serializedMetadata = serializeMetadata(metadata);
      let config = this.config();
      if (config === undefined) {
        const signingJwk = JSON.stringify(await this.generateSigningKey());
        this.ctx.storage.sql.exec(
          `INSERT INTO lock_config (
            singleton, id, namespace, name, max_ttl_seconds, metadata,
            created_at, epoch, active_lease, signing_jwk
          ) VALUES (1, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
          id,
          namespace,
          name,
          maxTtlSeconds,
          serializedMetadata,
          createdAtMs,
          signingJwk,
        );
        config = {
          id,
          namespace,
          name,
          max_ttl_seconds: maxTtlSeconds,
          metadata: serializedMetadata,
          created_at: createdAtMs,
          epoch: 0,
          active_lease: null,
          signing_jwk: signingJwk,
        };
      } else {
        if (config.id !== id) {
          throw new Error(`lock is already identified as ${config.id}`);
        }
        if (config.namespace !== namespace) {
          throw new Error(`lock already belongs to namespace ${config.namespace}`);
        }
        if (config.name !== name) {
          throw new Error(`lock is already named ${config.name}`);
        }
        if (config.max_ttl_seconds !== maxTtlSeconds) {
          throw new Error(
            `lock already has a maximum TTL of ${config.max_ttl_seconds} seconds`,
          );
        }
        if (
          serializeMetadata(JSON.parse(config.metadata) as LockMetadata) !==
            serializedMetadata
        ) {
          throw new Error("lock already has different metadata");
        }
        if (config.created_at !== createdAtMs) {
          throw new Error(`lock was already created at ${config.created_at}`);
        }
      }
      return this.snapshot(config, Date.now());
    });
  }

  read(grants?: LockAccessGrant[]): LockSnapshot | null {
    return this.ctx.storage.transactionSync(() => {
      const config = this.config();
      if (
        config === undefined ||
        !this.accessAllowed(config, grants)
      ) {
        return null;
      }
      const now = Date.now();
      return this.snapshot(this.pruneActiveLease(config, now), now);
    });
  }

  async acquire(
    lockId: string,
    name: string,
    ttlSeconds: number,
    grants?: LockAccessGrant[],
  ): Promise<LockAcquireResult> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<LockAcquireResult> => {
      const prepared = this.ctx.storage.transactionSync(
        (): LockAcquirePreparation => {
          let config = this.config();
          if (config === undefined) {
            return { outcome: "not_found" };
          }
          if (!this.accessAllowed(config, grants)) {
            return { outcome: "not_found" };
          }
          if (config.id !== lockId) {
            throw new Error(`lock is already identified as ${config.id}`);
          }
          if (ttlSeconds > config.max_ttl_seconds) {
            return {
              outcome: "invalid",
              reason: "ttl_exceeds_maximum",
              max_ttl_seconds: config.max_ttl_seconds,
            };
          }

          const now = Date.now();
          config = this.pruneActiveLease(config, now);
          const active = this.activeLease(config, now);
          if (active !== undefined) {
            if (active.name === name) {
              if (active.ttl_seconds !== ttlSeconds) {
                return { outcome: "conflict", reason: "name_mismatch" };
              }
              return {
                outcome: "existing",
                lease: active,
                epoch: config.epoch,
              };
            }
            return {
              outcome: "conflict",
              reason: "already_leased",
              expires_at: Math.floor(active.expires_at_ms / 1000),
            };
          }
          if (config.epoch >= Number.MAX_SAFE_INTEGER) {
            throw new Error("lock fencing epoch is exhausted");
          }

          const epoch = config.epoch + 1;
          const acquiredAtMs = now;
          const expiresAtMs = acquiredAtMs + ttlSeconds * 1000;
          const created: StoredLeaseRow = {
            name,
            lease_id: `lse-${crypto.randomUUID().replaceAll("-", "")}`,
            ttl_seconds: ttlSeconds,
            acquired_at_ms: acquiredAtMs,
            expires_at_ms: expiresAtMs,
            fencing_token: null,
          };

          const advanced = this.ctx.storage.sql.exec(
            `UPDATE lock_config
             SET epoch = ?, active_lease = ?
             WHERE singleton = 1 AND epoch = ? AND active_lease IS NULL`,
            epoch,
            JSON.stringify(created),
            config.epoch,
          );
          if (advanced.rowsWritten !== 1) {
            throw new Error("failed to advance the lock fencing epoch");
          }
          return { outcome: "created", lease: created, epoch };
        },
      );

      switch (prepared.outcome) {
        case "conflict":
        case "invalid":
        case "not_found":
          return prepared;
      }

      let lease = prepared.lease;
      if (lease.fencing_token === null) {
        const config = this.config();
        if (config === undefined) {
          throw new Error("lock has not been initialized");
        }
        if (config.epoch !== prepared.epoch) {
          throw new Error("lock fencing epoch changed during acquisition");
        }
        const key = this.readSigningKey(config);
        const token = await this.signFencingToken(config, lease, key);
        const signedLease = { ...lease, fencing_token: token };
        const persisted = this.ctx.storage.sql.exec(
          `UPDATE lock_config
           SET active_lease = ?
           WHERE singleton = 1 AND active_lease = ?`,
          JSON.stringify(signedLease),
          JSON.stringify(lease),
        );
        if (persisted.rowsWritten !== 1) {
          throw new Error("failed to persist the fencing token");
        }
        lease = signedLease;
      }

      return {
        outcome: prepared.outcome,
        lease: publicLease(lease as SignedStoredLeaseRow, prepared.epoch),
      };
    });
  }

  release(
    leaseId: string,
    grants?: LockAccessGrant[],
  ): LockReleaseResult {
    return this.ctx.storage.transactionSync(() => {
      let config = this.config();
      if (config === undefined) {
        return { outcome: "not_found" };
      }
      if (!this.accessAllowed(config, grants)) {
        return { outcome: "not_found" };
      }

      const now = Date.now();
      config = this.pruneActiveLease(config, now);
      const active = this.activeLease(config, now);
      if (active?.lease_id === leaseId) {
        this.ctx.storage.sql.exec(
          "UPDATE lock_config SET active_lease = NULL WHERE singleton = 1",
        );
        return { outcome: "released" };
      }

      if (active !== undefined) {
        return { outcome: "conflict", reason: "different_active_lease" };
      }
      return { outcome: "absent" };
    });
  }

  async deleteLock(
    lockId: string,
    grants?: LockAccessGrant[],
  ): Promise<LockDeleteResult> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<LockDeleteResult> => {
      const config = this.config();
      if (config === undefined) {
        return { outcome: "not_found" };
      }
      if (!this.accessAllowed(config, grants)) {
        return { outcome: "not_found" };
      }
      if (config.id !== lockId) {
        throw new Error(`lock is already identified as ${config.id}`);
      }

      await this.env.LOCK_NAMESPACE.getByName(config.namespace).remove(lockId);
      this.ctx.storage.sql.exec("DELETE FROM lock_config");
      return { outcome: "deleted" };
    });
  }
}

export class LockNamespace extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS locks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          max_ttl_seconds INTEGER NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('creating', 'active'))
        )
      `);
    });
  }

  private getByName(name: string): LockRegistryRow | undefined {
    return this.ctx.storage.sql
      .exec<LockRegistryRow>(
        `SELECT id, name, max_ttl_seconds, metadata, created_at, state
         FROM locks
         WHERE name = ?`,
        name,
      )
      .toArray()[0];
  }

  private configurationConflict(
    row: LockRegistryRow,
    maxTtlSeconds: number,
    metadata: string,
  ): "max_ttl_mismatch" | "metadata_mismatch" | null {
    if (row.max_ttl_seconds !== maxTtlSeconds) {
      return "max_ttl_mismatch";
    }
    if (row.metadata !== metadata) {
      return "metadata_mismatch";
    }
    return null;
  }

  private async materialize(
    row: LockRegistryRow,
    namespace: string,
    outcome: "created" | "existing",
  ): Promise<LockCreationResult> {
    const snapshot = await this.env.LOCK.getByName(row.id).init(
      row.id,
      namespace,
      row.name,
      row.max_ttl_seconds,
      JSON.parse(row.metadata) as LockMetadata,
      row.created_at,
    );
    if (row.state === "creating") {
      this.ctx.storage.sql.exec(
        "UPDATE locks SET state = 'active' WHERE id = ? AND state = 'creating'",
        row.id,
      );
    }
    return { outcome, id: row.id, snapshot };
  }

  async create(
    name: string,
    namespace: string,
    maxTtlSeconds: number,
    metadata: LockMetadata = {},
  ): Promise<LockCreationResult> {
    const serializedMetadata = serializeMetadata(metadata);
    const existing = this.getByName(name);
    if (existing !== undefined) {
      const conflict = this.configurationConflict(
        existing,
        maxTtlSeconds,
        serializedMetadata,
      );
      if (conflict !== null) {
        return { outcome: "conflict", reason: conflict };
      }
      return this.materialize(existing, namespace, "existing");
    }

    const row: LockRegistryRow = {
      id: `lck-${crypto.randomUUID().replaceAll("-", "")}`,
      name,
      max_ttl_seconds: maxTtlSeconds,
      metadata: serializedMetadata,
      created_at: Date.now(),
      state: "creating",
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO locks (
        id, name, max_ttl_seconds, metadata, created_at, state
      ) VALUES (?, ?, ?, ?, ?, 'creating')`,
      row.id,
      row.name,
      row.max_ttl_seconds,
      row.metadata,
      row.created_at,
    );
    return this.materialize(row, namespace, "created");
  }

  list(
    filters: LockMetadata = {},
    limit = 20,
    cursor: LockCursor | null = null,
    metadataGrants?: LockMetadata[],
  ): LockPage {
    const entries = Object.entries(filters);
    const conditions = [
      "state = 'active'",
      ...entries.map(
        () => `EXISTS (
          SELECT 1
          FROM json_each(locks.metadata) AS item
          WHERE item.key = ? AND item.type = 'text' AND item.value = ?
        )`,
      ),
    ];
    const bindings: Array<string | number> = entries.flatMap(([key, value]) => [
      key,
      value,
    ]);
    if (metadataGrants !== undefined) {
      const grantConditions = metadataGrants.map((grant) => {
        const grantEntries = Object.entries(grant);
        bindings.push(
          ...grantEntries.flatMap(([key, value]) => [key, value]),
        );
        if (grantEntries.length === 0) {
          return "1 = 1";
        }
        return `(${grantEntries
          .map(
            () => `EXISTS (
              SELECT 1
              FROM json_each(locks.metadata) AS granted_item
              WHERE granted_item.key = ? AND granted_item.type = 'text'
                AND granted_item.value = ?
            )`,
          )
          .join(" AND ")})`;
      });
      conditions.push(
        grantConditions.length === 0
          ? "0 = 1"
          : `(${grantConditions.join(" OR ")})`,
      );
    }
    if (cursor !== null) {
      conditions.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      bindings.push(cursor.created_at_ms, cursor.created_at_ms, cursor.rowid);
    }
    bindings.push(limit + 1);
    const rows = this.ctx.storage.sql
      .exec<{
        cursor_rowid: number;
        id: string;
        name: string;
        max_ttl_seconds: number;
        metadata: string;
        created_at: number;
      }>(
        `SELECT rowid AS cursor_rowid, id, name, max_ttl_seconds,
                metadata, created_at
         FROM locks
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        ...bindings,
      )
      .toArray();
    const has_more = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const finalRow = pageRows.at(-1);
    return {
      data: pageRows.map(
        ({ id, name, max_ttl_seconds, metadata, created_at }) => ({
          id,
          name,
          max_ttl_seconds,
          metadata: JSON.parse(metadata) as LockMetadata,
          created_at: Math.floor(created_at / 1000),
        }),
      ),
      has_more,
      next_position:
        has_more && finalRow !== undefined
          ? {
              created_at_ms: finalRow.created_at,
              rowid: finalRow.cursor_rowid,
            }
          : null,
    };
  }

  remove(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM locks WHERE id = ?", id);
  }
}
