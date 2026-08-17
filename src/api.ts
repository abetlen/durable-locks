import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  authenticate,
  directLockGrants,
  hasLockAccess,
  hasNamespaceAccess,
  hasScope,
  namespaceMetadataGrants,
  type Authorization,
} from "./auth";
import type { Bindings } from "./bindings";
import {
  DEFAULT_LOCK_NAMESPACE,
  MAX_LOCK_TTL_SECONDS,
} from "./lock";
import {
  ApiErrorDetailSchema,
  ApiErrorSchema,
  apiError,
  decodeCursor,
  encodeCursor,
  LockNamespaceNameSchema,
  MetadataSchema,
  metadataFiltersFromQuery,
} from "./utils";

export type AppEnvironment = {
  Bindings: Bindings;
  Variables: {
    authorization: Authorization | null;
  };
};

const LockUnavailableErrorSchema = z
  .object({
    error: ApiErrorDetailSchema.extend({
      expires_at: z.number().int(),
    }),
  })
  .openapi("LockUnavailableError");

const LockIdSchema = z.object({
  id: z.string().regex(/^lck-[0-9a-f]{32}$/).openapi({
    param: {
      name: "id",
      in: "path",
    },
  }),
});

const LockNameSchema = z.string().min(1).max(128);
const CreateLockSchema = z.object({
  namespace: LockNamespaceNameSchema.optional(),
  name: LockNameSchema.openapi({ example: "res-12345" }),
  max_ttl_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOCK_TTL_SECONDS)
    .openapi({ example: 300 }),
  metadata: MetadataSchema.optional(),
});

const LockLeaseSummarySchema = z
  .object({
    id: z.string(),
    name: LockNameSchema.openapi({ example: "worker-7-job-123-attempt-1" }),
    ttl_seconds: z.number().int().positive().openapi({ example: 30 }),
    acquired_at: z.number().int().openapi({ example: 1786928000 }),
    expires_at: z.number().int().openapi({ example: 1786928030 }),
  })
  .openapi("LockLeaseSummary");

const LockSchema = z
  .object({
    id: z.string(),
    object: z.literal("lock"),
    name: z.string().openapi({ example: "res-12345" }),
    namespace: LockNamespaceNameSchema,
    max_ttl_seconds: z.number().int().openapi({ example: 300 }),
    metadata: MetadataSchema,
    created_at: z.number().int().openapi({ example: 1786928000 }),
    epoch: z.number().int().nonnegative().openapi({ example: 13 }),
    lease: LockLeaseSummarySchema.nullable(),
  })
  .openapi("Lock");

const LockLeaseSchema = z
  .object({
    id: z.string(),
    object: z.literal("lock_lease"),
    lock_id: z.string(),
    name: LockNameSchema.openapi({ example: "worker-7-job-123-attempt-1" }),
    epoch: z.number().int().positive().openapi({ example: 13 }),
    ttl_seconds: z.number().int().positive().openapi({ example: 30 }),
    acquired_at: z.number().int().openapi({ example: 1786928000 }),
    expires_at: z.number().int().openapi({ example: 1786928030 }),
    fencing_token: z.string(),
  })
  .openapi("LockLease");

const FencingPublicJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    alg: z.literal("ES256"),
    use: z.literal("sig"),
    kid: z.string(),
    x: z.string(),
    y: z.string(),
  })
  .openapi("FencingPublicJwk");

const LockJwksSchema = z
  .object({
    keys: z.array(FencingPublicJwkSchema).length(1),
  })
  .openapi("LockJwks");

const LockListItemSchema = z
  .object({
    id: z.string(),
    name: z.string().openapi({ example: "res-12345" }),
    max_ttl_seconds: z.number().int().openapi({ example: 300 }),
    metadata: MetadataSchema,
    created_at: z.number().int().openapi({ example: 1786928000 }),
  })
  .openapi("LockListItem");

const LockListSchema = z
  .object({
    object: z.literal("list"),
    namespace: LockNamespaceNameSchema,
    data: z.array(LockListItemSchema),
    has_more: z.boolean().openapi({ example: true }),
    next_cursor: z.string().nullable(),
  })
  .openapi("LockList");

const LockListQuerySchema = z.object({
  namespace: LockNamespaceNameSchema.optional().openapi({
    param: {
      name: "namespace",
      in: "query",
    },
  }),
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({
    param: {
      name: "limit",
      in: "query",
    },
    example: 20,
  }),
  cursor: z.string().max(512).optional().openapi({
    param: {
      name: "cursor",
      in: "query",
    },
  }),
  metadata: MetadataSchema.optional().openapi({
    param: {
      name: "metadata",
      in: "query",
      style: "deepObject",
      explode: true,
    },
  }),
});

