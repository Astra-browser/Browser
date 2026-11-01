import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "$styles/global.css";
import OmniboxSuggestions from "../components/OmniboxSuggestions.svelte";
import type { OmniboxSuggestion } from "../lib/omnibox-model";

const rows = (): OmniboxSuggestion[] => [
  {
    id: "tabs:t1",
    source: "tabs",
    title: "Rust documentation",
    detail: "doc.rust-lang.org",
    url: "https://doc.rust-lang.org/",
    score: 3,
    engine: null,
  },
  {
    id: "history:h1",
    source: "history",
    title: "Rust borrow checker guide",
    detail: "doc.rust-lang.org",
    url: "https://doc.rust-lang.org/borrow",
    score: 2,
    engine: null,
  },
  {
    id: "search:duckduckgo:rust",
    source: "search",
    title: "rust",
    detail: "DuckDuckGo",
    url: "https://duckduckgo.com/?q=rust",
    score: Number.MIN_SAFE_INTEGER,
    engine: null,
  },
];

test("lists suggestions in order with the query as the search title", async () => {
  const onselect = vi.fn();
  const onhover = vi.fn();
  await render(OmniboxSuggestions, {
    suggestions: rows(),
    selection: 0,
    query: "rust",
    onselect,
    onhover,
  });

  const listbox = page.getByRole("listbox", { name: "Address bar suggestions" });
  await expect.element(listbox).toBeVisible();
  const options = listbox.getByRole("option");
  await expect.element(options).toHaveLength(3);
  await expect.element(options.nth(0)).toHaveTextContent("Rust documentation");
  await expect.element(options.nth(2)).toHaveTextContent("rust");
  await expect.element(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect.element(options.nth(1)).toHaveAttribute("aria-selected", "false");
});

test("clicking a row selects it by id", async () => {
  const onselect = vi.fn();
  await render(OmniboxSuggestions, {
    suggestions: rows(),
    selection: -1,
    query: "rust",
    onselect,
    onhover: vi.fn(),
  });

  await page.getByRole("option").nth(1).click();
  expect(onselect).toHaveBeenCalledWith("history:h1");
});

test("renders nothing without suggestions", async () => {
  await render(OmniboxSuggestions, {
    suggestions: [],
    selection: -1,
    query: "rust",
    onselect: vi.fn(),
    onhover: vi.fn(),
  });
  await expect
    .element(page.getByRole("listbox", { name: "Address bar suggestions" }))
    .not.toBeInTheDocument();
});
