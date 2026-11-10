import {
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type UIEvent,
} from "react";
import {
  addressDigitsFor,
  byteToAscii,
  byteToHex,
  formatAddress,
  MIN_ADDRESS_DIGITS,
} from "./format";
import {
  computeWindow,
  MAX_SCROLL_HEIGHT,
  scrollTopForRow,
  scrollTopToReveal,
} from "./virtual";
import "./HexView.css";

/** Extra presentation for one byte, applied to its hex and ASCII cells. */
export interface ByteDecoration {
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** Accessible name for the byte's cells, e.g. for the cursor byte. */
  label?: string;
}

/** Which column a byte cell is in. */
export type HexPane = "hex" | "ascii";

/** Mouse handler for a byte cell; `index` is the position in `data`. */
export type ByteMouseHandler = (
  index: number,
  event: MouseEvent<HTMLElement>,
  pane: HexPane,
) => void;

/**
 * Per-byte styling hook. Called only for bytes in rendered rows, so it can
 * be as cheap or as clever as the caller likes. `index` is the position in
 * `data` (not the address). Diff highlighting (#9) and selection / edit
 * marks (#27) both plug in here. Keep the function identity stable
 * (`useCallback`) or every visible row re-renders.
 */
export type ByteDecorator = (
  index: number,
  value: number,
) => ByteDecoration | undefined;

export interface HexViewHandle {
  /** Scroll so the row holding `data[index]` is at the top. */
  scrollToIndex(index: number): void;
  /** Scroll as little as needed to bring `data[index]`'s row fully into view. */
  revealIndex(index: number): void;
  /** Whole rows that fit in the viewport (for paging). */
  pageRows(): number;
  /** Move keyboard focus to the grid. */
  focus(): void;
}

export interface HexViewProps {
  /** The bytes to show. Never mutated. */
  data: Uint8Array;
  /** Address of `data[0]` — e.g. a chip's base address. Default 0. */
  baseAddress?: number;
  /** Bytes per row. Default 16. */
  bytesPerRow?: number;
  /** Add a visual gap every N bytes; 0 for none. Default 8. */
  groupSize?: number;
  /** Minimum address width in hex digits; widens to fit. Default 4. */
  addressDigits?: number;
  /** Row height in px. Rows are fixed-height so the grid can virtualise. Default 20. */
  rowHeight?: number;
  /** Height of the whole viewer (header + grid). Default "100%". */
  height?: number | string;
  /** Rows rendered above and below the viewport. Default 4. */
  overscan?: number;
  /** Per-byte styling hook; see {@link ByteDecorator}. */
  decorateByte?: ByteDecorator;
  /** Click on a byte, in either the hex grid or the ASCII gutter. */
  onByteClick?: ByteMouseHandler;
  /** Mouse button pressed on a byte. */
  onByteMouseDown?: ByteMouseHandler;
  /** Pointer moved onto a byte (e.g. to extend a drag selection). */
  onByteMouseEnter?: ByteMouseHandler;
  /** Keys pressed while the grid has focus. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Copy while the grid has focus. */
  onCopy?: (event: ClipboardEvent<HTMLDivElement>) => void;
  /** Paste while the grid has focus. */
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  /** Sets `aria-readonly` on the grid. Default true; editors pass false. */
  readOnly?: boolean;
  className?: string;
  "aria-label"?: string;
  ref?: Ref<HexViewHandle>;
}

/** Viewport height assumed until the scroller can be measured (e.g. jsdom). */
const FALLBACK_VIEWPORT = 400;

