// The strings list of the Inspect panel: which rows a filter leaves, and
// what the list says about itself when the scanner had to leave some out.
import type { InspectStrings, InspectText } from "../engine";
import { formatCount } from "./format";

/** The shortest string the scanner ever lists (`inspect::strings::MIN_CHARS`). */
export const MIN_STRING_CHARS = 4;

/**
 * The strings with `query` somewhere in them, whatever its case. An empty
 * query is every string, as the same array. Spaces count: " root" is a
 * different search from "root".
 */
export function filterStrings(found: InspectText[], query: string): InspectText[] {
  if (query === "") return found;
  const wanted = query.toLowerCase();
  return found.filter((text) => text.text.toLowerCase().includes(wanted));
}

/**
 * What was left out of the list, as a sentence or two, or `null` when the
 * list is every string in the dump. The scanner drops the shortest first:
 * a run of chance in compressed data is short more often than a real
 * string is.
 */
export function leftOut(strings: InspectStrings): string | null {
  const { min_chars, total, cut, found } = strings;
  const raised = min_chars > MIN_STRING_CHARS;
  if (!raised && !cut) return null;
  const all = `${formatCount(total)} strings in all, too many to list.`;
  const listed = formatCount(found.length);
  if (!raised) return `${all} The list stops at the first ${listed}.`;
  const dropped = `The ones shorter than ${min_chars} characters are left out`;
  return cut
    ? `${all} ${dropped}, and the list still stops at the first ${listed}.`
    : `${all} ${dropped}, which leaves ${listed}.`;
}

/** `1` → `"1 string"`, `1204` → `"1,204 strings"`. */
export function formatStringCount(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "string" : "strings"}`;
}
