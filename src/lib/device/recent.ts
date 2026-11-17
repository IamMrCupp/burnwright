// Recent chips, kept between runs in the webview's localStorage.
import { PROGRAMMERS } from "../engine";
import { RECENT_LIMIT, type RecentChip } from "./state";

/** Where the recent chips are read from and written to. */
export interface RecentStore {
  load(): RecentChip[];
  save(recent: RecentChip[]): void;
}

const KEY = "burnwright.recentChips";

function isRecentChip(value: unknown): value is RecentChip {
  if (typeof value !== "object" || value === null) return false;
  const chip = value as Partial<RecentChip>;
  return (
    typeof chip.name === "string" &&
    chip.name !== "" &&
    (chip.package === null || typeof chip.package === "string") &&
    PROGRAMMERS.some((p) => p.id === chip.programmer)
  );
}

/**
 * A store over `storage` (the browser's `localStorage`). Anything in there
 * that isn't a list of chips is ignored, and a storage that throws (private
 * mode, a full disk) just means nothing is remembered.
 */
export function recentStore(storage: Pick<Storage, "getItem" | "setItem">): RecentStore {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isRecentChip).slice(0, RECENT_LIMIT);
      } catch {
        return [];
      }
    },
    save(recent) {
      try {
        storage.setItem(KEY, JSON.stringify(recent.slice(0, RECENT_LIMIT)));
      } catch {
        // Not worth interrupting anyone for.
      }
    },
  };
}
