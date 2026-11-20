import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, streamChat } from "../../api";
import { IconCheck, IconComment, IconPencil, IconSparkles } from "../../icons";
import { parseMarkdown } from "./markdown";
import {
  chatReducer,
  initialChatState,
  turnChangedManuscript,
  type ChatMessage,
  type ToolAction,
} from "./chatState";

interface Props {
  bookId: string;
  /** Live selection, read at send time so the chip can't go stale. */
  getSelection: () => { start: number; end: number; text: string } | null;
  /** Called after a turn that wrote to the manuscript. */
  onManuscriptChanged: () => void;
}

/** Prompts that get the author moving without having to phrase a request. */
const QUICK_ACTIONS: Array<{ label: string; prompt: string; needsSelection?: boolean }> = [
  { label: "Continuer", prompt: "Continue l'histoire à partir d'où elle en est." },
  {
    label: "Corriger",
    prompt:
      "Relis le brouillon et corrige uniquement l'orthographe, la grammaire et la ponctuation.",
  },
  {
    label: "Réécrire la sélection",
    prompt: "Réécris le passage sélectionné.",
    needsSelection: true,
  },
  { label: "Où j'en suis ?", prompt: "Résume où en est le chapitre et ce qu'il reste à écrire." },
];

/**
 * The conversational surface. The backend's `POST /books/{id}/chat` has been
 * live from the start but had zero call sites — `streamChat` was dead code —
 * so the product's headline promise of "an AI Chat Agent that inserts prose,
 * rewrites sections and manages chapters" had no UI at all.
 *
 * The transcript is kept in localStorage per book. That is deliberately an
 * interim: the endpoint is stateless, so the agent's own continuity between
 * messages comes from the book context it is re-sent each turn, not from
 * this. Server-side threads are the next step.
 */
