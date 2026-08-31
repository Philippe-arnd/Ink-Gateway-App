import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  streamSession,
  ApiError,
  type ApiKeyStatus,
  type Book,
  type OnboardingQuestion,
  type SessionDiff,
} from "../api";
import { ApiKeyForm } from "../components/ApiKeyForm";
import { DiffView } from "../components/DiffView";

type Step = "credential" | "book-info" | "questions" | "submitting" | "offer-expand" | "expanding" | "expand-diff";

type LogLine =
  | { kind: "assistant" | "tool_call" | "tool_result" | "tool_error"; text: string };

// Mirrors ink-cli's own section grouping (`init.rs`'s `sections` array) —
// question index where each section starts, paired with its label.
const SECTIONS: [number, string][] = [
  [0, "Langue"],
  [1, "Format du livre"],
  [4, "Voix & style"],
  [6, "Personnages"],
  [8, "Arc narratif"],
  [11, "Monde"],
  [12, "Chapitre 1"],
];

// Ported from `suggested_defaults` in Ink-Gateway/src/init.rs — kept in sync
// manually since it's a trivial 3-arm match with no server round trip needed.
function suggestedDefaults(bookType: string): [number, number] {
  if (bookType === "Flash fiction") return [5, 2];
  if (bookType === "Short story") return [20, 3];
  return [250, 6]; // Novel
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("credential");
  const [questions, setQuestions] = useState<OnboardingQuestion[] | null>(null);

  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const [sectionIndex, setSectionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [book, setBook] = useState<Book | null>(null);
  const [expandLog, setExpandLog] = useState<LogLine[]>([]);
  const [expandTag, setExpandTag] = useState<string | null>(null);
  const [expandDiff, setExpandDiff] = useState<SessionDiff | null>(null);
  const [expandError, setExpandError] = useState<string | null>(null);

  useEffect(() => {
    api.getApiKey().then((s: ApiKeyStatus) => {
      if (s.configured) setStep("book-info");
    });
    api.getOnboardingQuestions().then(setQuestions);
    api.me().then((u) => setAuthor(u.email));
  }, []);

  function setAnswer(index: number, value: string) {
    setAnswers((prev) => ({ ...prev, [index]: value }));
  }

  const bookType = answers[1] ?? "Novel";

  async function submit() {
    setError(null);
    setStep("submitting");
    const answerPairs: [number, string][] = Object.entries(answers).map(([i, a]) => [Number(i), a]);
    try {
      const created = await api.startOnboarding(title, author, slug, answerPairs);
      setBook(created);
      setStep("offer-expand");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
      setStep("book-info");
    }
  }

  async function launchExpand() {
    if (!book) return;
    setStep("expanding");
    setExpandLog([]);
    setExpandError(null);

    let tag: string | null = null;
    try {
      for await (const event of streamSession(book.id, { intent: "expand_foundations" })) {
        if (event.type === "text") {
          setExpandLog((l) => [...l, { kind: "assistant", text: event.data }]);
        } else if (event.type === "tool_call") {
          setExpandLog((l) => [
            ...l,
            { kind: "tool_call", text: `${event.data.name}(${JSON.stringify(event.data.input)})` },
          ]);
        } else if (event.type === "tool_result") {
          setExpandLog((l) => [...l, { kind: "tool_result", text: event.data.name }]);
        } else if (event.type === "error") {
          setExpandLog((l) => [...l, { kind: "tool_error", text: event.data }]);
        } else if (event.type === "session_done") {
          tag = event.data.tag;
        }
      }
    } catch (err) {
      setExpandLog((l) => [
        ...l,
        { kind: "tool_error", text: err instanceof Error ? err.message : "Erreur inconnue" },
      ]);
    }

    if (!tag) {
      setExpandError("La session s'est arrêtée avant la fin.");
      return;
    }
    setExpandTag(tag);
    const diff = await api.getSessionDiff(book.id, tag);
    setExpandDiff(diff);
    setStep("expand-diff");
  }

  function acceptExpand() {
    if (book) navigate(`/books/${book.id}`);
  }

  async function rejectExpand() {
    if (!book || !expandTag || !expandDiff) return;
    for (const f of expandDiff.files) {
      await api.restoreVersion(book.id, expandTag, f.path);
    }
    navigate(`/books/${book.id}`);
  }

  return (
    <div className="books-screen">
      <header>
        <div className="brand">
          <img src="/logo.svg" alt="" className="logo" />
          <h1>Ink Gateway</h1>
        </div>
      </header>

      <section className="onboarding-card">
        {step === "credential" && (
          <>
            <h2>Ton co-auteur IA</h2>
            <p className="muted">
              Ink Gateway écrit avec toi en utilisant ta propre clé — configure-la avant de démarrer
              ton livre.
            </p>
            <ApiKeyForm onSaved={() => setStep("book-info")} />
          </>
        )}

        {step === "book-info" && (
          <>
            <h2>Commence ton livre</h2>
            <p className="muted">13 questions — environ 5 minutes.</p>
            {error && <p className="error">{error}</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setStep("questions");
              }}
            >
              <label>
                Titre
                <input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                  required
                />
              </label>
              <label>
                Auteur
                <input value={author} onChange={(e) => setAuthor(e.target.value)} required />
              </label>
              <label>
                Identifiant (dossier du livre)
                <input
                  value={slug}
                  onChange={(e) => {
                    setSlug(slugify(e.target.value));
                    setSlugTouched(true);
                  }}
                  required
                />
              </label>
              <button type="submit" disabled={!questions}>
                Continuer
              </button>
            </form>
          </>
        )}

        {step === "questions" && questions && (
          <>
            {(() => {
              const start = SECTIONS[sectionIndex][0];
              const end = sectionIndex + 1 < SECTIONS.length ? SECTIONS[sectionIndex + 1][0] : questions.length;
              const sectionQuestions = questions.slice(start, end);
              const isLastSection = sectionIndex === SECTIONS.length - 1;

              return (
                <>
                  <h2>{SECTIONS[sectionIndex][1]}</h2>
                  <div className="onboarding-questions">
                    {sectionQuestions.map((q, i) => {
                      const index = start + i;
                      if (q.options) {
                        return (
                          <label key={index}>
                            {q.question}
                            <select value={answers[index] ?? q.options[0]} onChange={(e) => setAnswer(index, e.target.value)}>
                              {q.options.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          </label>
                        );
                      }
                      if (index === 2 || index === 3) {
                        const [defaultPages, defaultSession] = suggestedDefaults(bookType);
                        const defaultValue = index === 2 ? defaultPages : defaultSession;
                        return (
                          <label key={index}>
                            {q.question}
                            <input
                              type="number"
                              min={1}
                              value={answers[index] ?? String(defaultValue)}
                              onChange={(e) => setAnswer(index, e.target.value)}
                            />
                            <span className="hint">{q.hint}</span>
                          </label>
                        );
                      }
                      return (
                        <label key={index}>
                          {q.question}
                          <textarea
                            value={answers[index] ?? ""}
                            onChange={(e) => setAnswer(index, e.target.value)}
                            placeholder={q.hint}
                            rows={3}
                          />
                        </label>
                      );
                    })}
                  </div>
                  {error && <p className="error">{error}</p>}
                  <div className="onboarding-nav">
                    <button
                      type="button"
                      className="link"
                      onClick={() => (sectionIndex === 0 ? setStep("book-info") : setSectionIndex((s) => s - 1))}
                    >
                      Précédent
                    </button>
                    <button
                      type="button"
                      onClick={() => (isLastSection ? submit() : setSectionIndex((s) => s + 1))}
                    >
                      {isLastSection ? "Créer mon livre" : "Suivant"}
                    </button>
                  </div>
                </>
              );
            })()}
          </>
        )}

        {step === "submitting" && <p>Création de ton livre…</p>}

        {step === "offer-expand" && (
          <>
            <h2>Développer les fondations</h2>
            <p className="muted">
              L'IA peut développer tes réponses en documents détaillés (Soul, Personnages,
              Intrigue, Univers, Chapitre 1) — tu valides le résultat avant qu'il ne reste.
            </p>
            <div className="onboarding-nav">
              <button type="button" className="link" onClick={acceptExpand}>
                Passer, j'irai directement à mon livre
              </button>
              <button type="button" onClick={launchExpand}>
                Lancer la session
              </button>
            </div>
          </>
        )}

        {step === "expanding" && (
          <>
            <h2>L'IA développe tes fondations…</h2>
            <div className="onboarding-log">
              {expandLog.map((line, i) => (
                <div key={i} className={`chat-line ${line.kind}`}>
                  {line.text}
                </div>
              ))}
            </div>
            {expandError && (
              <>
                <p className="error">{expandError}</p>
                <div className="onboarding-nav">
                  <button type="button" className="link" onClick={acceptExpand}>
                    Passer
                  </button>
                  <button type="button" onClick={launchExpand}>
                    Réessayer
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {step === "expand-diff" && expandDiff && (
          <>
            <h2>Relire les changements</h2>
            {expandDiff.files.map((f) => (
              <div key={f.path}>
                <h4 className="diff-file-path">{f.path}</h4>
                <DiffView before={f.before} after={f.after} />
              </div>
            ))}
            <div className="onboarding-nav">
              <button type="button" className="link" onClick={rejectExpand}>
                Rejeter
              </button>
              <button type="button" onClick={acceptExpand}>
                Accepter et continuer
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
