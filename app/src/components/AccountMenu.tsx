import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ApiKeyStatus } from "../api";
import { IconSettings } from "../icons";

// Small settings/account menu with a badge on the trigger icon when the AI
// credential is missing or errored on its last real use — mounted wherever
// the user might be mid-work (Books list, Editor) so they don't have to go
// looking in Settings to notice.
export function AccountMenu() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.getApiKey().then(setStatus).catch(() => {});
  }, []);

  const needsAttention = !!status && (!status.configured || !!status.last_error);
  const badgeTitle = !status?.configured
    ? "Clé IA non configurée"
    : (status.last_error ?? undefined);

  async function logout() {
    await api.logout();
    navigate("/login");
  }

  return (
    <details className="account-menu">
      <summary aria-label="Compte" title={badgeTitle}>
        <IconSettings size={18} />
        {needsAttention && <span className="badge-dot" />}
      </summary>
      <div className="account-menu-dropdown">
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
