import { memo, useMemo, useState } from "react";
import { formatCount, formatOffset } from "../../lib/device/format";
import {
  MIN_STRING_CHARS,
  filterStrings,
  formatStringCount,
  leftOut,
} from "../../lib/device/strings";
import type { InspectStrings } from "../../lib/engine";

/**
 * How many strings are drawn. A dump has thousands; the filter is how
 * anyone gets at the rest, and the line under the list says so.
 */
export const STRINGS_ROW_LIMIT = 500;

export interface StringsListProps {
  strings: InspectStrings;
  /**
   * Say how many there are and draw none of them: the window is on a live
   * stream, and text out of a chip can be a Wi-Fi key or a password.
   */
  covered: boolean;
  /** Put the hex editor's cursor on this offset. */
  onJump: (offset: number) => void;
}

/**
 * The text in the buffer: every run of printable characters, with where it
 * starts. A row puts the hex editor's cursor on its first byte; the filter
 * narrows the list to the strings with some text in them.
 */
export const StringsList = memo(function StringsList({
  strings,
  covered,
  onJump,
}: StringsListProps) {
  const [query, setQuery] = useState("");
  const { found } = strings;
  const matching = useMemo(() => filterStrings(found, query), [found, query]);
  const rows =
    matching.length > STRINGS_ROW_LIMIT ? matching.slice(0, STRINGS_ROW_LIMIT) : matching;
  const note = leftOut(strings);
  const count = formatStringCount(found.length);

  if (found.length === 0) {
    return (
      <div className="strings">
        <h3>Strings</h3>
        <p className="hint" role="status">
          No text of {MIN_STRING_CHARS} characters or more in these bytes.
        </p>
      </div>
    );
  }

  if (covered) {
    return (
      <div className="strings">
        <h3>Strings</h3>
        <p className="hint" role="status">
          {count}, covered while &ldquo;Hide file paths in this
          window&rdquo; is on. Text out of a chip can be a Wi-Fi key or a password, and
          nothing here can tell which.
        </p>
      </div>
    );
  }

  return (
    <div className="strings">
      <div className="strings-bar">
        <h3>Strings</h3>
        <input
          type="search"
          className="strings-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter"
          aria-label="Filter strings"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
      <p className="hint" role="status">
        {query === ""
          ? `${count}. Pick one to go to it in the buffer.`
          : `${formatCount(matching.length)} of ${count} with “${query}” in ${
              matching.length === 1 ? "it" : "them"
            }.`}
      </p>
      {note && <p className="hint">{note}</p>}
      {rows.length > 0 && (
        <div className="inspect-table strings-table">
          <table aria-label="Strings">
            <thead>
              <tr>
                <th scope="col">Offset</th>
                <th scope="col">Length</th>
                <th scope="col">Text</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((text) => {
                const more = text.chars > text.text.length;
                return (
                  <tr
                    // An ASCII string and a UTF-16 one can start on the same
                    // byte.
                    key={`${text.offset}:${text.encoding}`}
                    className="inspect-row"
                    onClick={() => onJump(text.offset)}
                  >
                    <td>
                      {/* The row's click does the work: this is what a
                          keyboard lands on. */}
                      <button
                        type="button"
                        className="inspect-offset"
                        aria-label={`Go to ${formatOffset(text.offset)}, ${text.text}`}
                      >
                        {formatOffset(text.offset)}
                      </button>
                    </td>
                    <td>{formatCount(text.chars)}</td>
                    <td className="strings-text">
                      {text.encoding === "utf16le" && (
                        <span
                          className="strings-wide"
                          title="Two bytes a character, the low one first"
                        >
                          UTF-16
                        </span>
                      )}
                      <code>{text.text}</code>
                      {more && (
                        <span
                          className="strings-more"
                          title={`The first ${formatCount(text.text.length)} of ${formatCount(
                            text.chars,
                          )} characters`}
                        >
                          …
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {matching.length > rows.length && (
        <p className="hint">
          Showing the first {formatCount(rows.length)} of {formatCount(matching.length)}.{" "}
          {query === "" ? "Filter to get at the rest." : "A longer filter narrows it down."}
        </p>
      )}
    </div>
  );
});
