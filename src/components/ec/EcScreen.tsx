import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatByteCount } from "../../lib/device/format";
import type { EcController } from "../../lib/ec/controller";
import {
  progressLabel,
  STEP_LABELS,
  stepAvailability,
  WIRING,
  type EcState,
  type EcStep,
} from "../../lib/ec/state";
import { ProgrammerDiagnosis } from "../detect";
import { LogPane } from "../device/LogPane";
import { useMasked } from "../../lib/stream/useMasked";
import "../device/DeviceScreen.css";
import "./EcScreen.css";

export interface EcScreenProps {
  controller: EcController;
  /** Shown under the side column: the app's version line. */
  footer?: ReactNode;
  /** Draw every file path as "[hidden]": the window is on a live stream. */
  hidePaths?: boolean;
}

/** The two steps with a button in the main column. */
type MainStep = Exclude<EcStep, "probe">;
const STEPS: readonly MainStep[] = ["identify", "backup"];

const HINTS: Record<EcStep, string> = {
  probe: "Check whether a CH341A is plugged in. Doesn't touch the EC.",
  identify: "Ask the chip what it is. Stops the EC for a moment.",
  backup: "Read the chip twice and save it. Stops the EC while it reads.",
};

function flashromText(state: EcState): string {
  const { flashrom } = state;
  if (flashrom === null) return "Looking for flashrom…";
  if (flashrom.availability.status === "missing") return "Not found";
  const version = flashrom.availability.version;
  return version ? `flashrom ${version}` : "flashrom, version not known";
}

function programmerText(state: EcState): string {
  if (state.running?.step === "probe") return "Looking…";
  switch (state.probe.status) {
    case "found":
      return `${state.probe.info.model} connected`;
    case "none":
      // flashrom found nothing either way. The OS may know one is there.
      return state.diagnosis && state.diagnosis.programmers.length > 0
        ? "CH341A plugged in, but not usable yet"
        : "No CH341A found";
    case "unknown":
      return "Not looked for yet";
  }
}

/**
 * The screen where a laptop's EC is backed up without taking the chip off
 * the board: flashrom and the CH341A on the left; the wiring checks, the two
 * steps and the log on the right. All of its state lives in the controller;
 * this only lays it out.
 */
