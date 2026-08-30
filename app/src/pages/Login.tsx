import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";

export function Login() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode === "login") await api.login(email, password);
      else await api.register(email, password, inviteCode);
      navigate("/books");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img src="/logo.svg" alt="Ink Gateway" className="logo" />
        <h1>Ink Gateway</h1>
        <p className="subtitle">Écrire avec un co-auteur IA, sans jamais quitter le navigateur.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          </label>
          <label>
            Mot de passe
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              minLength={8}
            />
          </label>
          {mode === "register" && (
            <label>
              Code d'invitation
              <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit">{mode === "login" ? "Se connecter" : "Créer un compte"}</button>
        </form>
        <button className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Pas encore de compte ? S'inscrire" : "Déjà un compte ? Se connecter"}
        </button>
      </div>
    </div>
  );
}
