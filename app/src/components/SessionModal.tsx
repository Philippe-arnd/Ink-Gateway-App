import { useState } from "react";
import type { SessionIntent } from "../api";

interface Props {
  hasSelection: boolean;
  onCancel: () => void;
  onLaunch: (intent: SessionIntent, instruction: string) => void;
}

const INTENTS: { value: SessionIntent; label: string; hint: string }[] = [
  {
    value: "continue",
    label: "Continuer l'histoire",
    hint: "Génère la suite dans le ton établi. Une direction est optionnelle.",
  },
  {
    value: "correct",
    label: "Corriger uniquement",
    hint: "Orthographe, grammaire, ponctuation — jamais l'intrigue, les dialogues ou le style.",
  },
  {
    value: "rewrite_selection",
    label: "Réécrire la sélection",
    hint: "Réécrit le passage actuellement sélectionné dans l'éditeur selon ton instruction.",
  },
  {
    value: "free",
    label: "Instruction libre",
    hint: "Décris ce que tu veux — l'agent choisit les outils nécessaires.",
  },
];

export function SessionModal({ hasSelection, onCancel, onLaunch }: Props) {
  const [intent, setIntent] = useState<SessionIntent>("continue");
  const [instruction, setInstruction] = useState("");

  const needsInstruction = intent === "rewrite_selection" || intent === "free";
  const blockedBySelection = intent === "rewrite_selection" && !hasSelection;
  const canLaunch = !blockedBySelection && (!needsInstruction || instruction.trim().length > 0);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Nouvelle session d'écriture</h2>
        <div className="intent-list">
          {INTENTS.map((i) => (
            <label key={i.value} className={`intent-option ${intent === i.value ? "selected" : ""}`}>
              <input
                type="radio"
                name="intent"
                checked={intent === i.value}
                onChange={() => setIntent(i.value)}
              />
              <div>
                <div className="intent-label">{i.label}</div>
                <div className="intent-hint">{i.hint}</div>
              </div>
            </label>
          ))}
        </div>

        {blockedBySelection && (
          <p className="error">Sélectionne d'abord du texte dans l'éditeur.</p>
        )}

        {needsInstruction && (
          <label className="modal-instruction">
            Instruction
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={
                intent === "rewrite_selection"
                  ? "Ex : rends ce passage plus tendu, resserre les dialogues…"
                  : "Ex : ajoute un personnage secondaire au chapitre 3…"
              }
              rows={3}
              autoFocus
            />
          </label>
        )}

        <div className="modal-actions">
          <button className="link" onClick={onCancel}>
            Annuler
          </button>
          <button disabled={!canLaunch} onClick={() => onLaunch(intent, instruction.trim())}>
            Lancer
          </button>
        </div>
      </div>
    </div>
  );
}
