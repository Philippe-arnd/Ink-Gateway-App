import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api, ApiError } from "../api";

type AuthState = "checking" | "authenticated" | "anonymous";

/**
 * Single gate for every private route. Previously each page invented its own
 * check and only `Books` tried, with inverted logic — so an unauthenticated
 * visit to the Editor or Settings rendered the page and then threw unhandled
 * promise rejections.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(() => {
        if (!cancelled) setState("authenticated");
      })
      .catch((err) => {
        if (cancelled) return;
        // Only a real 401 means "log in". A network failure or a 500 must not
        // bounce the user out — that was the old inverted behaviour.
        setState(err instanceof ApiError && err.status === 401 ? "anonymous" : "authenticated");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") return <div className="loading">Chargement…</div>;
  if (state === "anonymous") {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
