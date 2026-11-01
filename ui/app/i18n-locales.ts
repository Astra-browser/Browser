import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Plugin } from "vite";

/**
 * Paraglide compiles English only, so no screen carries every language. Each
 * message is rewritten to read the loaded translation first, by its index in
 * `messages/en.json`; a language's dictionary is a lazy chunk of strings in
 * that order (see `$shared/lib/locale.svelte`).
 */
export function i18nLocales(): Plugin {
  const keys = (): string[] =>
    Object.keys(JSON.parse(readFileSync(new URL("./messages/en.json", import.meta.url), "utf8")));
  let index: Map<string, number> | null = null;
  const indexOf = (key: string) => {
    index ??= new Map(keys().map((name, at) => [name, at]));
    return index.get(key);
  };
  return {
    name: "astra-i18n-locales",
    enforce: "pre",
    buildStart() {
      index = null;
    },
    resolveId(source) {
      if (!source.endsWith(".json?dictionary")) return null;
      return `\0dictionary:${basename(source.slice(0, -".json?dictionary".length))}`;
    },
    load(id) {
      if (!id.startsWith("\0dictionary:")) return null;
      const locale = id.slice("\0dictionary:".length);
      const file = new URL(`./messages/${locale}.json`, import.meta.url);
      this.addWatchFile(file.pathname);
      const strings: Record<string, string> = JSON.parse(readFileSync(file, "utf8"));
      return `export default ${JSON.stringify(keys().map((key) => strings[key] ?? null))};`;
    },
    transform(code, id) {
      const key = /[\\/]src[\\/]shared[\\/]i18n[\\/]messages[\\/](\w+)\.js$/u.exec(id)?.[1];
      const at = key === undefined ? undefined : indexOf(key);
      if (key === undefined || at === undefined) return null;
      // Paraglide ≤2.25 shape: `return en_<key>(inputs)`.
      const legacy = `return en_${key}(inputs)`;
      // Paraglide ≥2.26 shape: `return /** @type {LocalizedString} */ (…)` with
      // the message inputs as the arrow's first parameter (usually `inputs`,
      // sometimes `i` — read the actual name so the lookup compiles). The
      // JSDoc type cast also contains a `((name …` prefix, so anchor on the
      // real signature: name followed by `,`/`=` then `options`.
      const param = /\(\((\w+)(?:\s*=[^,)]*)?,\s*options/u.exec(code)?.[1];
      if (param === undefined) return null;
      const current = `return /** @type {LocalizedString} */ (`;
      let next = code;
      if (next.includes(legacy)) {
        next = next.replace(legacy, `return translated(${at}, inputs) ?? en_${key}(inputs)`);
      } else if (next.includes(current)) {
        next = next.replace(
          current,
          `return translated(${at}, ${param}) ?? /** @type {LocalizedString} */ (`,
        );
      } else {
        return null;
      }
      return {
        code: `import { translated } from "$shared/lib/translations";\n` + next,
        map: null,
      };
    },
  };
}
