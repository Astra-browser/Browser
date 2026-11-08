import { CodeIcon, Globe02Icon, PuzzleIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import type { TabContentView } from "$shared/ipc/bindings";

/** What a tab wears while its site supplies no icon of its own. */
export function tabFallbackIcon(content: TabContentView | undefined) {
  if (content === "extensions" || content === "extension_owned") return PuzzleIcon;
  if (content === "settings") return Settings02Icon;
  return content === "source" ? CodeIcon : Globe02Icon;
}
