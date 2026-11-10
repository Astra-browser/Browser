#!/usr/bin/env node
// Media import contract: `media_import` answers the record the New Tab
// background picker stores, and serves only that profile's own blob.
//
//   - a picked PNG is admitted by its bytes, never its name
//   - a non-image, empty or oversized file is refused without a record
//   - the record is a `ResourceRecord` with a media asset and the SHA-256
//     digest the URL carries
//   - `astra-media://localhost/<profile>/<digest>` parses only an exact
//     profile and digest; traversal, a bad host and an unknown path are null
//   - a cancelled picker is `cancelled`; a missing engine is `unavailable`
//
// Usage: node tests/contract/media_import_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const {
  MediaImport,
  admitMedia,
  cleanName,
  parseMediaRequest,
  recordFor,
  sniffImage,
  __setMediaImportHooksForTests,
  __resetMediaImportForTests,
} = await import(path.join(HOST, "MediaImport.sys.mjs"));

const PROFILE = "01M3CTWDG20GFZPACD7905RSRJ";
// A 1x1 transparent PNG, valid enough for the byte sniff and dimension check.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
  "base64",
);
const DIGEST = createHash("sha256").update(PNG).digest("hex");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

__resetMediaImportForTests();

// --- admission -------------------------------------------------------------
const admitted = await admitMedia(PNG, "../shot.PNG");
check("a PNG is admitted", admitted.ok === true);
check("its MIME is sniffed", admitted.asset?.mime === "image/png");
check("its size is the byte length", admitted.asset?.bytes === PNG.length);
check("its dimensions are read from IHDR", admitted.asset?.width === 1 && admitted.asset?.height === 1);
check("its digest is SHA-256", admitted.asset?.digest === DIGEST);
check("its name loses directory separators", admitted.asset?.name === "..shot.PNG");
check("its origin is a picked file", admitted.asset?.origin?.kind === "imported");

const plain = await admitMedia(Buffer.from("plain bytes"), "notes.txt");
check("a plain file keeps the contract's file kind", plain.ok === true && plain.asset?.kind === "file");
check("and its MIME is the octet stream", plain.asset?.mime === "application/octet-stream");
const pdf = await admitMedia(Buffer.from("%PDF-1.7 minim"), "spec.pdf");
check("a PDF keeps the contract's pdf kind", pdf.ok === true && pdf.asset?.kind === "pdf");
check("and its MIME is PDF", pdf.asset?.mime === "application/pdf");
const empty = await admitMedia(new Uint8Array(), "empty.png");
check("an empty file is refused", empty.ok === false && empty.error === "invalid");
const truncated = await admitMedia(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x62, 0x72]),
  "bad.png",
);
check("a malformed image is refused", truncated.ok === false && truncated.error === "invalid");
const hugeImage = new Uint8Array(8 * 1024 * 1024 + 1);
hugeImage.set(PNG, 0);
const tooLarge = await admitMedia(hugeImage, "huge.png");
check("an oversized image is capacity", tooLarge.ok === false && tooLarge.error === "capacity");
check("a blank name becomes the contract's fallback", cleanName("") === "file");
check("a 64 KiB name is bounded", cleanName("a".repeat(65536)).length <= 255);

// --- the record ------------------------------------------------------------
const now = 1_760_000_000_000;
const record = recordFor(admitted.asset, now);
check("the record has the asset digest as its id", record.id === DIGEST);
check("the record is a media resource", record.draft.content.kind === "media");
check("the media asset is the admitted one", record.draft.content.asset.digest === DIGEST);
check("the record is pinned false", record.draft.pinned === false);
check("the record has no related resources", Array.isArray(record.draft.related) && record.draft.related.length === 0);
check("the timestamps are unix seconds", record.created_at === "1760000000");

