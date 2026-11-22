import { useMemo } from "react";
import { pathMasker } from "./mask";

/**
 * `state` as a screen should draw it: untouched, or with every file path
 * hidden when `hide` is on. `skip` names top-level keys to leave alone.
 */
export function useMasked<T>(state: T, hide: boolean, skip?: readonly string[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (hide ? pathMasker.mask(state, skip) : state), [state, hide]);
}
