// P0-T07 golden capture runner (Bun).
// Serves tools/golden-capture/dist (the mocked golden UI build), walks the
// manifest matrix with headless Chromium, and writes PNGs to
// tests/golden/baseline/ plus the run metadata for MANIFEST.md.
//
// Determinism: fixed viewport/deviceScaleFactor, pinned clock + timezone +
// locale, reduced motion, disabled screenshot animations, fonts.ready gate.
// Exits non-zero on any missing ready flag, page error, or `[golden]
// unmocked` console error (a missing mock fixture must fail loudly).
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { MATRIX, PINNED_ISO } from "./manifest";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..", "..");
const DIST = join(HERE, "dist");
const BASELINE = join(ROOT, "tests", "golden", "baseline");
const PORT = 1421;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

async function ensureDist(): Promise<void> {
  if (await Bun.file(join(DIST, "golden.html")).exists()) return;
  console.log("[golden] dist missing, building golden UI…");
  const proc = Bun.spawn(
    ["bunx", "vite", "build", "--config", "vite.golden.config.ts"],
    { cwd: join(ROOT, "ui", "app"), stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error("golden UI build failed");
}

function serve(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      let path = decodeURIComponent(url.pathname);
      if (path === "/") path = "/golden.html";
      const file = Bun.file(join(DIST, path));
      if (!(await file.exists()))
        return new Response("not found", { status: 404 });
      return new Response(file, {
        headers: { "content-type": contentType(path) },
      });
    },
  });
}

interface CaptureResult {
  name: string;
  bytes: number;
}

async function captureOne(
  browser: Browser,
  base: string,
  entry: (typeof MATRIX)[number],
): Promise<CaptureResult> {
  const context = await browser.newContext({
    viewport: { width: entry.width, height: entry.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    colorScheme: entry.theme,
  });
  // Pin the wall clock before any page script runs (matches the benches'
  // Monday 2026-09-28 14:32; UTC keeps it machine-independent).
  await context.addInitScript(
    `(${(() => {
      const frozen = Date.parse(PINNED_ISO);
      const RealDate = Date;
      class FrozenDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(frozen);
          // @ts-expect-error passthrough
          else super(...args);
        }
        static now() {
          return frozen;
        }
      }
      // @ts-expect-error clock pin
      globalThis.Date = FrozenDate;
    }).toString()})()`.replace("PINNED_ISO", JSON.stringify(PINNED_ISO)),
  );
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error")
      problems.push(`console.error: ${message.text()}`);
  });
  const url = `${base}/golden.html?screen=${entry.screen}&theme=${entry.theme}`;
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.golden === "ready",
    undefined,
    { timeout: 90000, polling: 250 },
  );
  if (
    (await page.evaluate(() => document.documentElement.dataset.golden)) !==
    "ready"
  ) {
    problems.push("ready flag missing");
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const out = join(BASELINE, `${entry.name}.png`);
  await page.screenshot({ path: out, animations: "disabled", caret: "hide" });
  const bytes = (await Bun.file(out).exists()) ? Bun.file(out).size : 0;
  const unmocked = problems.filter((entry) =>
    entry.includes("[golden] unmocked"),
  );
  await context.close();
  if (problems.length > 0) {
    throw new Error(`${entry.name}: ${problems.join(" | ").slice(0, 2000)}`);
  }
  if (unmocked.length > 0)
    throw new Error(`${entry.name}: unmocked invokes: ${unmocked.join()}`);
  return { name: entry.name, bytes };
}

async function main(): Promise<void> {
  await ensureDist();
  await Bun.$`mkdir -p ${BASELINE}`;
  const server = serve();
  const browser = await chromium.launch({
    args: ["--font-render-hinting=none"],
  });
  const base = `http://127.0.0.1:${(server as { port: number }).port ?? PORT}`;
  const results: CaptureResult[] = [];
  try {
    for (const entry of MATRIX) {
      process.stdout.write(
        `[golden] ${entry.name} (${entry.width}x${entry.height})… `,
      );
      const result = await captureOne(browser, base, entry);
      results.push(result);
      console.log(`${(result.bytes / 1024).toFixed(0)} KiB`);
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  const meta = {
    tool: "tools/golden-capture",
    chromium: (await chromium.launch().then(async (b) => {
      const version = b.version();
      await b.close();
      return version;
    })) as string,
    viewport: "1440x900 desktop + 390x844 narrow (shell)",
    themes: ["light", "dark"],
    pinnedClock: PINNED_ISO,
    timezone: "UTC",
    locale: "en-US",
    deviceScaleFactor: 1,
    captures: results,
  };
  await Bun.file(join(HERE, ".last-run.json")).write(
    JSON.stringify(meta, null, 2),
  );
  console.log(
    `[golden] ${results.length}/${MATRIX.length} captures → tests/golden/baseline/`,
  );
}

main().catch((error) => {
  console.error(
    `[golden] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
