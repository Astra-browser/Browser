import * as m from "$shared/i18n/messages";
import { IS_MAC } from "$shared/platform";

export const WEBSITE = "https://astra.example";

export const links = [
  { id: "website", url: WEBSITE, label: () => m.about_link_website() },
  // Without a menu bar there is no Help menu, so the documentation it leads
  // to is named Help here, where Windows and Linux look for it.
  {
    id: "docs",
    url: `${WEBSITE}/docs`,
    label: () => (IS_MAC ? m.about_link_docs() : m.native_help()),
  },
  { id: "github", url: "https://github.com/astra-browser/Astra", label: () => "GitHub" },
  { id: "discord", url: "https://example.com/community", label: () => "Discord" },
  { id: "youtube", url: "https://example.com/video", label: () => "YouTube" },
] as const;