export function EcScreen({ controller, footer, hidePaths = false }: EcScreenProps) {
  const real = useSyncExternalStore(controller.subscribe, controller.getState);
  // Only what's drawn is masked: the controller works on the real state.
  const state = useMasked(real, hidePaths);
  const reasonId = useId();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    void controller.open();
  }, [controller]);

  const { flashrom, running, outcome, backup, session } = state;
  const busy = running !== null;
  const missing = flashrom?.availability.status === "missing" ? flashrom.availability : null;
  const probe = stepAvailability(state, "probe");
  const availability: Record<MainStep, ReturnType<typeof stepAvailability>> = {
    identify: stepAvailability(state, "identify"),
    backup: stepAvailability(state, "backup"),
  };
  const reasons = busy
    ? []
    : [...new Set(STEPS.map((step) => availability[step].reason))].filter(Boolean);
  const chosen = state.flashromChosen !== null;

  async function copyHash() {
    if (!backup) return;
    try {
      await navigator.clipboard.writeText(backup.sha256);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="device-screen ec-screen">
      <div className="device-side">
        <section className="panel ec-chip" aria-label="Chip">
          <h2>Chip</h2>
          <p className="ec-headline">ENE KB9012</p>
          <p className="hint">
            A laptop's embedded controller, read over its EDI debug port with the chip still on
            the board. burnwright backs it up. It doesn't write to it.
          </p>
        </section>

        <section className="panel ec-flashrom" aria-label="flashrom">
          <h2>flashrom</h2>
          <p className="ec-headline" role="status">
            {flashromText(state)}
          </p>
          {flashrom?.path && (
            <p className="hint ec-path">
              {flashrom.path}
              {chosen ? " (chosen here)" : ""}
            </p>
          )}
          {missing && <p className="notice notice-warning">{missing.reason}</p>}
          {flashrom !== null && (missing || chosen) && (
            <div className="ec-actions">
              {missing && (
                <button
                  type="button"
                  onClick={controller.checkFlashrom}
                  disabled={state.flashromBusy || busy}
                >
                  Look again
                </button>
              )}
              {controller.canChooseFlashrom && (
                <button
                  type="button"
                  onClick={controller.chooseFlashrom}
                  disabled={state.flashromBusy || busy}
                >
                  Choose flashrom…
                </button>
              )}
              {chosen && (
                <button
                  type="button"
                  className="button-quiet"
                  onClick={controller.clearFlashromPath}
                  disabled={state.flashromBusy || busy}
                  title="Forget the chosen flashrom and look for one on this machine"
                >
                  Use the one installed
                </button>
              )}
            </div>
          )}
        </section>

        <section className="panel programmer ec-programmer" aria-label="Programmer">
          <h2>Programmer</h2>
          <p
            className={`ec-headline${state.probe.status === "none" ? " ec-headline-none" : ""}`}
            role="status"
          >
            {programmerText(state)}
          </p>
          <p className="hint">
            A CH341A in SPI mode. Looking for it doesn't touch the EC.
          </p>
          <div className="ec-actions">
            <button
              type="button"
              onClick={controller.lookForProgrammer}
              disabled={!probe.enabled}
              title={probe.reason ?? HINTS.probe}
            >
              {state.probe.status === "unknown" ? "Look for it" : "Look again"}
            </button>
          </div>
          {state.probe.status === "none" && state.diagnosis && !busy && (
            <ProgrammerDiagnosis diagnosis={state.diagnosis} subject="ch341a" />
          )}
        </section>
        {footer && <footer className="device-footer">{footer}</footer>}
      </div>

      <main className="device-main">
        <section className="panel ec-wiring" aria-label="Wiring">
          <h2>Before anything touches the board</h2>
          <p className="hint">
            burnwright can't check any of this. Tick each one when it's true.
          </p>
          <ul className="ec-checks">
            {WIRING.map((check) => (
              <li key={check.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={state.wiring[check.id] === true}
                    disabled={busy}
                    onChange={(event) => controller.setWiring(check.id, event.target.checked)}
                  />
                  <span className="ec-check-text">
                    <span className="ec-check-label">{check.label}</span>
                    <span className="hint">{check.detail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel ops ec-steps" aria-label="Backup" tabIndex={-1}>
          <div className="ops-buttons" role="group" aria-label="Backup steps">
            {STEPS.map((step) => {
              const { enabled, reason } = availability[step];
              return (
                <button
                  key={step}
                  type="button"
                  disabled={!enabled}
                  aria-describedby={enabled ? undefined : reasonId}
                  title={reason ?? HINTS[step]}
                  onClick={step === "identify" ? controller.identify : controller.backup}
                >
                  {STEP_LABELS[step]}
                </button>
              );
            })}
          </div>
          <p id={reasonId} className="hint ops-reason">
            {reasons.join(" ")}
          </p>

          {running && running.step !== "probe" && (
            <div className="ops-progress">
              <p role="status">{progressLabel(running, session)}</p>
              <div className="ops-progress-row">
                <progress
                  max={100}
                  value={running.percent ?? undefined}
                  aria-label={`${STEP_LABELS[running.step]} progress`}
                />
                <span className="ops-percent" aria-hidden="true">
                  {running.percent === null ? "" : `${running.percent}%`}
                </span>
                <button
                  type="button"
                  className="ops-cancel"
                  onClick={controller.cancel}
                  disabled={running.cancelling}
                >
                  {running.cancelling ? "Stopping…" : "Cancel"}
                </button>
              </div>
            </div>
          )}

          {outcome && !running && (
            <article
              className={`outcome outcome-${outcome.tone}`}
              role={outcome.tone === "error" ? "alert" : "status"}
            >
              <h3>{outcome.title}</h3>
              {outcome.details.map((detail) => (
                <p key={detail}>{detail}</p>
              ))}
            </article>
          )}

          {backup && !running && (
            <div className="ec-backup">
              {/* The outcome above is about a later step, not this file. */}
              {!(outcome?.step === "backup" && outcome.tone === "ok") && <h3>Last backup</h3>}
              <dl className="ec-facts">
                <div>
                  <dt>File</dt>
                  <dd className="ec-mono">{backup.path}</dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd className="ec-mono">{backup.sha256}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{formatByteCount(backup.len)}</dd>
                </div>
              </dl>
              <div className="ec-actions">
                {controller.canReveal && (
                  <button type="button" onClick={controller.revealBackup}>
                    Show in folder
                  </button>
                )}
                <button type="button" onClick={copyHash}>
                  Copy SHA-256
                </button>
                <span role="status" className="hint">
                  {copied === "copied" && "Copied"}
                  {copied === "failed" && "Couldn't copy: select the text instead."}
                </span>
              </div>
            </div>
          )}
        </section>

        <LogPane log={state.log} onClear={controller.clearLog} tool="flashrom" />
      </main>
    </div>
  );
}
