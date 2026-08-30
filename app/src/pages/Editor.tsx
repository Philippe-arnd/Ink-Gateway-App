import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import { Text } from "@tiptap/extension-text";
import {
  api,
  streamSession,
  type BookContext,
  type Comment,
  type SessionDiff,
  type SessionIntent,
  type VersionEntry,
} from "../api";
import { PlainDoc, PlainBlock, PlainTextKeymap, charOffsetToPos, posToCharOffset } from "../plainText";
import { IconArrowRight, IconCheck, IconComment, IconPencil, IconSparkles } from "../icons";
import { SessionModal } from "../components/SessionModal";
import { DiffView } from "../components/DiffView";

function diffRange(oldText: string, newText: string): { start: number; end: number; content: string } {
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText[start] === newText[start]) start++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return { start, end: oldEnd, content: newText.slice(start, newEnd) };
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

export function Editor() {
  const { id } = useParams<{ id: string }>();
  const [ctx, setCtx] = useState<BookContext | null>(null);
  const [tab, setTab] = useState<"prose" | "soul" | "outline" | "characters" | "lore">("prose");
  const [comments, setComments] = useState<Comment[]>([]);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [modalOpen, setModalOpen] = useState(false);
  const [sessionPhase, setSessionPhase] = useState<"idle" | "running" | "error" | "diff">("idle");
  const [sessionLog, setSessionLog] = useState<ChatLine[]>([]);
  const [sessionTag, setSessionTag] = useState<string | null>(null);
  const [sessionDiff, setSessionDiff] = useState<SessionDiff | null>(null);
  const lastSynced = useRef("");
  const saveTimer = useRef<number | null>(null);

  const editor = useEditor({
    extensions: [PlainDoc, PlainBlock, Text, PlainTextKeymap],
    content: docFromText(""),
    onUpdate: ({ editor }) => {
      scheduleSave(editor.getText());
    },
  });

  const refresh = useCallback(async () => {
    if (!id) return;
    const [bookCtx, commentList, versionList] = await Promise.all([
      api.getBook(id),
      api.listComments(id),
      api.listVersions(id).catch(() => []),
    ]);
    setCtx(bookCtx);
    setComments(commentList);
    setVersions(versionList);
    lastSynced.current = bookCtx.current;
    editor?.commands.setContent(docFromText(bookCtx.current));
  }, [id, editor]);

  useEffect(() => {
    if (editor) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, id]);

  function scheduleSave(text: string) {
    setSaveState("idle");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(text), 1200);
  }

  async function save(text: string) {
    if (!id || text === lastSynced.current) return;
    setSaveState("saving");
    const { start, end, content } = diffRange(lastSynced.current, text);
    await api.rewriteRange(id, start, end, content);
    lastSynced.current = text;
    setSaveState("saved");
    const [commentList, versionList] = await Promise.all([
      api.listComments(id),
      api.listVersions(id).catch(() => []),
    ]);
    setComments(commentList);
    setVersions(versionList);
  }

  async function addCommentToSelection() {
    if (!id || !editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      window.alert("Sélectionne du texte d'abord.");
      return;
    }
    const text = window.prompt("Commentaire :");
    if (!text) return;
    await api.addComment(id, posToCharOffset(from), posToCharOffset(to), text);
    setComments(await api.listComments(id));
  }

  async function resolveComment(commentId: string) {
    if (!id) return;
    await api.resolveComment(id, commentId);
    setComments(await api.listComments(id));
  }

  async function restoreVersion(commit: string) {
    if (!id) return;
    if (!window.confirm("Restaurer cette version ? (crée un nouveau commit, l'historique reste intact)")) return;
    await api.restoreVersion(id, commit);
    await refresh();
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
      for await (const event of streamSession(id, { intent, instruction, selection_start, selection_end })) {
        if (event.type === "text") {
          setSessionLog((c) => [...c, { kind: "assistant", text: event.data }]);
        } else if (event.type === "tool_call") {
          setSessionLog((c) => [
            ...c,
            { kind: "tool_call", text: `${event.data.name}(${JSON.stringify(event.data.input)})` },
          ]);
        } else if (event.type === "tool_result") {
          setSessionLog((c) => [...c, { kind: "tool_result", text: event.data.name }]);
        } else if (event.type === "error") {
          setSessionLog((c) => [...c, { kind: "tool_error", text: event.data }]);
        } else if (event.type === "session_done") {
          tag = event.data.tag;
        }
      }
    } catch (err) {
      setSessionLog((c) => [
        ...c,
        { kind: "tool_error", text: err instanceof Error ? err.message : "Erreur inconnue" },
      ]);
    }

    if (!tag) {
      setSessionPhase("error");
      return;
    }
    setSessionTag(tag);
    const diff = await api.getSessionDiff(id, tag);
    setSessionDiff(diff);
    setSessionPhase("diff");
  }

  async function acceptSession() {
    setSessionPhase("idle");
    setSessionTag(null);
    setSessionDiff(null);
    await refresh();
  }

  async function rejectSession() {
    if (!id || !sessionTag) return;
    await api.restoreVersion(id, sessionTag);
    setSessionPhase("idle");
    setSessionTag(null);
    setSessionDiff(null);
    await refresh();
  }

  const openComments = useMemo(() => comments.filter((c) => !c.resolved), [comments]);
  const resolvedComments = useMemo(() => comments.filter((c) => c.resolved), [comments]);

  if (!ctx) return <div className="loading">Chargement du livre…</div>;

  const subdoc = (name: string) => ctx.global_material.find((f) => f.filename.toLowerCase().startsWith(name));

  return (
    <div className="editor-layout">
      <aside className="sidebar">
        <Link to="/books" className="brand">
          <img src="/logo.svg" alt="" className="logo" />
          <span>Ink Gateway</span>
        </Link>
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
            <pre>{subdoc(tab)?.content ?? "(vide)"}</pre>
          </div>
        )}
      </aside>

      <main className="canvas">
        <div className="canvas-toolbar">
          <button onClick={addCommentToSelection} className="with-icon">
            <IconComment size={15} />
            Commenter la sélection
          </button>
          <span className={`save-state ${saveState}`}>
            {saveState === "saving" ? "Enregistrement…" : saveState === "saved" ? "Enregistré (git)" : ""}
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
            <div className="chat-log">
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
            <button onClick={() => setSessionPhase("idle")}>Fermer</button>
          </div>
        )}

        {sessionPhase === "diff" && sessionDiff && (
          <div className="session-diff">
            <DiffView before={sessionDiff.before} after={sessionDiff.after} />
            <div className="diff-actions">
              <button className="reject" onClick={rejectSession}>
                Rejeter
              </button>
              <button className="accept" onClick={acceptSession}>
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
