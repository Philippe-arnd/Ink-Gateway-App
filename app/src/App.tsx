import { useEffect } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { Login, ResetPassword } from "./pages/Login";
import { Books } from "./pages/Books";
import { Editor } from "./pages/Editor";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";
import { NotFound } from "./pages/NotFound";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RequireAuth } from "./components/RequireAuth";
import { setUnauthorizedHandler } from "./api";

export default function App() {
  const navigate = useNavigate();

  // Sessions live in an in-memory store server-side, so every deploy signs
  // everyone out mid-task. Handle that once, here, instead of per page.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const next = `${window.location.pathname}${window.location.search}`;
      if (window.location.pathname.startsWith("/login")) return;
      navigate(`/login?next=${encodeURIComponent(next)}&expired=1`, { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="/books"
          element={
            <RequireAuth>
              <Books />
            </RequireAuth>
          }
        />
        <Route
          path="/books/:id"
          element={
            <RequireAuth>
              <Editor />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <Settings />
            </RequireAuth>
          }
        />
        <Route
          path="/onboarding"
          element={
            <RequireAuth>
              <Onboarding />
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBoundary>
  );
}
