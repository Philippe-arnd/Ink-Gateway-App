import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence: without this, any render-time throw blanked the whole
 * page with no message and no way back.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="fatal-screen">
        <h1>Quelque chose s'est cassé</h1>
        <p className="muted">
          L'application a rencontré une erreur inattendue. Tes écrits sont enregistrés dans git à
          chaque modification — rien n'est perdu.
        </p>
        <pre className="fatal-detail">{error.message}</pre>
        <div className="fatal-actions">
          <button onClick={() => this.setState({ error: null })}>Réessayer</button>
          <button className="link" onClick={() => window.location.assign("/books")}>
            Retour à mes livres
          </button>
        </div>
      </div>
    );
  }
}
