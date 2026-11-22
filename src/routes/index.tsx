import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ToduckScreen, ToduckShell } from "@/components/toduck/screen";
import { bootToduck, useToduck } from "@/lib/toduck/store";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const hydrated = useToduck((s) => s.hasHydrated);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    void bootToduck();
  }, []);

  // Tell the boot watchdog in __root.tsx that the app finished starting,
  // so it does not offer its recovery panel over a healthy slow load.
  const booted = mounted && hydrated;
  useEffect(() => {
    if (booted) {
      (window as unknown as { __toduckBooted?: boolean }).__toduckBooted = true;
    }
  }, [booted]);

  // No client-side sign-in gate: it could not protect anything. Synced data is
  // protected by the server's bearer tokens, and local data never leaves the
  // browser.
  if (!mounted || !hydrated) return <ToduckShell />;
  return <ToduckScreen />;
}
