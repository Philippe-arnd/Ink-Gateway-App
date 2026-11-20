import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type BookStats, type ChapterList, type ChapterSummary } from "../../api";
import { IconCheck, IconPencil } from "../../icons";

interface Props {
  bookId: string;
  /** Opens a chapter's outline for reading. */
  onOpenChapter: (number: number) => void;
  /** Advancing rewrites .ink-state.yml and commits, so the book must reload. */
  onAdvanced: () => void;
}

/**
 * The chapter list used to be `Array.from({length: chapter_count})` rendering
 * non-interactive `<li>`s — N identical rows that said nothing about whether a
 * chapter had been outlined or reached, and which nothing could click. The API
 * now reports real per-chapter state, so this shows it.
 */
export function ChapterRail({ bookId, onOpenChapter, onAdvanced }: Props) {
  const [list, setList] = useState<ChapterList | null>(null);
  const [stats, setStats] = useState<BookStats | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .listChapters(bookId)
      .then(setList)
      .catch(() => setList(null));
    void api
      .getStats(bookId)
      .then(setStats)
      .catch(() => setStats(null));
  }, [bookId]);

  useEffect(load, [load]);

  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    setNotice(null);
    try {
      await api.advanceChapter(bookId);
      load();
      onAdvanced();
    } catch (err) {
      // Both refusals are ordinary, actionable states rather than failures,
      // and the server sends the numbers needed to say what is missing.
      setNotice(describeAdvanceRefusal(err));
    } finally {
      setAdvancing(false);
    }
  }

  if (!list) return null;

  const chapterProgress = stats
    ? Math.min(100, Math.round((stats.current_chapter_word_count / stats.words_per_chapter) * 100))
    : 0;

  return (
    <>
      {stats && (
        <section className="progress-hud" aria-label="Progression">
          <div className="hud-row">
            <span>Chapitre {stats.current_chapter}</span>
            <span className="muted">
              {stats.current_chapter_word_count.toLocaleString("fr-FR")} /{" "}
              {stats.words_per_chapter.toLocaleString("fr-FR")} mots
            </span>
          </div>
          <div
            className="hud-bar"
            role="progressbar"
            aria-valuenow={chapterProgress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progression du chapitre"
          >
            {/* The 90% mark is where advance-chapter stops refusing. */}
            <span className="hud-fill" style={{ width: `${chapterProgress}%` }} />
            <span className="hud-notch" />
          </div>
          <div className="hud-row muted">
            <span>Livre</span>
            <span>
              {stats.total_word_count.toLocaleString("fr-FR")} /{" "}
              {stats.target_length.toLocaleString("fr-FR")} mots
            </span>
          </div>
          {stats.chapter_close_suggested && (
            <p className="hud-suggestion">Ce chapitre est prêt à être clos.</p>
          )}
        </section>
      )}

      <h3>Chapitres</h3>
      <ul className="chapter-tree list-plain">
        {list.chapters.map((chapter) => (
          <ChapterRow key={chapter.number} chapter={chapter} onOpen={onOpenChapter} />
        ))}
      </ul>

      <div className="chapter-actions">
        <button className="btn btn-ghost btn-sm" onClick={advance} disabled={advancing}>
          {advancing ? "…" : "Passer au chapitre suivant"}
        </button>
        {notice && <p className="hud-notice">{notice}</p>}
      </div>
    </>
  );
}

function ChapterRow({
  chapter,
  onOpen,
}: {
  chapter: ChapterSummary;
  onOpen: (number: number) => void;
}) {
  const state = chapter.is_current
    ? "current"
    : chapter.has_outline
      ? "outlined"
      : "planned";

  return (
    <li className={`chapter ${state}`}>
      <button
        type="button"
        onClick={() => onOpen(chapter.number)}
        disabled={!chapter.has_outline}
        aria-current={chapter.is_current ? "true" : undefined}
        title={chapter.has_outline ? "Voir l'ébauche" : "Pas encore d'ébauche"}
      >
        <span className="dot" aria-hidden="true">
          {chapter.is_current ? <IconPencil size={10} /> : chapter.has_outline ? <IconCheck size={10} /> : null}
        </span>
        <span className="chapter-title">{chapter.title}</span>
        {chapter.word_count > 0 && <span className="chapter-words">{chapter.word_count}</span>}
      </button>
    </li>
  );
}

function describeAdvanceRefusal(err: unknown): string {
  if (!(err instanceof ApiError)) return "Impossible de changer de chapitre.";

  const details = (err.details ?? {}) as Record<string, unknown>;
  if (err.code === "chapter_not_ready") {
    const current = Number(details.current_word_count ?? 0);
    const needed = Number(details.min_words_to_advance ?? 0);
    const missing = Math.max(0, needed - current);
    return `Il te manque environ ${missing.toLocaleString("fr-FR")} mots avant de clore ce chapitre.`;
  }
  if (err.code === "needs_chapter_outline") {
    const chapter = details.chapter;
    return `Écris d'abord l'ébauche du chapitre ${chapter ?? "suivant"} — demande-la à ton co-auteur.`;
  }
  return err.message;
}
