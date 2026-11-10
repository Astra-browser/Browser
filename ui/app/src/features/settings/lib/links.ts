import * as m from "$shared/i18n/messages";
import { IS_MAC } from "$shared/platform";

/** The repository is Astra's website until a standalone site exists. */
export const WEBSITE = "https://gitlab.com/kyoiske/astra";

export type AboutLink = {
  readonly id: "website" | "docs" | "portfolio" | "gitlab" | "discord" | "x";
  /** Null while the page does not exist yet: the tile says it is coming soon. */
  readonly url: string | null;
  readonly label: () => string;
};

export const links: readonly AboutLink[] = [
  { id: "website", url: WEBSITE, label: () => m.about_link_website() },
  // Without a menu bar there is no Help menu, so the documentation it leads
  // to is named Help here, where Windows and Linux look for it. There is no
  // documentation page yet, so the tile says so instead of opening a dead link.
  {
    id: "docs",
    url: null,
    label: () => (IS_MAC ? m.about_link_docs() : m.native_help()),
  },
  { id: "portfolio", url: "https://kyoikse.uno/", label: () => "Portfolio" },
  { id: "gitlab", url: WEBSITE, label: () => "GitLab" },
  { id: "discord", url: "https://discord.com/users/778460273073848342", label: () => "Discord" },
  { id: "x", url: "https://x.com/RemY__San", label: () => "X" },
];
