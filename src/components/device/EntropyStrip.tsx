import { memo, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  ENTROPY_MAX,
  blockAt,
  entropyPath,
  flatBytes,
  formatBits,
  formatShare,
} from "../../lib/device/entropy";
import { formatOffset, formatSize } from "../../lib/device/format";
import type { InspectEntropy } from "../../lib/engine";

export interface EntropyStripProps {
  entropy: InspectEntropy;
  /** How many bytes were scanned. */
  len: number;
  /** Put the hex editor's cursor on this offset. */
  onJump: (offset: number) => void;
}

/**
 * How random each stretch of the buffer looks, start to end: nothing where
 * it's one value repeated, full height where it's packed. Pointing at it
 * reads a block out and a click goes to it; so do the arrow keys and Enter.
 */
export const EntropyStrip = memo(function EntropyStrip({
  entropy,
  len,
  onJump,
}: EntropyStripProps) {
  const { block, millibits } = entropy;
  const count = millibits.length;
  // The block last pointed at or stepped to. It stays put when the pointer
  // leaves, so the readout still says where a click went.
  const [marked, setMarked] = useState<number | null>(null);
  const path = useMemo(() => entropyPath(millibits), [millibits]);
  const flat = useMemo(() => flatBytes(entropy, len), [entropy, len]);

  if (count === 0) return null;

  // A scan of an edited buffer can come back with fewer blocks.
  const at = marked === null ? null : Math.min(marked, count - 1);
  const reading = (index: number) =>
    `${formatOffset(index * block)}, ${formatBits(millibits[index])} bits a byte`;

  const under = (event: MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? blockAt((event.clientX - box.left) / box.width, count) : 0;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const from = at ?? 0;
    const stride = Math.max(1, Math.round(count / 16));
    let to: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        to = from - 1;
        break;
      case "ArrowRight":
      case "ArrowUp":
        // The first press lands on the first block, not past it.
        to = at === null ? 0 : from + 1;
        break;
      case "PageDown":
        to = from - stride;
        break;
      case "PageUp":
        to = from + stride;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = count - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        setMarked(from);
        onJump(from * block);
        return;
      default:
        return;
    }
    event.preventDefault();
    setMarked(Math.min(Math.max(to, 0), count - 1));
  };

  return (
    <div className="entropy">
      <div
        className="entropy-strip"
        role="slider"
        tabIndex={0}
        aria-label="Entropy across the buffer"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={at ?? 0}
        aria-valuetext={reading(at ?? 0)}
        onMouseMove={(event) => setMarked(under(event))}
        onClick={(event) => {
          const index = under(event);
          setMarked(index);
          onJump(index * block);
        }}
        onKeyDown={onKeyDown}
      >
        <svg
          viewBox={`0 0 ${count} ${ENTROPY_MAX}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <path className="entropy-area" d={path} />
          {at !== null && (
            <line
              className="entropy-marker"
              x1={at + 0.5}
              x2={at + 0.5}
              y1={0}
              y2={ENTROPY_MAX}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <p className="hint entropy-caption">
        <span>
          Entropy of each {formatSize(block)}, from 0 to 8 bits a byte. Nothing drawn is one
          byte value repeated; near the top is what compressed or encrypted data looks
          like.{" "}
          {flat > 0 && (
            <>
              {capitalise(formatShare(flat, len))} of the buffer is flat, the way erased
              flash reads.
            </>
          )}
        </span>
        {at !== null && <span className="entropy-readout">{reading(at)}</span>}
      </p>
    </div>
  );
});

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
