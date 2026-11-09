import { useCallback, useMemo, useRef, useState } from "react";
import { HexView, type ByteDecorator, type HexViewHandle, type HexViewProps } from "./HexView";
import { diffBuffers, findRange, rangeKind, type BufferDiff } from "./diff";
import { addressDigitsFor, byteToHex, formatAddress } from "./format";
import "./HexDiffView.css";

export interface HexDiffViewProps
  extends Omit<HexViewProps, "data" | "decorateByte" | "ref" | "aria-label"> {
  /** The buffer shown, e.g. a device read or a readback. */
  a: Uint8Array;
  /** The reference it is checked against, e.g. the file or the written image. */
  b: Uint8Array;
  /** Name for `a` in the summary and tooltips. Default "A". */
  aLabel?: string;
  /** Name for `b` in the summary and tooltips. Default "B". */
  bLabel?: string;
  "aria-label"?: string;
}

/**
 * Hex view of `a` with every byte that differs from `b` highlighted, a count
 * of differing bytes, and previous / next buttons that scroll between
 * differences. If `b` is longer, its extra bytes are shown after `a`'s,
 * marked missing; if `a` is longer, its tail is marked extra.
 */
export function HexDiffView({
  a,
  b,
  aLabel = "A",
  bLabel = "B",
  baseAddress = 0,
  bytesPerRow = 16,
  "aria-label": ariaLabel,
  ...viewProps
}: HexDiffViewProps) {
  const diff = useMemo(() => diffBuffers(a, b), [a, b]);
  const shown = useMemo(() => displayBuffer(a, b), [a, b]);
  const [current, setCurrent] = useState(-1);
  const viewRef = useRef<HexViewHandle>(null);

  // New buffers mean a new diff; forget the old position. (Adjusting state
  // during render is React's recommended alternative to an effect here.)
  const [seenDiff, setSeenDiff] = useState(diff);
  if (seenDiff !== diff) {
    setSeenDiff(diff);
    setCurrent(-1);
  }

  const goTo = useCallback(
    (ordinal: number) => {
      setCurrent(ordinal);
      viewRef.current?.scrollToIndex(diff.starts[ordinal]);
    },
    [diff],
  );

  const decorateByte = useCallback<ByteDecorator>(
    (index, value) => {
      const ordinal = findRange(diff, index);
      if (ordinal < 0) return undefined;
      const kind = rangeKind(diff, ordinal);
      const mark = ordinal === current ? " hv-diff-current" : "";
      if (kind === "changed") {
        return {
          className: `hv-diff-changed${mark}`,
          title: `${aLabel} ${byteToHex(value)} · ${bLabel} ${byteToHex(b[index])}`,
        };
      }
      if (kind === "extra") {
        return { className: `hv-diff-extra${mark}`, title: `Not in ${bLabel}` };
      }
      return {
        className: `hv-diff-missing${mark}`,
        title: `Missing from ${aLabel} · ${bLabel} ${byteToHex(value)}`,
      };
    },
    [diff, current, b, aLabel, bLabel],
  );

  const count = diff.rangeCount;
  const digits = addressDigitsFor(shown.length, baseAddress, viewProps.addressDigits);

  return (
    <div className="hexdiff">
      <div className="hexdiff-toolbar">
        <span className="hexdiff-summary" role="status">
          {summarize(diff, aLabel, bLabel)}
        </span>
        <span className="hexdiff-nav">
          {current >= 0 && (
            <span className="hexdiff-position">
              {current + 1} of {count} at{" "}
              {formatAddress(baseAddress + diff.starts[current], digits)}
            </span>
          )}
          <button
            type="button"
            onClick={() => goTo(current - 1)}
            disabled={current <= 0}
          >
            Previous difference
          </button>
          <button
            type="button"
            onClick={() => goTo(current + 1)}
            disabled={current >= count - 1}
          >
            Next difference
          </button>
        </span>
      </div>
      <HexView
        {...viewProps}
        ref={viewRef}
        data={shown}
        baseAddress={baseAddress}
        bytesPerRow={bytesPerRow}
        decorateByte={decorateByte}
        aria-label={ariaLabel ?? `${aLabel} compared with ${bLabel}`}
      />
    </div>
  );
}

/** `a`, extended with `b`'s tail when `b` is longer (copies only then). */
function displayBuffer(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length >= b.length) return a;
  const out = new Uint8Array(b.length);
  out.set(a);
  out.set(b.subarray(a.length), a.length);
  return out;
}

function summarize(diff: BufferDiff, aLabel: string, bLabel: string): string {
  if (diff.differingBytes === 0) return `${aLabel} and ${bLabel} match`;
  const n = diff.differingBytes;
  const parts = [`${plural(n, "byte")} ${n === 1 ? "differs" : "differ"}`];
  if (diff.changedBytes > 0 && diff.aLength !== diff.bLength) {
    parts.push(`${diff.changedBytes.toLocaleString()} changed`);
  }
  const gap = Math.abs(diff.aLength - diff.bLength);
  if (diff.aLength > diff.bLength) {
    parts.push(`${aLabel} has ${plural(gap, "extra byte")}`);
  } else if (diff.bLength > diff.aLength) {
    parts.push(`${aLabel} is ${plural(gap, "byte")} short`);
  }
  return parts.join(" · ");
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}