const AcquireLockSchema = z.object({
  name: LockNameSchema.openapi({ example: "worker-7-job-123-attempt-1" }),
  ttl_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOCK_TTL_SECONDS)
    .openapi({ example: 30 }),
});

const ReleaseLockSchema = z.object({
  lease_id: z.string().regex(/^lse-[0-9a-f]{32}$/),
});

const ProtectedResponses = {
  401: {
    description: "The bearer access token is missing or invalid.",
    content: {
      "application/json": {
        schema: ApiErrorSchema,
      },
    },
  },
  503: {
    description: "OIDC is partially or incorrectly configured.",
    content: {
      "application/json": {
        schema: ApiErrorSchema,
      },
    },
  },
} as const;

const listLocksRoute = createRoute({
  method: "get",
  path: "/api/v1/locks",
  operationId: "listLocks",
  tags: ["Lock"],
  security: [{ oidcBearer: [] }],
  request: {
    query: LockListQuerySchema,
  },
  responses: {
    ...ProtectedResponses,
    200: {
      description: "A newest-first page of locks in the selected namespace.",
      content: {
        "application/json": {
          schema: LockListSchema,
        },
      },
    },
    400: {
      description: "The pagination cursor or metadata filters are invalid.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    403: {
      description: "The token lacks the required scope or resource grant.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
  },
});

const createLockRoute = createRoute({
  method: "post",
  path: "/api/v1/locks",
  operationId: "createLock",
  tags: ["Lock"],
  security: [{ oidcBearer: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: CreateLockSchema,
          example: {
            name: "res-12345",
            max_ttl_seconds: 300,
            metadata: {},
          },
        },
      },
    },
  },
  responses: {
    ...ProtectedResponses,
    200: {
      description: "An idempotent replay returned the existing lock.",
      content: {
        "application/json": {
          schema: LockSchema,
        },
      },
    },
    201: {
      description: "The lock was created with epoch zero.",
      content: {
        "application/json": {
          schema: LockSchema,
        },
      },
    },
    400: {
      description: "The request body is invalid.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    403: {
      description: "The token lacks the required scope or resource grant.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    409: {
      description: "The lock name has different immutable configuration.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
  },
});

const readLockRoute = createRoute({
  method: "get",
  path: "/api/v1/locks/{id}",
  operationId: "readLock",
  tags: ["Lock"],
  security: [{ oidcBearer: [] }],
  request: {
    params: LockIdSchema,
  },
  responses: {
    ...ProtectedResponses,
    200: {
      description: "The lock and its current active lease.",
      content: {
        "application/json": {
          schema: LockSchema,
        },
      },
    },
    400: {
      description: "The lock ID is invalid.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    403: {
      description: "The token lacks the required scope or resource grant.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    404: {
      description: "The lock has not been created.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
  },
});

const deleteLockRoute = createRoute({
  method: "delete",
  path: "/api/v1/locks/{id}",
  operationId: "deleteLock",
  tags: ["Lock"],
  security: [{ oidcBearer: [] }],
  request: {
    params: LockIdSchema,
  },
  responses: {
    ...ProtectedResponses,
    204: {
      description: "The lock was deleted.",
    },
    400: {
      description: "The lock ID is invalid.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    403: {
      description: "The token lacks the required scope or resource grant.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    404: {
      description: "The lock has not been created.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
  },
});

const acquireLockRoute = createRoute({
  method: "post",
  path: "/api/v1/locks/{id}/acquire",
  operationId: "acquireLock",
  tags: ["Lock"],
  security: [{ oidcBearer: [] }],
  request: {
    params: LockIdSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: AcquireLockSchema,
        },
      },
    },
  },
  responses: {
    ...ProtectedResponses,
    200: {
      description: "An idempotent replay returned the original lease.",
      content: {
        "application/json": {
          schema: LockLeaseSchema,
        },
      },
    },
    201: {
      description: "A lease was acquired with a new fencing epoch.",
      content: {
        "application/json": {
          schema: LockLeaseSchema,
        },
      },
    },
    400: {
      description: "The TTL is invalid or exceeds this lock's maximum.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    403: {
      description: "The token lacks the required scope or resource grant.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    404: {
      description: "The lock has not been created.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    409: {
      description: "The lock is leased or the lease name has a different TTL.",
      content: {
        "application/json": {
          schema: z.union([ApiErrorSchema, LockUnavailableErrorSchema]),
        },
      },
    },
  },
});

