import { useState, type FormEvent } from "react";
import { api, ApiError, type ApiKeyStatus } from "../api";

// Shared by Settings and Onboarding — same fields/validation either way.
export function ApiKeyForm({ onSaved }: { onSaved: (status: ApiKeyStatus) => void }) {
  const [provider, setProvider] = useState<"anthropic" | "gemini">("anthropic");
  const [keyType, setKeyType] = useState<"api_key" | "oauth_token">("api_key");
  const [credential, setCredential] = useState("");
  const [state, setState] = useState<"idle" | "verifying" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setState("verifying");
    setError(null);
    try {
      const result = await api.setApiKey(provider, credential, provider === "anthropic" ? keyType : "api_key");
      setCredential("");
      setState("idle");
      onSaved(result);
    } catch (err) {
      setState("error");
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  const verifying = state === "verifying";

  return (
    <form onSubmit={save}>
      <label>
        Fournisseur
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as "anthropic" | "gemini")}
          disabled={verifying}
        >
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
              disabled={verifying}
            />
            Clé API (<code>sk-ant-…</code>, facturation à l'usage)
          </label>
          <label>
            <input
              type="radio"
              name="key_type"
              checked={keyType === "oauth_token"}
              onChange={() => setKeyType("oauth_token")}
              disabled={verifying}
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
          disabled={verifying}
        />
      </label>

      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={verifying}>
        {verifying ? "Vérification…" : "Enregistrer"}
      </button>
    </form>
  );
}
