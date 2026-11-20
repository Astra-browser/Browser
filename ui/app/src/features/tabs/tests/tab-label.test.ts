import { expect, test } from "vitest";
import { tabLabel } from "../lib/tab-label";

const untitled = "Untitled tab";

test("a committed title is the row's name", () => {
  expect(tabLabel({ title: "Wikipedia", url: "https://www.wikipedia.org/" }, untitled)).toBe(
    "Wikipedia",
  );
});

test("a loading tab with no title names the host it is loading", () => {
  expect(tabLabel({ title: "", url: "https://www.example.com/a/b?c=1" }, untitled)).toBe(
    "example.com",
  );
});

test("a tab with neither a title nor a web address still says what it is", () => {
  expect(tabLabel({ title: "", url: "about:blank" }, untitled)).toBe(untitled);
  expect(tabLabel({ title: "", url: null }, untitled)).toBe(untitled);
  expect(tabLabel({ title: "", url: "not a url" }, untitled)).toBe(untitled);
  expect(tabLabel({ title: "", url: "file:///C:/page.html" }, untitled)).toBe(untitled);
});