export function ChatPanel({ bookId, getSelection, onManuscriptChanged }: Props) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [selectionChip, setSelectionChip] = useState<{ start: number; end: number; text: string } | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** Cleared when the user scrolls up, so the view stops fighting them. */
  const [follow, setFollow] = useState(true);

  const storageKey = `ink.chat.${bookId}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length) dispatch({ type: "restore", messages: parsed });
      }
    } catch {
      // A corrupt or unavailable store must never block the editor.
    }
  }, [storageKey]);

  useEffect(() => {
    if (state.status === "streaming") return;
    try {
      // Cap what is retained: a long session would otherwise grow past the
      // per-origin quota and start throwing on write.
      window.localStorage.setItem(storageKey, JSON.stringify(state.messages.slice(-40)));
    } catch {
      // Ignore — the transcript is a convenience, not the source of truth.
    }
  }, [state.messages, state.status, storageKey]);

  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.messages, follow]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  }, []);

  const send = useCallback(
    async (text: string, selection: { start: number; end: number; text: string } | null) => {
      const trimmed = text.trim();
      if (!trimmed || state.status === "streaming") return;

      // The selection travels as an explicit character range, which is the
      // same coordinate space the agent's rewrite_range tool uses.
      const message = selection
        ? `${trimmed}\n\nPassage sélectionné (caractères ${selection.start}–${selection.end}) :\n"""\n${selection.text}\n"""`
        : trimmed;

      const id = `m${Date.now()}`;
      dispatch({ type: "send", id, text: trimmed });
      setDraft("");
      setSelectionChip(null);
      setFollow(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let wrote = false;

      try {
        for await (const event of streamChat(bookId, message, controller.signal)) {
          dispatch({ type: "event", id, event });
          if (event.type === "error") {
            dispatch({ type: "failed", id, text: event.data });
          }
          if (event.type === "tool_result") wrote = true;
        }
        dispatch({ type: "settled" });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          dispatch({ type: "settled" });
        } else if (err instanceof ApiError) {
          dispatch({ type: "failed", id, text: err.message, code: err.code });
        } else {
          dispatch({ type: "failed", id, text: "La conversation s'est interrompue." });
        }
      } finally {
        abortRef.current = null;
        if (wrote) onManuscriptChanged();
      }
    },
    [bookId, onManuscriptChanged, state.status],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const streaming = state.status === "streaming";

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter sends; plain Enter inserts a newline, because asking the
    // agent for something often takes more than one line.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void send(draft, selectionChip);
    }
  };

  const runQuickAction = (prompt: string, needsSelection?: boolean) => {
    const selection = needsSelection ? getSelection() : null;
    if (needsSelection && !selection) {
      setDraft(prompt);
      composerRef.current?.focus();
      return;
    }
    void send(prompt, selection);
  };

  const attachSelection = () => {
    const selection = getSelection();
    setSelectionChip(selection);
    composerRef.current?.focus();
  };

  const hasMessages = state.messages.length > 0;

  return (
    <div className="chat">
      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        {!hasMessages && (
          <div className="chat-empty">
            <IconSparkles size={20} />
            <p>
              Demande à ton co-auteur d'écrire, de réécrire un passage ou de relire. Il modifie
              directement ton manuscrit — chaque changement est un commit git.
            </p>
          </div>
        )}

        <div aria-live="polite" aria-busy={streaming}>
          {state.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </div>
      </div>

      <div className="chat-composer">
        <div className="quick-actions">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              className="badge badge-accent quick-action"
              disabled={streaming}
              onClick={() => runQuickAction(action.prompt, action.needsSelection)}
            >
              {action.label}
            </button>
          ))}
        </div>

        {selectionChip && (
          <div className="selection-chip">
            <span>
              Sélection · {selectionChip.end - selectionChip.start} caractères
            </span>
            <button type="button" className="btn-link" onClick={() => setSelectionChip(null)}>
              retirer
            </button>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft, selectionChip);
          }}
        >
          <label className="visually-hidden" htmlFor="chat-input">
            Message pour le co-auteur
          </label>
          <textarea
            id="chat-input"
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Écris à ton co-auteur…"
            rows={3}
            disabled={streaming}
          />
          <div className="composer-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={attachSelection}
              disabled={streaming}
              title="Joindre le passage sélectionné"
            >
              <IconComment size={13} />
              Joindre la sélection
            </button>
            {streaming ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={stop}>
                Arrêter
              </button>
            ) : (
              <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim()}>
                Envoyer
                <kbd>⌘↵</kbd>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <span className="msg-author">
          <IconPencil size={12} /> Toi
        </span>
        <p>{message.text}</p>
      </div>
    );
  }

  if (message.role === "error") {
    return <ErrorMessage text={message.text} code={message.code} />;
  }

  const blocks = parseMarkdown(message.text);

  return (
    <div className="msg msg-assistant">
      <span className="msg-author">
        <IconSparkles size={12} /> Co-auteur
      </span>

      {blocks.map((block, i) => (
        <Block key={i} kind={block.kind} html={block.html} />
      ))}

      {message.streaming && !message.text && message.actions.length === 0 && (
        <p className="msg-thinking">
          <span className="caret" /> réfléchit…
        </p>
      )}
      {message.streaming && message.text && <span className="caret" />}

      {message.actions.length > 0 && (
        <ul className="list-plain action-list">
          {message.actions.map((action) => (
            <ActionCard key={action.id} action={action} />
          ))}
        </ul>
      )}

      {!message.streaming && turnChangedManuscript(message) && (
        <p className="msg-note">Ton manuscrit a été modifié et versionné dans git.</p>
      )}
    </div>
  );
}

function Block({ kind, html }: { kind: string; html: string }) {
  // The HTML here is produced only by markdown.ts, which escapes its input and
  // re-introduces a fixed set of marks — model output can't inject markup.
  const content = <span dangerouslySetInnerHTML={{ __html: html }} />;
  switch (kind) {
    case "code":
      return (
        <pre className="msg-code">
          <code>{content}</code>
        </pre>
      );
    case "bullet":
      return <p className="msg-bullet">{content}</p>;
    case "ordered":
      return <p className="msg-ordered">{content}</p>;
    case "quote":
      return <blockquote className="msg-quote">{content}</blockquote>;
    default:
      return <p>{content}</p>;
  }
}

function ActionCard({ action }: { action: ToolAction }) {
  const [open, setOpen] = useState(false);
  const detail = useMemo(() => {
    const content = action.input.content ?? action.input.text;
    return typeof content === "string" ? content : null;
  }, [action.input]);

  const pending = action.ok === undefined;
  const failed = action.ok === false;

  return (
    <li className={`action${failed ? " action-failed" : ""}`}>
      <button
        type="button"
        className="action-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!detail && !failed}
      >
        <span className={`icon-tile ${failed ? "icon-tile-danger" : "icon-tile-success"}`}>
          {pending ? <IconSparkles size={13} className="spin" /> : failed ? "!" : <IconCheck size={13} />}
        </span>
        <span className="action-summary">{failed ? action.error : action.summary}</span>
      </button>
      {open && detail && <pre className="action-detail">{detail}</pre>}
    </li>
  );
}

/**
 * The API's messages are English while the UI is French, so anything with a
 * known code gets French copy and the raw message is kept only as a fallback
 * for codes we don't recognise.
 */
const ERROR_COPY: Record<string, string> = {
  no_provider_key:
    "Aucune clé IA n'est configurée. Ajoute-en une pour écrire avec ton co-auteur.",
  provider_auth: "Ta clé IA a été refusée par le fournisseur. Vérifie-la dans les réglages.",
  rate_limited: "Trop de requêtes d'affilée.",
  limit_reached: "L'agent a atteint sa limite d'outils pour ce tour.",
  not_found: "Ce livre est introuvable.",
  unauthenticated: "Ta session a expiré.",
  network: "Connexion au serveur impossible.",
};

/**
 * Error states the author can act on. The common failures here are a missing
 * or rejected provider key, which previously surfaced as an undifferentiated
 * raw message with no route to Settings.
 */
function ErrorMessage({ text, code }: { text: string; code?: string }) {
  const needsKey = code === "no_provider_key" || code === "provider_auth";
  const copy = (code && ERROR_COPY[code]) ?? text;
  return (
    <div className="msg msg-error">
      <p>{copy}</p>
      {needsKey && (
        <Link to="/settings" className="btn btn-primary btn-sm">
          Configurer une clé API
        </Link>
      )}
      {code === "rate_limited" && (
        <p className="muted">Trop de requêtes — attends un instant avant de réessayer.</p>
      )}
    </div>
  );
}
