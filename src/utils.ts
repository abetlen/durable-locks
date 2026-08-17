import { z } from "@hono/zod-openapi";

export const ApiErrorDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const ApiErrorSchema = z
  .object({
    error: ApiErrorDetailSchema,
  })
  .openapi("ApiError");

export const apiError = (code: string, message: string) => ({
  error: { code, message },
});

export const MetadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(256))
  .openapi("Metadata", {
    example: {},
  });

export const LockNamespaceNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export type CursorPosition = {
  namespace: string;
  created_at_ms: number;
  rowid: number;
};

const CursorPayloadSchema = z
  .object({
    namespace: z.string().min(1).max(64),
    created_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const encodeCursor = (cursor: CursorPosition): string =>
  btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const decodeCursor = (
  value: string | undefined,
): { cursor: CursorPosition | null; error?: string } => {
  if (value === undefined) {
    return { cursor: null };
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = CursorPayloadSchema.safeParse(
      JSON.parse(atob(normalized + padding)),
    );
    if (!parsed.success) {
      return { cursor: null, error: "invalid cursor" };
    }
    return {
      cursor: {
        namespace: parsed.data.namespace,
        created_at_ms: parsed.data.created_at_ms,
        rowid: parsed.data.rowid,
      },
    };
  } catch {
    return { cursor: null, error: "invalid cursor" };
  }
};

export const metadataFiltersFromQuery = (
  query: Record<string, string[]>,
): { filters?: Record<string, string>; error?: string } => {
  const metadata: Record<string, string> = {};
  for (const [key, values] of Object.entries(query)) {
    if (!key.startsWith("metadata[") || !key.endsWith("]")) {
      continue;
    }
    const metadataKey = key.slice("metadata[".length, -1);
    if (values.length !== 1) {
      return { error: `metadata filter ${metadataKey} must occur once` };
    }
    metadata[metadataKey] = values[0];
  }
  const parsed = MetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "invalid metadata" };
  }
  return { filters: parsed.data };
};
