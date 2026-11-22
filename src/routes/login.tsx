import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * There is no web sign-in screen. Access is enforced by the sync server's
 * bearer tokens (see selfhost/README.md), and tasks live in this browser until
 * a server is connected from Settings. `/login` stays only so an old bookmark or
 * a cached shell lands on the app instead of a dead page.
 */
export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
