import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import { Text } from "@tiptap/extension-text";
import {
  api,
  ApiError,
  streamSession,
  type BookContext,
  type Comment,
  type SessionDiff,
  type SessionIntent,
  type VersionEntry,
} from "../api";
import { PlainDoc, PlainBlock, PlainTextKeymap, charOffsetToPos, posToCharOffset } from "../plainText";
import { diffRange } from "../lib/draftDiff";
import { IconArrowRight, IconCheck, IconComment, IconPencil, IconSparkles } from "../icons";
import { SessionModal } from "../components/SessionModal";
import { DiffView } from "../components/DiffView";
import { AccountMenu } from "../components/AccountMenu";

// Maps an editor sidebar tab to the foundational file it edits — the other
// four of `ink_core::edit::FOUNDATION_PATHS`' five allow-listed files
// (Chapter_01.md lives under "Chapters material", not a sidebar tab here).
const GLOBAL_MATERIAL_TABS: Record<string, string> = {
  soul: "Soul.md",
  outline: "Outline.md",
  characters: "Characters.md",
  lore: "Lore.md",
};

const VERSION_PAGE_SIZE = 20;

/// Human-readable labels for the agent's tools. The raw
/// `name({"content":"...entire manuscript..."})` dump was unreadable.
const TOOL_LABELS: Record<string, string> = {
  replace_current: "Réécriture du brouillon",
  insert_text: "Insertion de texte",
  rewrite_range: "Réécriture d'un passage",
  add_comment: "Ajout d'un commentaire",
  resolve_comment: "Commentaire résolu",
  rewrite_global_file: "Mise à jour d'un document de fond",
};

function describeToolName(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function describeToolCall({ name, input }: { name: string; input: unknown }): string {
  const label = describeToolName(name);
  const arg = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const content = typeof arg.content === "string" ? arg.content : undefined;
  const path = typeof arg.path === "string" ? arg.path : undefined;

  if (path) return `${label} — ${path}`;
  if (content !== undefined) {
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    return `${label} — ${words} mot${words === 1 ? "" : "s"}`;
  }
  return label;
}

function docFromText(text: string) {
  return {
    type: "doc",
    content: [{ type: "block", content: text.length ? [{ type: "text", text }] : [] }],
  };
}

type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call" | "tool_result" | "tool_error"; text: string };

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 1200;
/// Capped exponential backoff, so a server that is down for a minute doesn't
/// turn into a request storm but still recovers on its own.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Erreur inconnue";
}

