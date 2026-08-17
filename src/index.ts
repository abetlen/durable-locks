import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerApi, type AppEnvironment } from "./api";
import { apiError } from "./utils";

export { Lock, LockNamespace } from "./lock";

const app = new OpenAPIHono<AppEnvironment>({
  defaultHook: (result, context) => {
    if (!result.success) {
      return context.json(
        apiError(
          "invalid_request",
          result.error.issues[0]?.message ?? "invalid request",
        ),
        400,
      );
    }
  },
});

registerApi(app);
app.openAPIRegistry.registerComponent("securitySchemes", "oidcBearer", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "OIDC access token when deployment authentication is enabled.",
});

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "Distributed Locking API",
    version: "1.0.0",
  },
  tags: [
    {
      name: "Lock",
    },
  ],
});

app.get("/docs", swaggerUI({ url: "/openapi.json" }));
app.get("/health", (context) => context.text("ok\n"));
app.notFound((context) =>
  context.json(apiError("route_not_found", "route not found"), 404));

app.onError((error, context) => {
  console.error(error);
  return context.json(apiError("internal_error", "internal server error"), 500);
});

export default app;
