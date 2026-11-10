// Edit model for the hex editor. Pure: no DOM, no React.
//
// An EditState is an immutable value. Every change returns a new state with a
// new `bytes` array; the caller's `original` is never written to. Copying the
// buffer per change costs a memcpy (a few ms at 16 MiB), which keeps React's
// identity-based rendering honest without a mutable shadow buffer.
//
// History is a stack of patches, not snapshots: each patch holds only the
// bytes it touched, before and after. It is bounded twice, by step count and
// by the bytes the patches hold, so a long session or one huge fill cannot
// grow without limit. The oldest steps are dropped first; the newest step is
// always kept.
//
// The buffer length never changes: chip images are a fixed size, so every
// write is an overwrite, clipped at the end of the buffer.

export interface Patch {
  /** Index of the first byte the patch covers. */
  readonly offset: number;
  /** The bytes as they were. */
  readonly before: Uint8Array;
  /** The bytes as they became. Same length as `before`. */
  readonly after: Uint8Array;
  /** Writes that share a coalesce key merge into one undo step. */
  readonly coalesce?: number;
}

export interface HistoryLimits {
  /** Most undo steps kept. Default 1000. */
  steps?: number;
  /** Most bytes held across all undo steps (before + after). Default 64 MiB. */
  bytes?: number;
}

export interface EditState {
  /** The buffer as handed in. Never mutated. */
  readonly original: Uint8Array;
  /** The buffer with edits applied. Never mutated after creation. */
  readonly bytes: Uint8Array;
  /** How many bytes differ from `original`. 0 means unmodified. */
  readonly changedCount: number;
  readonly undoStack: readonly Patch[];
  readonly redoStack: readonly Patch[];
  readonly limits: Required<HistoryLimits>;
}

export const DEFAULT_HISTORY_STEPS = 1000;
export const DEFAULT_HISTORY_BYTES = 64 * 1024 * 1024;

export function createEditState(
  original: Uint8Array,
  limits: HistoryLimits = {},
): EditState {
  return {
    original,
    bytes: original,
    changedCount: 0,
    undoStack: [],
    redoStack: [],
    limits: {
      steps: Math.max(1, limits.steps ?? DEFAULT_HISTORY_STEPS),
      bytes: Math.max(0, limits.bytes ?? DEFAULT_HISTORY_BYTES),
    },
  };
}

export const isDirty = (s: EditState) => s.changedCount > 0;
export const canUndo = (s: EditState) => s.undoStack.length > 0;
export const canRedo = (s: EditState) => s.redoStack.length > 0;

export interface WriteOptions {
  /**
   * Merge with the previous undo step when it was written with the same key
   * and covers the same span — e.g. the two nibbles of one typed byte.
   */
  coalesce?: number;
}

/**
 * Overwrite bytes starting at `offset`. Values past the end of the buffer
 * are dropped (the length is fixed). A write that changes nothing returns
 * `state` unchanged and leaves the redo stack alone.
 */
export function writeBytes(
  state: EditState,
  offset: number,
  values: ArrayLike<number>,
  { coalesce }: WriteOptions = {},
): EditState {
  const { bytes } = state;
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) {
    return state;
  }
  const end = Math.min(offset + values.length, bytes.length);
  const after = new Uint8Array(end - offset);
  for (let i = 0; i < after.length; i++) after[i] = values[i];
  const before = bytes.slice(offset, end);
  if (sameBytes(before, after)) return state;

  const top = state.undoStack[state.undoStack.length - 1];
  const merge =
    coalesce !== undefined &&
    top?.coalesce === coalesce &&
    top.offset === offset &&
    top.after.length === after.length;

  const patch: Patch = merge
    ? { offset, before: top.before, after, coalesce }
    : { offset, before, after, coalesce };
  const undoStack = merge
    ? [...state.undoStack.slice(0, -1), patch]
    : [...state.undoStack, patch];

  return {
    ...state,
    bytes: applyRange(bytes, offset, after),
    changedCount: state.changedCount + changeDelta(state.original, offset, before, after),
    undoStack: trimHistory(undoStack, state.limits),
    redoStack: [],
  };
}

/** Set every byte in [start, end) to `value`. */
export function fillRange(
  state: EditState,
  start: number,
  end: number,
  value: number,
): EditState {
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(state.bytes.length, Math.floor(end));
  if (to <= from) return state;
  return writeBytes(state, from, new Uint8Array(to - from).fill(value & 0xff));
}

/**
 * Put every edited byte back to its original value, as one undoable step.
 * The step covers the span from the first to the last edited byte.
 */
export function revert(state: EditState): EditState {
  if (state.changedCount === 0) return state;
  const { bytes, original } = state;
  let first = 0;
  while (bytes[first] === original[first]) first++;
  let last = bytes.length - 1;
  while (bytes[last] === original[last]) last--;
  return writeBytes(state, first, original.subarray(first, last + 1));
}

/** Step back one edit. Returns `state` unchanged if there is none. */
export function undo(state: EditState): EditState {
  const patch = state.undoStack[state.undoStack.length - 1];
  if (!patch) return state;
  return {
    ...state,
    bytes: applyRange(state.bytes, patch.offset, patch.before),
    changedCount:
      state.changedCount +
      changeDelta(state.original, patch.offset, patch.after, patch.before),
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, patch],
  };
}

/** Re-apply the last undone edit. Returns `state` unchanged if there is none. */
export function redo(state: EditState): EditState {
  const patch = state.redoStack[state.redoStack.length - 1];
  if (!patch) return state;
  return {
    ...state,
    bytes: applyRange(state.bytes, patch.offset, patch.after),
    changedCount:
      state.changedCount +
      changeDelta(state.original, patch.offset, patch.before, patch.after),
    undoStack: [...state.undoStack, patch],
    redoStack: state.redoStack.slice(0, -1),
  };
}

/** The patch the next undo would revert, if any. */
export const nextUndo = (s: EditState): Patch | undefined =>
  s.undoStack[s.undoStack.length - 1];

/** The patch the next redo would re-apply, if any. */
export const nextRedo = (s: EditState): Patch | undefined =>
  s.redoStack[s.redoStack.length - 1];

function applyRange(bytes: Uint8Array, offset: number, values: Uint8Array): Uint8Array {
  const next = bytes.slice();
  next.set(values, offset);
  return next;
}

/** Change in the count of bytes that differ from `original` when the span
 *  at `offset` goes from `from` to `to`. */
function changeDelta(
  original: Uint8Array,
  offset: number,
  from: Uint8Array,
  to: Uint8Array,
): number {
  let delta = 0;
  for (let i = 0; i < from.length; i++) {
    const o = original[offset + i];
    const was = from[i] !== o;
    const is = to[i] !== o;
    if (was !== is) delta += is ? 1 : -1;
  }
  return delta;
}

function trimHistory(stack: Patch[], limits: Required<HistoryLimits>): Patch[] {
  let drop = Math.max(0, stack.length - limits.steps);
  let held = 0;
  for (let i = drop; i < stack.length; i++) held += patchSize(stack[i]);
  while (held > limits.bytes && drop < stack.length - 1) {
    held -= patchSize(stack[drop]);
    drop++;
  }
  return drop > 0 ? stack.slice(drop) : stack;
}

const patchSize = (p: Patch) => p.before.length + p.after.length;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