export function Editor() {
  const { id } = useParams<{ id: string }>();
  const [ctx, setCtx] = useState<BookContext | null>(null);
  const [tab, setTab] = useState<"prose" | "soul" | "outline" | "characters" | "lore">("prose");
  const [comments, setComments] = useState<Comment[]>([]);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [sessionPhase, setSessionPhase] = useState<"idle" | "running" | "error" | "diff">("idle");
  const [sessionLog, setSessionLog] = useState<ChatLine[]>([]);
  const [sessionTag, setSessionTag] = useState<string | null>(null);
  const [sessionDiff, setSessionDiff] = useState<SessionDiff | null>(null);
  const [globalDrafts, setGlobalDrafts] = useState<Record<string, string>>({});
  const [globalSaving, setGlobalSaving] = useState(false);
  const [modifiedFoundations, setModifiedFoundations] = useState<string[]>([]);
  const lastSynced = useRef("");
  const saveTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const retryAttempt = useRef(0);
  /// The newest text the user has typed, whether or not it reached the server.
  /// Kept in a ref so unmount/visibility flushes can see it without a
  /// re-render, and so a failed save can be retried with current content.
  const pendingText = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const editor = useEditor({
    extensions: [PlainDoc, PlainBlock, Text, PlainTextKeymap],
    content: docFromText(""),
    onUpdate: ({ editor }) => {
      scheduleSave(editor.getText());
    },
  });

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [bookCtx, commentList, versionPage] = await Promise.all([
        api.getBook(id),
        api.listComments(id),
        api.listVersions(id, undefined, VERSION_PAGE_SIZE).catch(() => null),
      ]);
      setCtx(bookCtx);
      setComments(commentList);
      setVersions(versionPage?.versions ?? []);
      setLoadError(null);
      lastSynced.current = bookCtx.current;
      pendingText.current = null;
      editor?.commands.setContent(docFromText(bookCtx.current));
    } catch (err) {
      // Previously uncaught, which left the page on an eternal
      // "Chargement du livre…" with no message and no way out.
      setLoadError(messageOf(err));
    }
  }, [id, editor]);

  useEffect(() => {
    if (editor) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, id]);

  function scheduleSave(text: string) {
    pendingText.current = text;
    setSaveState(text === lastSynced.current ? "saved" : "dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(text), SAVE_DEBOUNCE_MS);
  }

  const save = useCallback(
    async function save(text: string): Promise<void> {
      if (!id || text === lastSynced.current) {
        pendingText.current = null;
        return;
      }
      setSaveState("saving");
      const { start, end, content } = diffRange(lastSynced.current, text);
      try {
        await api.rewriteRange(id, start, end, content);
      } catch (err) {
        // Critically, `lastSynced` is NOT advanced: the next attempt still
        // diffs against what the server actually has. Before this, a failed
        // save pinned the chip on "Enregistrement…" for ever while the author
        // kept typing into a document that was no longer being persisted.
        setSaveState("error");
        const delay = RETRY_DELAYS_MS[Math.min(retryAttempt.current, RETRY_DELAYS_MS.length - 1)];
        retryAttempt.current += 1;
        if (retryTimer.current) window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          const latest = pendingText.current;
          if (latest !== null) void save(latest);
        }, delay);
        throw err;
      }
      retryAttempt.current = 0;
      lastSynced.current = text;
      if (pendingText.current === text) pendingText.current = null;
      setSaveState("saved");
    },
    [id],
  );

  /// Flushes any debounced edit immediately — on Cmd+S, and before the tab
  /// goes away. Without this, the last keystrokes inside the debounce window
  /// were lost on navigation.
  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const text = pendingText.current;
    if (text !== null && text !== lastSynced.current) void save(text).catch(() => {});
  }, [save]);

  useEffect(() => {
    const onHide = () => flushSave();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSave();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flushSave();
      if (pendingText.current !== null && pendingText.current !== lastSynced.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Timers were never cleared, so a pending save could fire against an
      // unmounted component after a route change.
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      onHide();
    };
  }, [flushSave]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flushSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flushSave]);

  async function addCommentToSelection() {
    if (!id || !editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      window.alert("Sélectionne du texte d'abord.");
      return;
    }
    const text = window.prompt("Commentaire :");
    if (!text) return;
    try {
      await api.addComment(id, posToCharOffset(from), posToCharOffset(to), text);
      setComments(await api.listComments(id));
    } catch (err) {
      window.alert(`Impossible d'ajouter le commentaire : ${messageOf(err)}`);
    }
  }

  async function resolveComment(commentId: string) {
    if (!id) return;
    try {
      await api.resolveComment(id, commentId);
      setComments(await api.listComments(id));
    } catch (err) {
      window.alert(`Impossible de résoudre le commentaire : ${messageOf(err)}`);
    }
  }

  async function saveGlobalMaterial(tab: string) {
    const filename = GLOBAL_MATERIAL_TABS[tab];
    const content = globalDrafts[tab];
    if (!id || filename === undefined || content === undefined) return;
    setGlobalSaving(true);
    try {
      await api.saveGlobalMaterial(id, `Global Material/${filename}`, content);
      setModifiedFoundations((m) => (m.includes(filename) ? m : [...m, filename]));
      await refresh();
    } catch (err) {
      window.alert(`Enregistrement impossible : ${messageOf(err)}`);
    } finally {
      setGlobalSaving(false);
    }
  }

  async function restoreVersion(commit: string) {
    if (!id || busy) return;
    if (!window.confirm("Restaurer cette version ? (crée un nouveau commit, l'historique reste intact)")) return;
    setBusy(true);
    try {
      await api.restoreVersion(id, commit);
      await refresh();
    } catch (err) {
      window.alert(`Restauration impossible : ${messageOf(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function highlightSelection(comment: Comment) {
    if (!editor) return;
    editor.commands.setTextSelection({
      from: charOffsetToPos(comment.anchor_start),
      to: charOffsetToPos(comment.anchor_end),
    });
    editor.commands.scrollIntoView();
    editor.commands.focus();
  }

  async function launchSession(intent: SessionIntent, instruction: string) {
    if (!id || !editor) return;
    setModalOpen(false);
    setSessionPhase("running");
    setSessionLog([]);
    setSessionDiff(null);

    let selection_start: number | undefined;
    let selection_end: number | undefined;
    if (intent === "rewrite_selection") {
      const { from, to } = editor.state.selection;
      selection_start = posToCharOffset(from);
      selection_end = posToCharOffset(to);
    }

    let tag: string | null = null;
    try {
      for await (const event of streamSession(id, {
        intent,
        instruction,
        selection_start,
        selection_end,
      })) {
        if (event.type === "text") {
          // Append to the message already streaming rather than pushing a new
          // bubble per delta — that rendered a paragraph as a stack of dozens
          // of separate boxes.
          setSessionLog((c) => {
            const last = c[c.length - 1];
            if (last?.kind === "assistant") {
              return [...c.slice(0, -1), { kind: "assistant", text: last.text + event.data }];
            }
            return [...c, { kind: "assistant", text: event.data }];
          });
        } else if (event.type === "tool_call") {
          setSessionLog((c) => [...c, { kind: "tool_call", text: describeToolCall(event.data) }]);
        } else if (event.type === "tool_result") {
          setSessionLog((c) => [...c, { kind: "tool_result", text: describeToolName(event.data.name) }]);
        } else if (event.type === "error") {
          setSessionLog((c) => [...c, { kind: "tool_error", text: event.data }]);
        } else if (event.type === "session_done") {
          tag = event.data.tag;
        }
      }

      if (!tag) {
        setSessionPhase("error");
        return;
      }
      setSessionTag(tag);
      // Previously awaited outside the try, so a failure here left the panel
      // spinning in "running" with no way to recover.
      const diff = await api.getSessionDiff(id, tag);
      setSessionDiff(diff);
      setSessionPhase("diff");
    } catch (err) {
      setSessionLog((c) => [...c, { kind: "tool_error", text: messageOf(err) }]);
      setSessionPhase("error");
    }
  }

  async function acceptSession() {
    // `refresh()` calls setContent, which overwrites the buffer. If the author
    // typed while the agent was running, that text would be silently lost, so
    // ask before discarding it.
    const dirty = pendingText.current !== null && pendingText.current !== lastSynced.current;
    if (dirty && !window.confirm(
      "Tu as écrit pendant que l'agent travaillait. Recharger va remplacer ton texte non enregistré. Continuer ?",
    )) {
      return;
    }
    setSessionPhase("idle");
    setSessionTag(null);
    setSessionDiff(null);
    await refresh();
  }

  async function rejectSession() {
    if (!id || !sessionTag || !sessionDiff || busy) return;
    setBusy(true);
    try {
      for (const f of sessionDiff.files) {
        await api.restoreVersion(id, sessionTag, f.path);
      }
      setSessionPhase("idle");
      setSessionTag(null);
      setSessionDiff(null);
      await refresh();
    } catch (err) {
      setSessionLog((c) => [...c, { kind: "tool_error", text: messageOf(err) }]);
      setSessionPhase("error");
    } finally {
      setBusy(false);
    }
  }

  // Follow the stream. Without this the author watched the top of the output
  // while generation continued off-screen.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionLog]);

  const openComments = useMemo(() => comments.filter((c) => !c.resolved), [comments]);
  const resolvedComments = useMemo(() => comments.filter((c) => c.resolved), [comments]);

  if (loadError) {
    return (
      <div className="loading">
        <p className="error">Impossible de charger ce livre : {loadError}</p>
        <div className="loading-actions">
          <button onClick={() => void refresh()}>Réessayer</button>
          <Link to="/books" className="link">
            Retour à mes livres
          </Link>
        </div>
      </div>
    );
  }

  if (!ctx) return <div className="loading">Chargement du livre…</div>;

  const subdoc = (name: string) => ctx.global_material.find((f) => f.filename.toLowerCase().startsWith(name));

  return (
    <div className="editor-layout">
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <Link to="/books" className="brand">
            <img src="/logo.svg" alt="" className="logo" />
            <span>Ink Gateway</span>
          </Link>
          <AccountMenu />
        </div>
        <nav className="tabs">
          {(["prose", "soul", "outline", "characters", "lore"] as const).map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t === "prose" ? "Prose" : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        {tab === "prose" && (
          <>
            <div className="word-count">
              {ctx.word_count.total} / {ctx.word_count.target} mots
            </div>

            <h3>Chapitres</h3>
            <ul className="chapter-tree">
              {Array.from({ length: ctx.config.chapter_count }, (_, i) => i + 1).map((n) => (
                <li key={n} className={n === ctx.config.current_chapter ? "active" : ""}>
                  <span className="dot" />
                  Chapitre {n}
                </li>
              ))}
            </ul>

            <h3>Commentaires</h3>
            <ul className="comment-list">
              {openComments.length === 0 && <li className="muted">Aucun commentaire ouvert.</li>}
              {openComments.map((c) => (
                <li key={c.id}>
                  <button className="comment-anchor" onClick={() => highlightSelection(c)}>
                    <span className="comment-author">
                      {c.author === "ai" ? <IconSparkles size={12} /> : <IconPencil size={12} />}
                      {c.author === "ai" ? "IA" : "Toi"}
                    </span>
                    <span className="comment-text">{c.text}</span>
                  </button>
                  <button
                    className="resolve"
                    onClick={() => resolveComment(c.id)}
                    title="Marquer comme résolu"
                    aria-label="Marquer comme résolu"
                  >
                    <IconCheck size={13} />
                  </button>
                </li>
              ))}
            </ul>
            {resolvedComments.length > 0 && (
              <details>
                <summary>{resolvedComments.length} résolu(s)</summary>
                <ul className="comment-list resolved">
                  {resolvedComments.map((c) => (
                    <li key={c.id}>{c.text}</li>
                  ))}
                </ul>
              </details>
            )}

            <h3>Historique des versions</h3>
            <ul className="version-list">
              {versions.slice(0, 8).map((v) => (
                <li key={v.commit}>
                  <span className="version-message">{v.message}</span>
                  <span className="version-date">{new Date(v.date).toLocaleString("fr-FR")}</span>
                  <button onClick={() => restoreVersion(v.commit)}>Restaurer</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab !== "prose" && (
          <div className="subdoc-view">
            <textarea
              className="subdoc-editor"
              value={globalDrafts[tab] ?? subdoc(tab)?.content ?? ""}
              onChange={(e) => setGlobalDrafts((d) => ({ ...d, [tab]: e.target.value }))}
            />
            <button
              className="subdoc-save"
              disabled={globalSaving}
              onClick={() => saveGlobalMaterial(tab)}
            >
              {globalSaving ? "Enregistrement…" : "Enregistrer"}
            </button>
          </div>
        )}
      </aside>

      <main className="canvas">
        {modifiedFoundations.length > 0 && (
          <div className="consistency-banner">
            <span>
              Tu as modifié {modifiedFoundations.join(", ")} — vérifie que le reste du livre
              (chapitres, personnages, intrigue) reste cohérent avec ce changement.
            </span>
            <button className="link" onClick={() => setModifiedFoundations([])}>
              Ignorer
            </button>
          </div>
        )}
        <div className="canvas-toolbar">
          <button onClick={addCommentToSelection} className="with-icon">
            <IconComment size={15} />
            Commenter la sélection
          </button>
          <span className={`save-state ${saveState}`} role="status" aria-live="polite">
            {saveState === "saving" && "Enregistrement…"}
            {saveState === "saved" && "Enregistré (git)"}
            {saveState === "dirty" && "Modifications non enregistrées"}
            {saveState === "error" && (
              <>
                Échec de l'enregistrement — nouvelle tentative…{" "}
                <button className="link" onClick={flushSave}>
                  Réessayer
                </button>
              </>
            )}
          </span>
        </div>
        <EditorContent editor={editor} className="prose-editor" />
      </main>

      <aside className="chat-panel">
        <h3>Session d'écriture</h3>

        {sessionPhase === "idle" && (
          <div className="session-idle">
            <p className="muted">
              L'IA continue, corrige ou réécrit un passage — tu valides le résultat (diff) avant
              qu'il ne reste.
            </p>
            <button className="with-icon" onClick={() => setModalOpen(true)}>
              <IconSparkles size={15} />
              Nouvelle session d'écriture
            </button>
          </div>
        )}

        {sessionPhase === "running" && (
          <div className="session-running">
            <div className="session-spinner">
              <IconSparkles className="icon spin" size={20} />
              <span>L'agent travaille…</span>
            </div>
            <div className="chat-log" ref={logRef} aria-live="polite" aria-busy="true">
              {sessionLog.map((line, i) => (
                <div key={i} className={`chat-line ${line.kind}`}>
                  {line.kind === "tool_call" && <IconArrowRight className="icon" />}
                  {line.kind === "tool_result" && <IconCheck size={12} className="icon" />}
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sessionPhase === "error" && (
          <div className="session-error">
            <p className="error">La session s'est arrêtée avant la fin.</p>
            <div className="chat-log">
              {sessionLog.map((line, i) => (
                <div key={i} className={`chat-line ${line.kind}`}>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
            <div className="session-error-actions">
              <button onClick={() => setModalOpen(true)}>Réessayer</button>
              <button className="link" onClick={() => setSessionPhase("idle")}>
                Fermer
              </button>
            </div>
          </div>
        )}

        {sessionPhase === "diff" && sessionDiff && (
          <div className="session-diff">
            {sessionDiff.files.length === 0 && <p className="muted">Aucun changement.</p>}
            {sessionDiff.files.map((f) => (
              <div key={f.path}>
                {sessionDiff.files.length > 1 && <h4 className="diff-file-path">{f.path}</h4>}
                <DiffView before={f.before} after={f.after} />
              </div>
            ))}
            <div className="diff-actions">
              <button className="reject" onClick={rejectSession} disabled={busy}>
                {busy ? "Annulation…" : "Rejeter"}
              </button>
              <button className="accept" onClick={acceptSession} disabled={busy}>
                Accepter
              </button>
            </div>
          </div>
        )}
      </aside>

      {modalOpen && (
        <SessionModal
          hasSelection={!!editor && editor.state.selection.from !== editor.state.selection.to}
          onCancel={() => setModalOpen(false)}
          onLaunch={launchSession}
        />
      )}
    </div>
  );
}
