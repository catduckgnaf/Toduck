import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ToduckScreen, ToduckShell } from "@/components/toduck/screen";
import { bootToduck, useToduck } from "@/lib/toduck/store";
import { authEnabled } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const hydrated = useToduck((s) => s.hasHydrated);
  const [mounted, setMounted] = useState(false);
  const { user, isPending } = useCurrentUserState();

  useEffect(() => {
    setMounted(true);
    void bootToduck();
  }, []);

  // Tell the boot watchdog in __root.tsx that the app finished starting,
  // so it does not offer its recovery panel over a healthy slow load.
  const booted = mounted && hydrated && !(authEnabled && isPending);
  useEffect(() => {
    if (booted) {
      (window as unknown as { __toduckBooted?: boolean }).__toduckBooted = true;
    }
  }, [booted]);

  if (!mounted || !hydrated || (authEnabled && isPending)) return <ToduckShell />;
  if (authEnabled && !user) return <Navigate to="/login" />;
  return <ToduckScreen />;
}
