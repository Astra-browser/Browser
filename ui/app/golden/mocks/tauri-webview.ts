// P0-T07 golden mock for `@tauri-apps/api/webview`.
// Only imported for types by the generated bindings; the class below keeps
// any runtime reach (target.listen/emit in bindings helpers) inert.

export class Webview {
  async listen(): Promise<() => void> {
    return () => {};
  }
  async once(): Promise<() => void> {
    return () => {};
  }
  async emit(): Promise<void> {}
}

export function getCurrentWebview(): Webview {
  return new Webview();
}
