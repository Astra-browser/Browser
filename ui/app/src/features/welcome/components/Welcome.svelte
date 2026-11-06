<script lang="ts">
  import { onMount } from "svelte";
  import Button from "$shared/ui/Button";
  import SegmentedControl from "$shared/ui/SegmentedControl";
  import {
    THEMES,
    isFirstRun,
    persistWelcome,
    readTheme,
    type ThemeChoice,
    type WelcomeResult,
  } from "../lib/first-run";
  import { neighbour, position, type WelcomeStep } from "../lib/steps";

  const themeOptions = THEMES.map((value) => ({
    value,
    label: value === "system" ? "System" : value === "light" ? "Light" : "Dark",
  }));

  let { onfinish }: { onfinish?: (result: WelcomeResult) => Promise<void> | void } = $props();

  let step = $state<WelcomeStep>("welcome");
  let profileName = $state("");
  let theme = $state<ThemeChoice>("system");
  let finishing = $state(false);
  let notice = $state<string | null>(null);

  const place = $derived(position(step));
  const profileOk = $derived(profileName.trim().length > 0);
  const primary = $derived(
    step === "welcome" ? "Get started" : step === "done" ? "Start browsing" : "Continue",
  );
  const primaryDisabled = $derived(step === "profile" && !profileOk);

  // The choice is shown as it will look: the theme applies live.
  $effect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  });

  onMount(() => {
    void (async () => {
      theme = await readTheme();
      // A finished run lands on the end, where starting again is one press.
      if (!(await isFirstRun())) step = "done";
    })();
  });

  function advance() {
    if (finishing) return;
    if (step === "profile" && !profileOk) return;
    if (step === "done") {
      void finish();
      return;
    }
    const next = neighbour(step, 1);
    if (next) step = next;
  }

  function back() {
    if (finishing) return;
    const prev = neighbour(step, -1);
    if (prev) step = prev;
  }

  async function finish() {
    if (finishing) return;
    finishing = true;
    notice = null;
    try {
      await persistWelcome(theme);
      await onfinish?.({ profileName: profileName.trim(), theme });
    } catch {
      notice = "Astra could not save your choices. Try again.";
      finishing = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.repeat || event.isComposing) return;
    if ((event.target as HTMLElement | null)?.closest("button, a, input")) return;
    event.preventDefault();
    advance();
  }
</script>

<svelte:window onkeydown={keydown} />

<div
  class="welcome-flow"
  role="dialog"
  aria-modal="true"
  aria-label="Welcome to Astra"
  data-step={step}
>
  <div class="card">
    {#if step === "welcome"}
      <p class="eyebrow">Astra</p>
      <h1>Welcome to Astra</h1>
      <p class="body">
        A calm browser for your work, notes, and time. A few choices, then you are in.
      </p>
    {:else if step === "profile"}
      <p class="eyebrow">Step {place.at} of {place.of}</p>
      <h1>What should Astra call you?</h1>
      <p class="body">This names your profile in Astra.</p>
      <label class="field">
        <span>Name</span>
        <input
          type="text"
          autocomplete="off"
          maxlength={64}
          placeholder="Ada"
          bind:value={profileName}
          aria-describedby="profile-hint"
        />
      </label>
      <p class="hint" id="profile-hint">Choose anything; you can change it later.</p>
    {:else if step === "theme"}
      <p class="eyebrow">Step {place.at} of {place.of}</p>
      <h1>How should Astra look?</h1>
      <p class="body">Pick an appearance. Astra follows the system by default.</p>
      <SegmentedControl label="Appearance" options={themeOptions} bind:value={theme} />
    {:else if step === "import"}
      <p class="eyebrow">Step {place.at} of {place.of}</p>
      <h1>Bring your browsing with you</h1>
      <p class="body">Import from another browser is coming soon to Astra.</p>
      <!-- Stubbed until P4: rendered disabled with its reason, never a dead button. -->
      <div class="stub" aria-describedby="import-soon">
        <Button variant="secondary" size="large" disabled>Import from another browser</Button>
        <p class="badge" id="import-soon">Coming soon</p>
      </div>
    {:else}
      <p class="eyebrow">Astra</p>
      <h1>You are all set{profileOk ? `, ${profileName.trim()}` : ""}</h1>
      <p class="body">Astra opens on a new tab, ready to browse.</p>
    {/if}

    {#if notice}<p class="notice" role="status">{notice}</p>{/if}

    <nav class="bar" aria-label="Welcome to Astra">
      <span class="side">
        {#if neighbour(step, -1)}
          <Button variant="ghost" size="large" onclick={back}>Back</Button>
        {/if}
      </span>
      <ol class="dots" aria-label={`Step ${place.at} of ${place.of}`}>
        {#each [1, 2, 3, 4] as dot (dot)}
          <li data-state={dot < place.at ? "done" : dot === place.at ? "now" : ""}></li>
        {/each}
      </ol>
      <span class="side end">
        {#if step === "done"}
          <Button variant="primary" size="large" onclick={finish} pending={finishing}
            >{primary}</Button
          >
        {:else}
          <Button variant="primary" size="large" onclick={advance} disabled={primaryDisabled}
            >{primary}</Button
          >
        {/if}
      </span>
    </nav>
  </div>
</div>

<style>
  .welcome-flow {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: auto;
    background: var(--color-page);
    color: var(--color-text);
    font-family: var(--font-sans);
  }

  .card {
    display: grid;
    justify-items: center;
    gap: 12px;
    max-inline-size: 30rem;
    padding: 48px 40px 32px;
    text-align: center;
  }

  .eyebrow {
    margin: 0;
    color: var(--color-faint);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 400;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }

  .body {
    margin: 0 0 8px;
    color: var(--color-muted);
    font-size: 15px;
    line-height: 1.5;
    text-wrap: balance;
  }

  .field {
    display: grid;
    gap: 6px;
    inline-size: min(20rem, 100%);
    margin-block-start: 8px;
    text-align: start;
  }

  .field span {
    font-size: 13px;
    font-weight: 600;
  }

  .field input {
    padding: 10px 12px;
    border: 1px solid var(--color-border, currentColor);
    border-radius: var(--radius-control);
    background: var(--color-fill);
    color: var(--color-text);
    font: inherit;
  }

  .hint {
    margin: 0;
    color: var(--color-faint);
    font-size: 12.5px;
  }

  .stub {
    display: grid;
    justify-items: center;
    gap: 10px;
    margin-block-start: 8px;
  }

  .badge {
    margin: 0;
    padding: 3px 10px;
    border-radius: var(--radius-capsule, 999px);
    background: var(--color-fill);
    color: var(--color-muted);
    font-size: 12.5px;
    font-weight: 600;
  }

  .notice {
    margin: 0;
    color: var(--color-danger);
    font-size: 13px;
  }

  .bar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    inline-size: 100%;
    margin-block-start: 20px;
  }

  .side {
    display: flex;
  }

  .side.end {
    justify-content: flex-end;
  }

  .dots {
    display: flex;
    gap: 5px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .dots li {
    inline-size: 18px;
    block-size: 3px;
    border-radius: var(--radius-capsule, 999px);
    background: var(--color-fill-strong);
  }

  .dots li[data-state="done"] {
    background: var(--color-faint);
  }

  .dots li[data-state="now"] {
    inline-size: 34px;
    background: var(--color-text);
  }
</style>
