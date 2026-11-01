// P0-T07 golden seed data: deterministic tabs/spaces/profiles/favicons.
// Brand-neutral fixture sites (example.com); no real-world branding, so
// captures stay free of third-party marks and rebrand leakage is checkable.

export const SITES: Record<string, { title: string; fill: string }> = {
  atlas: { title: "Atlas — Team wiki", fill: "#4a154b" },
  beacon: { title: "Beacon Messenger", fill: "#2aa3df" },
  chorus: { title: "Chorus - Web Player: Music for everyone", fill: "#1ed760" },
  compass: { title: "compass search", fill: "#de5833" },
  ledger: { title: "Ledger - Sign in", fill: "#f5f5f5" },
  northwind: { title: "Northwind VPN plans and pricing", fill: "#6d4aff" },
  harbor: { title: "Harbor code hosting", fill: "#1f2328" },
};

export interface SeedTab {
  id: string;
  projection_revision: string;
  title: string;
  url: string;
  icon: { origin: string; revision: string } | null;
}

let projection = 100;

/** Monotonic fixed-width hex revisions, mirroring native's projection clock. */
export function nextRevision(): string {
  projection += 1;
  return projection.toString(16).padStart(32, "0");
}

export function seedTabs(keys: string[]): SeedTab[] {
  return keys.map((key, index) => ({
    id: key,
    projection_revision: nextRevision(),
    title: SITES[key]?.title ?? key,
    url: `https://${key}.example/`,
    loading: false,
    can_go_back: index > 0,
    can_go_forward: false,
    icon: { origin: `https://${key}.example`, revision: "a" },
  }));
}

/** 32px rounded favicon raster, the same fixed bytes native would deliver. */
export function raster(fill: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = canvas.getContext("2d")!;
  context.fillStyle = fill;
  context.beginPath();
  context.roundRect(0, 0, 32, 32, 8);
  context.fill();
  const { data } = context.getImageData(0, 0, 32, 32);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function faviconEntries(): Array<{ origin: string; revision: string; rgba: string }> {
  return Object.keys(SITES).map((key) => ({
    origin: `https://${key}.example`,
    revision: "a",
    rgba: raster(SITES[key]!.fill),
  }));
}

export interface SeedSpace {
  id: string;
  name: string;
  icon: null;
  color: number;
  theme: null;
  tabs: number;
  previews: Array<{ origin: string; revision: string }>;
}

export const SPACES: SeedSpace[] = [
  {
    id: "home",
    name: "Personal",
    icon: null,
    color: 1,
    theme: null,
    tabs: 4,
    previews: [
      { origin: "https://harbor.example", revision: "a" },
      { origin: "https://beacon.example", revision: "a" },
      { origin: "https://compass.example", revision: "a" },
    ],
  },
  {
    id: "work",
    name: "Studio",
    icon: null,
    color: 4,
    theme: null,
    tabs: 6,
    previews: [
      { origin: "https://ledger.example", revision: "a" },
      { origin: "https://harbor.example", revision: "a" },
      { origin: "https://compass.example", revision: "a" },
    ],
  },
  {
    id: "read",
    name: "Reading",
    icon: null,
    color: 6,
    theme: null,
    tabs: 2,
    previews: [
      { origin: "https://beacon.example", revision: "a" },
      { origin: "https://compass.example", revision: "a" },
    ],
  },
];