// --- the served path -------------------------------------------------------
check(
  "a media URL names one profile and digest",
  JSON.stringify(parseMediaRequest(`/${PROFILE}/${DIGEST}`, "?w=1600")) ===
    JSON.stringify({ profile: PROFILE, digest: DIGEST, width: 1600 }),
);
check("a missing width is null", parseMediaRequest(`/${PROFILE}/${DIGEST}`, "").width === null);
check("a bad width is ignored", parseMediaRequest(`/${PROFILE}/${DIGEST}`, "?w=abc").width === null);
check(
  "a traversal path is rejected",
  parseMediaRequest(`/${PROFILE}/../../etc/passwd`, "") === null,
);
check(
  "an encoded traversal is rejected",
  parseMediaRequest(`/${PROFILE}/..%2F..%2Fetc%2Fpasswd`, "") === null,
);
check(
  "another profile's blob still needs a valid profile",
  parseMediaRequest("/not-a-profile/" + DIGEST, "") === null,
);
check(
  "a short digest is rejected",
  parseMediaRequest(`/${PROFILE}/${"a".repeat(63)}`, "") === null,
);
check("an extra path segment is rejected", parseMediaRequest(`/${PROFILE}/${DIGEST}/x`, "") === null);
check("the image sniff is pure and does not need chrome", sniffImage(PNG)?.mime === "image/png");

// --- the command -----------------------------------------------------------
let saved = null;
let picked = { name: "background.png", bytes: PNG };
__setMediaImportHooksForTests({
  pick: async () => picked,
  save: async (profile, digest, bytes) => {
    saved = { profile, digest, bytes };
    return true;
  },
});
const imported = await MediaImport.import({ expected_profile: PROFILE });
check("the command imports a picked image", imported.kind === "imported");
check("the command returns the same digest", imported.record?.draft.content.asset.digest === DIGEST);
check("the blob is stored under the asked profile", saved?.profile === PROFILE && saved?.digest === DIGEST);
check("the stored bytes are the picked bytes", saved?.bytes?.length === PNG.length);

picked = null;
check("a cancelled picker is cancelled", (await MediaImport.import({ expected_profile: PROFILE })).kind === "cancelled");

picked = {
  name: "bad.png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x62, 0x72]),
};
const refused = await MediaImport.import({ expected_profile: PROFILE });
check("a malformed image pick is refused", refused.kind === "refused" && refused.error === "invalid");

check(
  "a malformed profile is invalid before any picker opens",
  (await MediaImport.import({ expected_profile: "nope" })).error === "invalid",
);

picked = { name: "background.png", bytes: PNG };
__setMediaImportHooksForTests({
  pick: async () => picked,
  save: async () => false,
});
const unavailable = await MediaImport.import({ expected_profile: PROFILE });
check("a failed store is unavailable, not imported", unavailable.kind === "refused" && unavailable.error === "unavailable");

// The app's running-profile token is "default" (Tabs.sys.mjs PROFILE_ID), not
// a ULID. The New Tab picker passes that token, so a ULID-only check refused
// every real request before the picker opened ("Choose an image that Astra can
// open"). A private window still cannot store a background.
saved = null;
picked = { name: "background.png", bytes: PNG };
__setMediaImportHooksForTests({
  pick: async () => picked,
  save: async (profile, digest, bytes) => {
    saved = { profile, digest, bytes };
    return true;
  },
});
const defaultProfile = await MediaImport.import({ expected_profile: "default" });
check(
  "the app's default profile token imports",
  defaultProfile.kind === "imported" && saved?.profile === "default",
  JSON.stringify(defaultProfile),
);
const privateProfile = await MediaImport.import({ expected_profile: "incognito" });
check(
  "a private profile cannot store a background",
  privateProfile.kind === "refused" && privateProfile.error === "invalid",
  JSON.stringify(privateProfile),
);

__resetMediaImportForTests();
const noEngine = await MediaImport.import({ expected_profile: PROFILE });
check("no engine and no hook refuses honestly", noEngine.kind === "refused" && noEngine.error === "unavailable");

console.log(`\nmedia_import_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
