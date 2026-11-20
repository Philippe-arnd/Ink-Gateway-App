import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ApiKeyStatus } from "../api";
import { IconSettings } from "../icons";
import { readThemePreference, setThemePreference, type ThemePreference } from "../lib/theme";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Clair" },
  { value: "dark", label: "Sombre" },
  { value: "system", label: "Système" },
];

// Small settings/account menu with a badge on the trigger icon when the AI
// credential is missing or errored on its last real use — mounted wherever
// the user might be mid-work (Books list, Editor) so they don't have to go
// looking in Settings to notice.
export function AccountMenu() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.getApiKey().then(setStatus).catch(() => {});
  }, []);

  // A bare <details> stays open on outside click and ignores Escape, so it
  // sat over the page until clicked again.
  useEffect(() => {
    const close = () => detailsRef.current?.removeAttribute("open");
    const onPointerDown = (e: PointerEvent) => {
      const el = detailsRef.current;
      if (el?.hasAttribute("open") && !el.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function chooseTheme(next: ThemePreference) {
    setThemePreference(next);
    setTheme(next);
  }

  const needsAttention = !!status && (!status.configured || !!status.last_error);
  const badgeTitle = !status?.configured
    ? "Clé IA non configurée"
    : (status.last_error ?? undefined);

  async function logout() {
    await api.logout();
    navigate("/login");
  }

  return (
    <details className="account-menu" ref={detailsRef}>
      <summary aria-label="Compte" aria-haspopup="menu" title={badgeTitle}>
        <IconSettings size={18} />
        {needsAttention && (
          <>
            <span className="badge-dot" />
            {/* Colour alone carried this meaning; the title attribute isn't
                announced reliably, so state it for assistive tech too. */}
            <span className="visually-hidden">{badgeTitle}</span>
          </>
        )}
      </summary>
      <div className="account-menu-dropdown">
        <fieldset className="theme-picker">
          <legend>Thème</legend>
          {THEME_OPTIONS.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={theme === option.value}
                onChange={() => chooseTheme(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <Link to="/settings" className="link">
          Réglages
        </Link>
        <button className="link" onClick={logout}>
          Se déconnecter
        </button>
      </div>
    </details>
  );
}
