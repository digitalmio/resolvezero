/**
 * Production server for the console (TanStack Start fetch handler).
 *
 * Development uses `vite dev`; the build emits `dist/server/server.js` with a
 * web-standard `fetch` export, which srvx adapts to Node HTTP.
 */
import { serve } from "srvx/node";

import handler from "./dist/server/server.js";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";

serve({
  fetch: handler.fetch,
  port,
  hostname,
  // Fly terminates TLS and forwards the client address; the auth layer needs
  // the real IP for rate limiting and cookies need the https origin.
  trustProxy: true,
  gracefulShutdown: { gracefulTimeout: 20_000 },
});

console.log(JSON.stringify({ level: "info", msg: "console listening", port, hostname }));
