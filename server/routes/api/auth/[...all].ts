/**
 * Deployed-app (Nitro) mount for Better Auth at `/api/auth/*`.
 *
 * The app runs its own Better Auth (see `src/lib/auth/server.ts`), so the
 * session cookie stays on this app's own origin — but nothing mounted the
 * handler, so every sign-up / sign-in / session call 404'd (#102). This
 * catch-all route forwards every `/api/auth/*` request to `auth.handler`
 * and streams the response back, preserving `Set-Cookie` headers.
 *
 * Dev (`npm run dev`) uses the matching Vite middleware in `vite.config.ts`
 * (`authApiPlugin`) — same handler, same forwarding — because Nitro routes
 * only exist in the built server.
 */
import { fromWebHandler } from "h3";
import { auth } from "../../../../src/lib/auth/server";

export default fromWebHandler((request) => auth.handler(request));
