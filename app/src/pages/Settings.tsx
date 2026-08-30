import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type ApiKeyStatus } from "../api";

export function Settings() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [provider, setProvider] = useState<"anthropic" | "gemini">("anthropic");
  const [keyType, setKeyType] = useState<"api_key" | "oauth_token">("api_key");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getApiKey().then(setStatus);
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const result = await api.setApiKey(provider, credential, provider === "anthropic" ? keyType : "api_key");
      setStatus(result);
      setCredential("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  async function remove() {
    await api.deleteApiKey();
    setStatus({ configured: false, provider: null, key_type: null, last_four: null });
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

        <form onSubmit={save}>
          <label>
            Fournisseur
            <select value={provider} onChange={(e) => setProvider(e.target.value as "anthropic" | "gemini")}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </label>

          {provider === "anthropic" && (
            <fieldset className="key-type-choice">
              <label>
                <input
                  type="radio"
                  name="key_type"
                  checked={keyType === "api_key"}
                  onChange={() => setKeyType("api_key")}
                />
                Clé API (<code>sk-ant-…</code>, facturation à l'usage)
              </label>
              <label>
                <input
                  type="radio"
                  name="key_type"
                  checked={keyType === "oauth_token"}
                  onChange={() => setKeyType("oauth_token")}
                />
                Super-token (compte Claude Pro/Max, via <code>claude setup-token</code> — utilise ton
                abonnement au lieu d'une facturation séparée)
              </label>
            </fieldset>
          )}

          <label>
            {provider === "anthropic" && keyType === "oauth_token" ? "Token" : "Clé API"}
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={provider === "anthropic" && keyType === "oauth_token" ? "sk-ant-oat…" : "sk-ant-… / AIza…"}
              required
              minLength={8}
            />
          </label>

          {error && <p className="error">{error}</p>}
          {saved && <p className="success">Enregistré.</p>}
          <button type="submit">Enregistrer</button>
        </form>
      </section>
    </div>
  );
}
