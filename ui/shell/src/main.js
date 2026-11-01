import { mount } from "svelte";
import Hello from "./Hello.svelte";

const target = document.getElementById("astra-root");
if (!target) {
  throw new Error("[astra-shell] #astra-root missing (ASTRA-0002 hook not applied?)");
}
mount(Hello, { target });
