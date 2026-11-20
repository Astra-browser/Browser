// Drafts and the other small things the chrome remembers live in this origin's
// storage, which every test file of the run shares; none may reach the next.
try {
  localStorage.clear();
} catch {
  // Storage blocked: nothing was kept.
}

/**
 * The generated bindings still call `@tauri-apps/api/core`'s `invoke`, which
 * reads `window.__TAURI_INTERNALS__.invoke`. There is no Tauri runtime in a
 * browser test, so a test that forgets to mock `$shared/ipc/bindings` used to
 * fail with "Cannot read properties of undefined (reading 'invoke')" (or
 * "undefined is not valid JSON" from the event bus) — a symptom that never
 * named the missing fixture. Install the internals the package expects and
 * answer with a named rejection, so the failure says what was not mocked.
 */
{
  const internals = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> };
  internals.__TAURI_INTERNALS__ ??= {
    invoke: (command: string) =>
      Promise.reject(
        new Error(
          `[astra] unmocked native command "${command}": mock $shared/ipc/bindings for this test`,
        ),
      ),
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
  };
}