const getLockJwksRoute = createRoute({
  method: "get",
  path: "/api/v1/locks/{id}/jwks",
  operationId: "getLockJwks",
  tags: ["Lock"],
  request: {
    params: LockIdSchema,
  },
  responses: {
    200: {
      description: "The immutable public key used for fencing tokens.",
      content: {
        "application/json": {
          schema: LockJwksSchema,
        },
      },
    },
    400: {
      description: "The lock ID is invalid.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    404: {
      description: "The lock has not been created.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
  },
});

const releaseLockRoute = createRoute({
  method: "post",
  path: "/api/v1/locks/{id}/release",
  operationId: "releaseLock",
  tags: ["Lock"],
  security: [{ oidcBearer: [] }],
  request: {
    params: LockIdSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ReleaseLockSchema,
        },
      },
    },
  },
  responses: {
    ...ProtectedResponses,
    204: {
      description: "The matching lease is no longer active.",
    },
    400: {
      description: "The lease ID is invalid.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    403: {
      description: "The token lacks the required scope or resource grant.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    404: {
      description: "The lock has not been created.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
    409: {
      description: "A different lease is currently active.",
      content: {
        "application/json": {
          schema: ApiErrorSchema,
        },
      },
    },
  },
});

const resolveNamespace = (
  requestedNamespace: string | undefined,
  env: Bindings,
): string => {
  const namespace =
    requestedNamespace ??
    env.DEFAULT_LOCK_NAMESPACE ??
    DEFAULT_LOCK_NAMESPACE;
  const parsed = LockNamespaceNameSchema.safeParse(namespace);
  if (!parsed.success) {
    throw new Error("DEFAULT_LOCK_NAMESPACE is invalid");
  }
  return parsed.data;
};

const getNamespace = (env: Bindings, namespace: string) =>
  env.LOCK_NAMESPACE.getByName(namespace);

