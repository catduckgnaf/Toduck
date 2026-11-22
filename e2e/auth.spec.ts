import { expect, test } from "playwright/test";

/**
 * The `/api/auth/*` mount (#102): before this fix every sign-up / sign-in /
 * session call 404'd because nothing mounted the Better Auth handler.
 *
 * API-level, via the `request` fixture — the email/password endpoints work
 * regardless of `VITE_AUTH_ENABLED` (the flag gates the client sign-in UI,
 * not the API), so this runs in the normal e2e suite with auth off. The
 * auth-ON UI gate (visit / unsigned-in -> /login) is verified separately
 * against a dev server started with `VITE_AUTH_ENABLED=true`.
 */
test("auth mount: sign-up creates a user, get-session reads it, sign-out ends it", async ({
  request,
  baseURL,
}) => {
  const email = `auth-mount-${Date.now()}@example.com`;
  const password = "correct-horse-battery-staple";
  // A real browser always sends Origin on POSTs; Playwright's API client
  // does not, and Better Auth rejects credentialed calls without one.
  const origin = new URL(baseURL ?? "http://127.0.0.1:8080").origin;

  // Sign-up needs the `user` table from migrations/auth/0001_auth.sql — a
  // missing migration fails here, not just at the UI.
  const signUp = await request.post("/api/auth/sign-up/email", {
    headers: { Origin: origin },
    data: { email, password, name: "Auth Mount" },
  });
  expect(signUp.status(), `sign-up body: ${await signUp.text()}`).toBe(200);
  const created = await signUp.json();
  expect(created.user.email).toBe(email);
  // headersArray keeps each Set-Cookie separate (a comma-split would break on
  // the Expires date inside a cookie).
  const setCookies = signUp
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value);
  expect(setCookies.join(" ")).toContain("session_token");
  const sessionCookie = setCookies
    .find((cookie) => cookie.includes("session_token="))
    ?.split(";")[0];
  expect(sessionCookie).toBeTruthy();

  const session = await request.get("/api/auth/get-session", {
    headers: { cookie: sessionCookie!, Origin: origin },
  });
  expect(session.status()).toBe(200);
  expect((await session.json()).user?.email).toBe(email);

  // Wrong password fails (and the failure stays generic — see login.tsx).
  const badSignIn = await request.post("/api/auth/sign-in/email", {
    headers: { Origin: origin },
    data: { email, password: "wrong-password" },
  });
  expect(badSignIn.status()).not.toBe(200);

  // No cookie cache: the session is gone immediately after sign-out.
  // (The empty JSON body keeps Better Auth's POST body parser happy.)
  const signOut = await request.post("/api/auth/sign-out", {
    headers: { cookie: sessionCookie!, Origin: origin },
    data: {},
  });
  expect(signOut.status()).toBe(200);
  const afterSignOut = await request.get("/api/auth/get-session", {
    headers: { cookie: sessionCookie!, Origin: origin },
  });
  expect(afterSignOut.status()).toBe(200);
  expect(await afterSignOut.json()).toBeNull();
});
