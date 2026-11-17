import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ChipInfo, Programmer } from "../../lib/engine";
import {
  availabilityWarning,
  memoryDescription,
  memorySummary,
  programmerLabel,
  socketDescription,
} from "../../lib/device/chip";
import { formatByteCount, formatCount, joinList } from "../../lib/device/format";
import {
  lookupKey,
  type ChipLookup,
  type ChipRef,
  type ChipState,
  type RecentChip,
} from "../../lib/device/state";

export interface ChipPickerProps {
  chip: ChipState;
  /** Whose list is being searched. */
  programmer: Programmer;
  /** The recent chips that are in that list. */
  recent: RecentChip[];
  /** An operation is running: the chip can't change under it. */
  busy: boolean;
  onQuery: (query: string) => void;
  onSelect: (chip: ChipRef) => void;
  onClear: () => void;
}

function sizeText(lookup: ChipLookup | undefined): string {
  if (!lookup) return "";
  if (lookup.status === "loading") return "…";
  if (lookup.status === "error") return "no details";
  return memorySummary(lookup.info);
}

/**
 * Type-ahead search over the programmer's chip list, the recent chips, and
 * the details of the chip that's picked. The list itself has no sizes; each
 * result's size arrives a moment after the result does.
 */
export const ChipPicker = memo(function ChipPicker({
  chip,
  programmer,
  recent,
  busy,
  onQuery,
  onSelect,
  onClear,
}: ChipPickerProps) {
  const inputId = useId();
  const listId = useId();
  const statusId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const { query, search, selected, lookups } = chip;
  const results = search.results;
  const open = query.trim() !== "" && search.status === "ready" && results.length > 0;

  // The highlighted result. New results start again from the first.
  const [active, setActive] = useState(0);
  const [seenResults, setSeenResults] = useState(results);
  if (seenResults !== results) {
    setSeenResults(results);
    setActive(0);
  }

  useEffect(() => {
    const option = listRef.current?.children[active];
    if (option instanceof HTMLElement) option.scrollIntoView?.({ block: "nearest" });
  }, [active, results]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      onQuery("");
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((active + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((active + results.length - 1) % results.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(results.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = results[active];
      if (picked) onSelect(picked);
    }
  }

  const list = programmerLabel(programmer);
  let status = "";
  if (query.trim() !== "") {
    if (search.status === "loading") status = "Searching…";
    else if (search.status === "error") status = `Search failed: ${search.error}`;
    else if (search.total === 0) status = `No chip in the ${list} list matches “${query.trim()}”.`;
    else if (search.total > results.length) {
      status = `Showing the first ${results.length} of ${formatCount(search.total)} matches. Keep typing to narrow it down.`;
    } else status = `${formatCount(search.total)} ${search.total === 1 ? "match" : "matches"}.`;
  }

  const selectedLookup = selected ? lookups[lookupKey(programmer, selected.name)] : undefined;

  return (
    <section className="panel chip" aria-label="Chip">
      <div className="panel-bar">
        <h2>Chip</h2>
      </div>

      <label htmlFor={inputId}>Search the {list} chip list</label>
      <input
        id={inputId}
        className="chip-search"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-describedby={statusId}
        value={query}
        disabled={busy}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Part number, e.g. W25Q32"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
      />
      <p
        id={statusId}
        role="status"
        className={search.status === "error" ? "chip-search-status notice-error" : "chip-search-status"}
      >
        {status}
      </p>
      {open && (
        <ul id={listId} ref={listRef} className="chip-results" role="listbox" aria-label="Matching chips">
          {results.map((entry, index) => (
            <li
              key={entry.name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "chip-result chip-result-active" : "chip-result"}
              // Keep the focus in the search box.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => onSelect(entry)}
            >
              <span className="chip-result-name">{entry.name}</span>
              <span className="chip-result-meta">
                {entry.custom && <span className="chip-tag">custom</span>}
                {entry.package && <span>{entry.package}</span>}
                <span className="chip-result-size">
                  {sizeText(lookups[lookupKey(programmer, entry.name)])}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {query.trim() === "" && recent.length > 0 && (
        <div className="chip-recent">
          <h3>Recent</h3>
          <ul>
            {recent.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="button-quiet"
                  disabled={busy}
                  aria-pressed={selected?.name === entry.name}
                  onClick={() => onSelect(entry)}
                >
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected ? (
        <div className="chip-details">
          <div className="panel-bar">
            <h3>{selected.name}</h3>
            <button type="button" className="button-quiet" onClick={onClear} disabled={busy}>
              Clear chip
            </button>
          </div>
          {(!selectedLookup || selectedLookup.status === "loading") && (
            <p className="hint">Loading details…</p>
          )}
          {selectedLookup?.status === "error" && (
            <p className="notice notice-error" role="alert">
              {selectedLookup.message}
            </p>
          )}
          {selectedLookup?.status === "ready" && (
            <ChipDetails info={selectedLookup.info} programmer={programmer} />
          )}
        </div>
      ) : (
        <p className="hint">No chip picked.</p>
      )}
    </section>
  );
});

function ChipDetails({ info, programmer }: { info: ChipInfo; programmer: Programmer }) {
  const socket = socketDescription(info);
  const warning = availabilityWarning(info, programmer);
  const dataSizes = info.memory?.data_sizes ?? [];
  return (
    <>
      <dl className="chip-facts">
        <div>
          <dt>Package</dt>
          <dd>{info.package ?? "Not in the name (usually the DIP part)"}</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {info.kind === "logic" || !info.memory
              ? "None: a logic IC"
              : memoryDescription(info.memory)}
          </dd>
        </div>
        {socket && (
          <div>
            <dt>Fits</dt>
            <dd>{socket}</dd>
          </div>
        )}
        {info.icsp && (
          <div>
            <dt>In-circuit</dt>
            <dd>Can be programmed in-circuit ({info.icsp} in Xgpro's files shows the wiring).</dd>
          </div>
        )}
        <div>
          <dt>Programmers</dt>
          <dd>
            {info.available_on.length > 0
              ? joinList(info.available_on.map(programmerLabel))
              : "minipro doesn't say"}
          </dd>
        </div>
        {info.details.map((detail) => (
          <div key={detail.label}>
            <dt>{detail.label}</dt>
            <dd>{detail.value}</dd>
          </div>
        ))}
      </dl>
      {warning && (
        <p className="notice notice-warning" role="alert">
          {warning}
        </p>
      )}
      {info.kind === "logic" && (
        <p className="notice">
          {info.name} is a logic IC. minipro can only test it: there is nothing to read,
          write or erase, and burnwright doesn't run logic tests yet.
        </p>
      )}
      {dataSizes.length > 0 && (
        <p className="hint">
          burnwright works on the main memory only for now. The{" "}
          {joinList(dataSizes.map(formatByteCount))} of data memory and any fuses aren't
          read or written.
        </p>
      )}
    </>
  );
}
