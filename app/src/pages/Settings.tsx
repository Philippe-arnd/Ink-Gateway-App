import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type ApiKeyStatus } from "../api";
import { ApiKeyForm } from "../components/ApiKeyForm";

export function Settings() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Previously had no .catch, so a failure left a blank card plus an
  // unhandled rejection.
  useEffect(() => {
    api
      .getApiKey()
      .then(setStatus)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Erreur inconnue"));
  }, []);

  async function remove() {
    setError(null);
    try {
      await api.deleteApiKey();
      setStatus({
        configured: false,
        provider: null,
        key_type: null,
        last_four: null,
        last_error: null,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Suppression impossible.");
    }
  }

  return (
    <div className="books-screen">
      <header>
        <Link to="/books" className="brand">
          <img src="/logo.svg" alt="" className="logo" />
          <h1>Réglages</h1>
        </Link>
      </header>

      <section className="settings-card">
        <h2>Co-auteur IA</h2>
        {error && <p className="error">{error}</p>}
        <p className="muted">
          Le chat éditeur utilise ta propre clé — elle est chiffrée (AES-256-GCM) côté serveur et
          n'est jamais renvoyée au navigateur après enregistrement.
        </p>

        {status?.configured && (
          <p className="current-key">
            Actuellement configuré : <strong>{status.provider}</strong>
            {status.provider === "anthropic" && (
              <> ({status.key_type === "oauth_token" ? "super-token / compte Claude" : "clé API"})</>
            )}{" "}
            — se termine par <code>…{status.last_four}</code>
            <button className="link" onClick={remove}>
              Supprimer
            </button>
          </p>
        )}
        {status?.last_error && (
          <p className="error">
            Dernière erreur de l'agent avec cette clé : {status.last_error}
          </p>
        )}

        <ApiKeyForm
          onSaved={(result) => {
            setStatus(result);
            setSaved(true);
          }}
        />
        {saved && <p className="success">Enregistré.</p>}
      </section>
    </div>
  );
}
