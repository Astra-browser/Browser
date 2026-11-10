import { expect, test } from "vitest";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import { Globe02Icon } from "@hugeicons/core-free-icons";
import FavIcon from "../FavIcon.svelte";

test("a sleeping page keeps its mark and wears the same zzz as the rail", async () => {
  const screen = await render(FavIcon, {
    image: null,
    fallback: Globe02Icon,
    sleeping: true,
  });
  const mark = screen.container.querySelector<HTMLElement>("[data-favicon]")!;
  expect(mark.hasAttribute("data-sleeping")).toBe(true);
  const sleep = mark.querySelector<HTMLElement>(".favicon-sleep")!;
  expect(sleep).not.toBeNull();
  expect(sleep.querySelector("svg")).not.toBeNull();
  await expect.poll(() => getComputedStyle(sleep).position).toBe("absolute");
});

test("an awake page draws no sleeping mark", async () => {
  const screen = await render(FavIcon, { image: null, fallback: Globe02Icon });
  const mark = screen.container.querySelector<HTMLElement>("[data-favicon]")!;
  expect(mark.hasAttribute("data-sleeping")).toBe(false);
  expect(mark.querySelector(".favicon-sleep")).toBeNull();
});
