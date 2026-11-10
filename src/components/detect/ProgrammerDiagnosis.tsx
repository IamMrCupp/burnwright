import { useState } from "react";
import { explainDiagnosis, type Explanation } from "../../lib/diagnosis";
import type { Diagnosis } from "../../lib/engine";
import "./ProgrammerDiagnosis.css";

export interface ProgrammerDiagnosisProps {
  diagnosis: Diagnosis;
}

/** Why no programmer was found, and how to fix it. */
export function ProgrammerDiagnosis({ diagnosis }: ProgrammerDiagnosisProps) {
  const explanations = explainDiagnosis(diagnosis);
  return (
    <section className="diagnosis" aria-label="Why no programmer was found">
      {explanations.map((explanation, i) => (
        <ExplanationCard key={i} explanation={explanation} />
      ))}
    </section>
  );
}

function ExplanationCard({ explanation }: { explanation: Explanation }) {
  return (
    <article className="diagnosis-card">
      <h3>{explanation.title}</h3>
      {explanation.programmer && (
        <p className="diagnosis-programmer">{explanation.programmer}</p>
      )}
      <p>{explanation.detail}</p>
      {explanation.command && <CopyableCommand command={explanation.command} />}
    </article>
  );
}

type CopyState = "idle" | "copied" | "failed";

function CopyableCommand({ command }: { command: string }) {
  const [state, setState] = useState<CopyState>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="diagnosis-command">
      <pre>
        <code>{command}</code>
      </pre>
      <button type="button" onClick={copy}>
        {state === "copied" ? "Copied" : "Copy command"}
      </button>
      {state === "failed" && (
        <span role="status">Couldn't copy: select the text instead.</span>
      )}
    </div>
  );
}
