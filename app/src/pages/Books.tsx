import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, type Book } from "../api";

export function Books() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listBooks()
      .then(setBooks)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate("/login");
      });
  }, [navigate]);

  async function createBook(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const book = await api.createBook(title, slug);
      navigate(`/books/${book.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  async function logout() {
    await api.logout();
    navigate("/login");
  }

  return (
    <div className="books-screen">
      <header>
        <div className="brand">
          <img src="/logo.svg" alt="" className="logo" />
          <h1>Ink Gateway</h1>
        </div>
        <div className="header-actions">
          <Link to="/settings" className="link">
            Réglages
          </Link>
          <button className="link" onClick={logout}>
            Se déconnecter
          </button>
        </div>
      </header>

      <section className="book-grid">
        {books === null && <p>Chargement…</p>}
        {books?.length === 0 && <p>Aucun livre pour l'instant.</p>}
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
            Slug (dossier sous books_dir, scaffoldé via <code>ink-cli init</code>)
            <input value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit">Enregistrer</button>
        </form>
      </details>
    </div>
  );
}
