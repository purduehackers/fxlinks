import { handle } from "./app.ts";

Bun.serve({ port: process.env.PORT || 3000, fetch: request => handle(request) });
