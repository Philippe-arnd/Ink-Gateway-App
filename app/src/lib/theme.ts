/**
 * Theme preference. The app previously hardcoded `color-scheme: light` with
 * every surface colour as a literal, so dark mode wasn't merely absent — it
 * was unreachable. All the theme switch has to do now is stamp an attribute;
 * design/tokens.css redefines only the token layer beneath it.
 */

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "ink.theme";

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private windows and blocked site data both throw on access.
  }
  return "system";
}

/**
 * `system` removes the attribute rather than resolving the preference itself,
 * so the tokens' `prefers-color-scheme` block stays in charge and the page
 * follows the OS live — without a listener.
 */
export function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

export function setThemePreference(preference: ThemePreference) {
  applyTheme(preference);
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // A theme that doesn't persist is still better than one that throws.
  }
}

/** Call once before first paint to avoid a flash of the wrong theme. */
export function initTheme() {
  applyTheme(readThemePreference());
}