export const registerApi = (
  app: OpenAPIHono<AppEnvironment>,
): void => {
  app.openapi(getLockJwksRoute, async (context) => {
    const { id } = context.req.valid("param");
    const jwks = await context.env.LOCK.getByName(id).jwks(id);
    if (jwks === null) {
      return context.json(apiError("lock_not_found", "lock not found"), 404);
    }
    context.header("Cache-Control", "public, max-age=31536000, immutable");
    return context.json(jwks, 200);
  });

  app.use("/api/v1/*", async (context, next) => {
    const authorizationHeader = context.req.header("Authorization");
    const match = authorizationHeader?.match(/^Bearer\s+([^\s]+)$/i);
    const result = await authenticate(context.env, match?.[1]);
    if (result.outcome === "configuration_error") {
      console.error("OIDC authentication is misconfigured", result.error);
      return context.json(
        apiError("auth_configuration_error", "authentication is unavailable"),
        503,
      );
    }
    if (result.outcome === "provider_unavailable") {
      console.error("OIDC authentication is unavailable", result.error);
      return context.json(
        apiError("auth_provider_unavailable", "authentication is unavailable"),
        503,
      );
    }
    if (result.outcome === "unauthorized") {
      if (result.error !== undefined) {
        console.error("OIDC token validation failed", result.error);
      }
      context.header("WWW-Authenticate", "Bearer");
      return context.json(
        apiError("unauthorized", "a valid bearer access token is required"),
        401,
      );
    }
    context.set(
      "authorization",
      result.outcome === "disabled" ? null : result.authorization,
    );
    await next();
  });

  app.openapi(listLocksRoute, async (context) => {
    const authorization = context.get("authorization");
    if (!hasScope(authorization, "locks:read")) {
      return context.json(
        apiError("forbidden", "the locks:read scope is required"),
        403,
      );
    }
    const {
      namespace: requestedNamespace,
      limit,
      cursor: encodedCursor,
    } = context.req.valid("query");
    const namespace = resolveNamespace(requestedNamespace, context.env);
    if (!hasNamespaceAccess(authorization, namespace)) {
      return context.json(
        apiError("forbidden", "access to this namespace is not granted"),
        403,
      );
    }
    const parsedFilters = metadataFiltersFromQuery(context.req.queries());
    if (parsedFilters.error !== undefined) {
      return context.json(apiError("invalid_request", parsedFilters.error), 400);
    }
    const parsedCursor = decodeCursor(encodedCursor);
    if (parsedCursor.error !== undefined) {
      return context.json(apiError("invalid_request", parsedCursor.error), 400);
    }
    if (
      parsedCursor.cursor !== null &&
      parsedCursor.cursor.namespace !== namespace
    ) {
      return context.json(
        apiError("invalid_request", "cursor belongs to another namespace"),
        400,
      );
    }
    const page = await getNamespace(context.env, namespace).list(
      parsedFilters.filters ?? {},
      limit,
      parsedCursor.cursor,
      namespaceMetadataGrants(authorization, namespace),
    );
    return context.json(
      {
        object: "list" as const,
        namespace,
        data: page.data,
        has_more: page.has_more,
        next_cursor:
          page.next_position === null
            ? null
            : encodeCursor({ namespace, ...page.next_position }),
      },
      200,
    );
  });

  app.openapi(createLockRoute, async (context) => {
    const authorization = context.get("authorization");
    if (!hasScope(authorization, "locks:write")) {
      return context.json(
        apiError("forbidden", "the locks:write scope is required"),
        403,
      );
    }
    const {
      namespace: requestedNamespace,
      name,
      max_ttl_seconds,
      metadata,
    } = context.req.valid("json");
    const namespace = resolveNamespace(requestedNamespace, context.env);
    if (!hasLockAccess(authorization, namespace, metadata ?? {})) {
      return context.json(
        apiError(
          "forbidden",
          "access to this namespace and metadata is not granted",
        ),
        403,
      );
    }
    const result = await getNamespace(context.env, namespace).create(
      name,
      namespace,
      max_ttl_seconds,
      metadata,
    );
    if (result.outcome === "conflict") {
      const [code, message] =
        result.reason === "metadata_mismatch"
          ? [
              "lock_name_conflict",
              "lock name already exists with different metadata",
            ]
          : [
              "lock_name_conflict",
              "lock name already exists with a different maximum TTL",
            ];
      return context.json(apiError(code, message), 409);
    }
    const response = {
      id: result.id,
      object: "lock" as const,
      ...result.snapshot,
    };
    return result.outcome === "created"
      ? context.json(response, 201)
      : context.json(response, 200);
  });

  app.openapi(readLockRoute, async (context) => {
    const authorization = context.get("authorization");
    if (!hasScope(authorization, "locks:read")) {
      return context.json(
        apiError("forbidden", "the locks:read scope is required"),
        403,
      );
    }
    const { id } = context.req.valid("param");
    const snapshot = await context.env.LOCK.getByName(id).read(
      directLockGrants(authorization),
    );
    if (snapshot === null) {
      return context.json(apiError("lock_not_found", "lock not found"), 404);
    }
    return context.json({ id, object: "lock" as const, ...snapshot }, 200);
  });

  app.openapi(deleteLockRoute, async (context) => {
    const authorization = context.get("authorization");
    if (!hasScope(authorization, "locks:admin")) {
      return context.json(
        apiError("forbidden", "the locks:admin scope is required"),
        403,
      );
    }
    const { id } = context.req.valid("param");
    const result = await context.env.LOCK.getByName(id).deleteLock(
      id,
      directLockGrants(authorization),
    );
    if (result.outcome === "not_found") {
      return context.json(apiError("lock_not_found", "lock not found"), 404);
    }
    return context.body(null, 204);
  });

  app.openapi(acquireLockRoute, async (context) => {
    const authorization = context.get("authorization");
    if (!hasScope(authorization, "locks:write")) {
      return context.json(
        apiError("forbidden", "the locks:write scope is required"),
        403,
      );
    }
    const { id } = context.req.valid("param");
    const { name, ttl_seconds } = context.req.valid("json");
    const result = await context.env.LOCK.getByName(id).acquire(
      id,
      name,
      ttl_seconds,
      directLockGrants(authorization),
    );
    if (result.outcome === "not_found") {
      return context.json(apiError("lock_not_found", "lock not found"), 404);
    }
    if (result.outcome === "invalid") {
      return context.json(
        apiError(
          "invalid_ttl",
          `ttl_seconds exceeds this lock's maximum of ${result.max_ttl_seconds}`,
        ),
        400,
      );
    }
    if (result.outcome === "conflict") {
      if (result.reason === "name_mismatch") {
        return context.json(
          apiError(
            "lease_name_conflict",
            "lease name already exists with a different TTL",
          ),
          409,
        );
      }
      return context.json(
        {
          error: {
            code: "lock_already_leased",
            message: "lock already has an active lease",
            expires_at: result.expires_at,
          },
        },
        409,
      );
    }
    const { lease_id: leaseId, ...lease } = result.lease;
    const response = {
      id: leaseId,
      object: "lock_lease" as const,
      lock_id: id,
      ...lease,
    };
    return result.outcome === "created"
      ? context.json(response, 201)
      : context.json(response, 200);
  });

  app.openapi(releaseLockRoute, async (context) => {
    const authorization = context.get("authorization");
    if (!hasScope(authorization, "locks:write")) {
      return context.json(
        apiError("forbidden", "the locks:write scope is required"),
        403,
      );
    }
    const { id } = context.req.valid("param");
    const { lease_id } = context.req.valid("json");
    const result = await context.env.LOCK.getByName(id).release(
      lease_id,
      directLockGrants(authorization),
    );
    if (result.outcome === "not_found") {
      return context.json(apiError("lock_not_found", "lock not found"), 404);
    }
    if (result.outcome === "conflict") {
      return context.json(
        apiError(
          "lease_mismatch",
          "a different lease is currently active",
        ),
        409,
      );
    }
    return context.body(null, 204);
  });
};
