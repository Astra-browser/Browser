// P1-T10: loads the Host API at runtime. The Svelte bundle is built by Vite,
// so the resource:// specifier must survive the build untouched
// (/* @vite-ignore */) and resolve only in the chrome document. Outside the
// browser (standalone preview) the import fails and callers degrade to a
// disabled bar instead of crashing.

let cached = null;

export async function loadHost() {
  if (cached) {
    return cached;
  }
  try {
    const api = await import(
      /* @vite-ignore */ "resource://astra/host/HostAPI.sys.mjs"
    );
    let Content = null;
    try {
      const contentMod = await import(
        /* @vite-ignore */ "resource://astra/host/Content.sys.mjs"
      );
      Content = contentMod.Content;
    } catch {
      Content = null;
    }
    cached = { ...api, Content };
  } catch {
    cached = null;
  }
  return cached;
}

export function newRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}
