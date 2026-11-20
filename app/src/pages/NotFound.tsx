import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="books-screen">
      <div className="empty-state">
        <h2>Page introuvable</h2>
        <p className="muted">Ce lien ne mène à rien — il a peut-être changé.</p>
        <Link to="/books" className="cta-button">
          Retour à mes livres
        </Link>
      </div>
    </div>
  );
}
