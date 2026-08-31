import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";

export function Login() {
  const initialMode = new URLSearchParams(window.location.search).get("mode") === "register"
    ? "register"
    : "login";
  const [mode, setMode] = useState<"login" | "register" | "forgot">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [forgotSent, setForgotSent] = useState(false);
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode === "login") {
        await api.login(email, password);
        navigate("/books");
      } else if (mode === "register") {
        await api.register(email, password, inviteCode);
        navigate("/books");
      } else {
        await api.forgotPassword(email);
        setForgotSent(true);
      }
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

        {mode === "forgot" && forgotSent ? (
          <p className="success">
            Si un compte existe pour cette adresse, un email vient d'être envoyé avec un lien de
            réinitialisation.
          </p>
        ) : (
          <form onSubmit={submit}>
            <label>
              Email
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                required
              />
            </label>
            {mode !== "forgot" && (
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
            )}
            {mode === "register" && (
              <label>
                Code d'invitation
                <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required />
              </label>
            )}
            {error && <p className="error">{error}</p>}
            <button type="submit">
              {mode === "login" ? "Se connecter" : mode === "register" ? "Créer un compte" : "Envoyer le lien"}
            </button>
          </form>
        )}

        {mode === "login" && (
          <button className="link" onClick={() => setMode("forgot")}>
            Mot de passe oublié ?
          </button>
        )}
        <button
          className="link"
          onClick={() => {
            setForgotSent(false);
            setError(null);
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login"
            ? "Pas encore de compte ? S'inscrire"
            : mode === "register"
              ? "Déjà un compte ? Se connecter"
              : "Retour à la connexion"}
        </button>
      </div>
    </div>
  );
}

export function ResetPassword() {
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  if (!token) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="error">Lien invalide.</p>
          <Link className="link" to="/login">
            Retour à la connexion
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img src="/logo.svg" alt="Ink Gateway" className="logo" />
        <h1>Nouveau mot de passe</h1>
        {done ? (
          <>
            <p className="success">Mot de passe mis à jour.</p>
            <button className="link" onClick={() => navigate("/login")}>
              Se connecter
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <label>
              Nouveau mot de passe
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                required
                minLength={8}
                autoFocus
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit">Réinitialiser</button>
          </form>
        )}
      </div>
    </div>
  );
}
