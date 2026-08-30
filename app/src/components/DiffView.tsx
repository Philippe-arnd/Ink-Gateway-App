import { diffWords } from "diff";

interface Props {
  before: string;
  after: string;
}

export function DiffView({ before, after }: Props) {
  const parts = diffWords(before, after);
  const additions = parts.filter((p) => p.added).length;
  const removals = parts.filter((p) => p.removed).length;

  return (
    <div className="diff-view">
      <div className="diff-summary">
        {additions === 0 && removals === 0 ? (
          <span className="muted">Aucun changement.</span>
        ) : (
          <>
            <span className="diff-added">+{additions}</span>{" "}
            <span className="diff-removed">-{removals}</span>
          </>
        )}
      </div>
      <div className="diff-body">
        {parts.map((part, i) => (
          <span
            key={i}
            className={part.added ? "diff-added" : part.removed ? "diff-removed" : undefined}
          >
            {part.value}
          </span>
        ))}
      </div>
    </div>
  );
}