export function HexView({
  data,
  baseAddress = 0,
  bytesPerRow = 16,
  groupSize = 8,
  addressDigits = MIN_ADDRESS_DIGITS,
  rowHeight = 20,
  height = "100%",
  overscan = 4,
  decorateByte,
  onByteClick,
  onByteMouseDown,
  onByteMouseEnter,
  onKeyDown,
  onCopy,
  onPaste,
  readOnly = true,
  className,
  "aria-label": ariaLabel = "Hex view",
  ref,
}: HexViewProps) {
  const perRow = Math.max(1, Math.floor(bytesPerRow));
  const rowCount = Math.ceil(data.length / perRow);
  const digits = addressDigitsFor(data.length, baseAddress, addressDigits);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollCap, setScrollCap] = useState(MAX_SCROLL_HEIGHT);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof height === "number"
      ? Math.max(height - rowHeight, 0)
      : FALLBACK_VIEWPORT,
  );

  // Track the scroller's real height. jsdom reports 0 and has no
  // ResizeObserver, so the initial estimate stands there.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const win = computeWindow({
    rowCount,
    rowHeight,
    viewportHeight,
    scrollTop,
    overscan,
    maxScrollHeight: scrollCap,
  });

  // If the engine clamped the spacer shorter than asked, the tail of the
  // buffer would be unreachable. Adopt the real limit so the scroll mapping
  // rescales to fit. (jsdom lays nothing out and reports 0.)
  const requestedHeight = win.scrollHeight;
  useLayoutEffect(() => {
    const actual = spacerRef.current?.offsetHeight ?? 0;
    if (actual > 0 && actual < requestedHeight - 1) {
      setScrollCap(Math.floor(actual * 0.95));
    }
  }, [requestedHeight]);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const scale = win.scale;
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index: number) {
        const el = scrollerRef.current;
        if (!el || rowCount === 0) return;
        const clamped = Math.min(Math.max(Math.floor(index), 0), data.length - 1);
        const top = scrollTopForRow(Math.floor(clamped / perRow), {
          rowHeight,
          scale,
        });
        el.scrollTop = top;
        setScrollTop(top);
      },
      revealIndex(index: number) {
        const el = scrollerRef.current;
        if (!el || rowCount === 0) return;
        const clamped = Math.min(Math.max(Math.floor(index), 0), data.length - 1);
        const top = scrollTopToReveal(Math.floor(clamped / perRow), {
          rowHeight,
          viewportHeight,
          scrollTop: el.scrollTop,
          scale,
        });
        if (top === null) return;
        el.scrollTop = top;
        setScrollTop(top);
      },
      pageRows() {
        return Math.max(1, Math.floor(viewportHeight / rowHeight));
      },
      focus() {
        scrollerRef.current?.focus();
      },
    }),
    [data.length, perRow, rowCount, rowHeight, scale, viewportHeight],
  );

  const onClick = useMemo(() => byteDelegate(onByteClick), [onByteClick]);
  const onMouseDown = useMemo(() => byteDelegate(onByteMouseDown), [onByteMouseDown]);
  const onMouseOver = useMemo(() => byteDelegate(onByteMouseEnter), [onByteMouseEnter]);

  const rows = [];
  for (let r = win.startRow; r < win.endRow; r++) {
    rows.push(
      <HexRow
        key={r}
        row={r}
        data={data}
        perRow={perRow}
        groupSize={groupSize}
        baseAddress={baseAddress}
        digits={digits}
        decorateByte={decorateByte}
      />,
    );
  }

  const rootStyle = {
    height,
    "--hv-row-height": `${rowHeight}px`,
    "--hv-address-width": `${digits}ch`,
  } as CSSProperties;

  return (
    <div
      className={className ? `hexview ${className}` : "hexview"}
      style={rootStyle}
    >
      <div className="hv-header" aria-hidden="true">
        <span className="hv-address">Offset</span>
        <span className="hv-hex">
          {Array.from({ length: perRow }, (_, col) => (
            <span key={col} className={cellClass("hv-byte", col, groupSize)}>
              {byteToHex(col)}
            </span>
          ))}
        </span>
        <span className="hv-ascii">ASCII</span>
      </div>
      <div
        ref={scrollerRef}
        className="hv-scroller"
        role="grid"
        aria-label={ariaLabel}
        aria-rowcount={rowCount}
        aria-colcount={3}
        aria-readonly={readOnly}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
      >
        {rowCount === 0 ? (
          <div className="hv-empty-state">No data</div>
        ) : (
          <div
            ref={spacerRef}
            className="hv-spacer"
            style={{ height: win.scrollHeight }}
          >
            <div
              className="hv-window"
              style={{ transform: `translateY(${win.top}px)` }}
              onClick={onClick}
              onMouseDown={onMouseDown}
              onMouseOver={onMouseOver}
            >
              {rows}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface HexRowProps {
  row: number;
  data: Uint8Array;
  perRow: number;
  groupSize: number;
  baseAddress: number;
  digits: number;
  decorateByte?: ByteDecorator;
}

const HexRow = memo(function HexRow({
  row,
  data,
  perRow,
  groupSize,
  baseAddress,
  digits,
  decorateByte,
}: HexRowProps) {
  const start = row * perRow;
  const hex = [];
  const ascii = [];
  for (let col = 0; col < perRow; col++) {
    const index = start + col;
    if (index >= data.length) {
      hex.push(
        <span key={col} className={cellClass("hv-byte hv-pad", col, groupSize)} />,
      );
      continue;
    }
    const value = data[index];
    const deco = decorateByte?.(index, value);
    const extra = deco?.className ? ` ${deco.className}` : "";
    hex.push(
      <span
        key={col}
        className={cellClass(`hv-byte${extra}`, col, groupSize)}
        style={deco?.style}
        title={deco?.title}
        aria-label={deco?.label}
        data-index={index}
      >
        {byteToHex(value)}
      </span>,
    );
    ascii.push(
      <span
        key={col}
        className={`hv-char${extra}`}
        style={deco?.style}
        title={deco?.title}
        aria-label={deco?.label}
        data-index={index}
      >
        {byteToAscii(value)}
      </span>,
    );
  }

  return (
    <div className="hv-row" role="row" aria-rowindex={row + 1}>
      <span className="hv-address" role="rowheader">
        {formatAddress(baseAddress + start, digits)}
      </span>
      <span className="hv-hex" role="gridcell">
        {hex}
      </span>
      <span className="hv-ascii" role="gridcell">
        {ascii}
      </span>
    </div>
  );
});

/** Event delegation: find the byte cell under the pointer and report it. */
function byteDelegate(handler: ByteMouseHandler | undefined) {
  if (!handler) return undefined;
  return (e: MouseEvent<HTMLElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!cell?.dataset.index) return;
    const pane: HexPane = cell.classList.contains("hv-char") ? "ascii" : "hex";
    handler(Number(cell.dataset.index), e, pane);
  };
}

function cellClass(base: string, col: number, groupSize: number): string {
  return groupSize > 0 && col > 0 && col % groupSize === 0
    ? `${base} hv-group-start`
    : base;
}
