import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./middleware";

/**
 * Server-side sign-in gate for the app's data route (#102/#107).
 *
 * The `/` route's client-side `<Navigate to="/login" />` is only a UX layer —
 * a client gate can be bypassed, so the loader also calls this server function,
 * which runs `authMiddleware` (`requireUserId`, fail-closed) on the server.
 * Signed out with auth on -> throws `UnauthorizedError`; the loader turns that
 * into a redirect to `/login`. With auth off the middleware resolves the dev
 * user (or throws fail-closed when `DATABASE_URL` is set), exactly like every
 * other server function that touches per-user data.
 *
 * Task data itself still lives in browser storage + the self-host sync server
 * (a separate process with its own tokens — see `src/lib/toduck/sync.ts`), so
 * this gate protects the app surface, not the sync API; true single-sign-on
 * between the web session and the sync server needs a shared secret/DB and is
 * a follow-up, not claimed here.
 */
export const requireSignedIn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return { userId: context.userId };
  });
