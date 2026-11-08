/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-time product flag: the Work environment. Off unless `"true"`. */
  readonly VITE_ASTRA_WORK?: string;
}

// P2-T08: Firefox chrome modules (`overlay/astra/host/*.sys.mjs`) resolve
// only in the chrome document at runtime (cf. ui/shell/src/host.js). The
// `/* @vite-ignore */` dynamic import keeps the specifier out of the bundle;
// this declaration keeps the typechecker quiet outside the browser.
declare module "resource://*" {
  const module: unknown;
  export default module;
}
