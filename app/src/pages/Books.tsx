import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, type Book } from "../api";
import { AccountMenu } from "../components/AccountMenu";

export function Books() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .listBooks()
      .then((list) => {
        setBooks(list);
        setLoadError(null);
      })
      // A 401 is handled centrally by the unauthorized hook. Everything else
      // belongs on screen: the old condition was inverted, so a network blip
      // bounced the user to /login while a real 403/500 left this stuck on
      // "Chargement…" for ever.
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Erreur inconnue"));
  }, []);

  useEffect(load, [load]);

  async function createBook(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const book = await api.createBook(title, slug);
      navigate(`/books/${book.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    }
  }

  return (
    <div className="books-screen">
      <header>
        <div className="brand">
          <img src="/logo.svg" alt="" className="logo" />
          <h1>Ink Gateway</h1>
        </div>
        <div className="header-actions">
          {books !== null && books.length > 0 && (
            <Link to="/onboarding" className="link">
              + Nouveau livre
            </Link>
          )}
          <AccountMenu />
        </div>
      </header>

      {books?.length === 0 && (
        <div className="empty-state">
          <h2>Commence ton premier livre</h2>
          <p className="muted">
            Un assistant te guide en quelques étapes : clé API, puis quelques questions sur ton
            histoire.
          </p>
          <Link to="/onboarding" className="cta-button">
            Créer mon livre
          </Link>
        </div>
      )}

      {loadError && (
        <div className="empty-state">
          <p className="error">Impossible de charger tes livres : {loadError}</p>
          <button onClick={load}>Réessayer</button>
        </div>
      )}

      <section className="book-grid">
        {books === null && !loadError && <p>Chargement…</p>}
        {books?.map((b) => (
          <Link to={`/books/${b.id}`} key={b.id} className="book-card">
            <span className="book-title">{b.title}</span>
            <span className="book-date">{new Date(b.created_at).toLocaleDateString("fr-FR")}</span>
          </Link>
        ))}
      </section>

      <details className="add-book">
        <summary>+ Enregistrer un livre existant</summary>
        <form onSubmit={createBook}>
          <label>
            Titre
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label>
            Identifiant du dossier
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="mon-roman"
              pattern="[A-Za-z0-9_-]+"
              required
            />
            <small className="muted">
              Le nom du dossier d'un livre déjà initialisé sur le serveur. Pour un nouveau livre,
              utilise plutôt « Nouveau livre ».
            </small>
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit">Enregistrer</button>
        </form>
      </details>
    </div>
  );
}
