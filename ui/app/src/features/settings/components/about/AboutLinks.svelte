<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { commands } from "$shared/ipc/bindings";
  import Icon from "$shared/ui/Icon";
  import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
  import Briefcase01Icon from "@hugeicons/core-free-icons/Briefcase01Icon";
  import DiscordIcon from "@hugeicons/core-free-icons/DiscordIcon";
  import GitlabIcon from "@hugeicons/core-free-icons/GitlabIcon";
  import GlobeIcon from "@hugeicons/core-free-icons/GlobeIcon";
  import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
  import NewTwitterIcon from "@hugeicons/core-free-icons/NewTwitterIcon";
  import { IS_MAC } from "$shared/platform";
  import { links, type AboutLink } from "../../lib/links";

  const icons = {
    website: GlobeIcon,
    docs: IS_MAC ? BookOpen01Icon : HelpCircleIcon,
    portfolio: Briefcase01Icon,
    gitlab: GitlabIcon,
    discord: DiscordIcon,
    x: NewTwitterIcon,
  };

  // The link opens in a tab of Astra, never as a navigation of Settings.
  function open(event: MouseEvent, url: string) {
    event.preventDefault();
    void commands.browserOpenUrl(url, true).catch(() => {});
  }
</script>

{#snippet tile(link: AboutLink)}
  <span class="glyph"><Icon icon={icons[link.id]} size={21} strokeWidth={1.6} /></span>
  <span class="name">{link.label()}</span>
{/snippet}

<nav class="links" aria-label={m.about_links()}>
  {#each links as link (link.id)}
    {#if link.url}
      <a class="link" href={link.url} onclick={(event) => open(event, link.url!)}>
        {@render tile(link)}
      </a>
    {:else}
      <span class="link soon">
        {@render tile(link)}
        <span class="note">{m.about_link_soon()}</span>
      </span>
    {/if}
  {/each}
</nav>

<style>
  .links {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 10px;
    max-inline-size: 290px;
  }

  .link {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    inline-size: 84px;
    padding-block: 4px;
    color: var(--color-label-secondary);
    font-size: var(--text-label);
    text-decoration: none;
    outline: none;
    -webkit-user-drag: none;
  }

  .glyph {
    display: grid;
    place-items: center;
    inline-size: 52px;
    block-size: 52px;
    border-radius: var(--radius-control-large);
    background: var(--color-tile);
    color: var(--color-text);
    transition:
      background var(--motion-fast) var(--ease-out),
      scale var(--motion-slow) var(--ease-spring);
  }

  .note {
    color: var(--color-muted);
    font-size: var(--text-caption);
  }

  .link:hover {
    color: var(--color-text);
  }

  .link.soon {
    opacity: 0.6;
    pointer-events: none;
  }

  .link:hover .glyph {
    background: var(--color-tile-hover);
  }

  .link:active .glyph {
    scale: 0.94;
  }

  .link:focus-visible .glyph {
    box-shadow:
      0 0 0 2px var(--color-page),
      0 0 0 3.5px var(--color-ring);
  }

  @media (forced-colors: active) {
    .link:focus-visible .glyph {
      outline: 2px solid Highlight;
    }
  }
</style>
