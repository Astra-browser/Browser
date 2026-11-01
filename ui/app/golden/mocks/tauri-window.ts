// P0-T07 golden mock for `@tauri-apps/api/window`.
// Golden pages run as plain web documents; there is no native window. The
// main entry gates on `getCurrentWindow().label === "main"`, and chrome
// helpers (close service, fullscreen) attach listeners that never fire here.

function noop(): void {}

const windowMock = {
  label: "main",
  isMaximized: async () => false,
  isMinimized: async () => false,
  isFocused: async () => true,
  minimize: async () => {},
  toggleMaximize: async () => {},
  close: async () => {},
  show: async () => {},
  hide: async () => {},
  setFocus: async () => {},
  onResized: async () => () => {},
  onFocusChanged: async () => () => {},
  onCloseRequested: async () => () => {},
  listen: async () => () => {},
  once: async () => () => {},
  emit: async () => {},
} satisfies Record<string, unknown>;

export function getCurrentWindow(): unknown {
  return windowMock;
}

// Anything else a component reaches for degrades to a silent no-op window.
export function getAllWindows(): unknown[] {
  return [windowMock];
}

export class Window {
  label = "main";
  async listen(): Promise<() => void> {
    noop();
    return () => {};
  }
  async emit(): Promise<void> {}
}
