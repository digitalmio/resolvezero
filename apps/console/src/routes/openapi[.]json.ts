import { createFileRoute } from "@tanstack/react-router";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import { router } from "../server/orpc/router.server";

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const spec = await generator.generate(router, {
          info: { title: "ResolveZero API", version: "0.1.0" },
          // Procedures are served under /rpc, so the base URL carries the prefix.
          servers: [{ url: `${origin}/rpc` }],
        });
        return Response.json(spec);
      },
    },
  },
});
