// P0-T07 shared stateful mock servers, one per profile.
// Screens seed these before mounting; the router's default `resource_call`
// handler answers from the same instances, so Shell-embedded widgets (the
// new tab's task counts) and full pages share one deterministic world.

import { resourceTestServer } from "../src/shared/testing/resources/server";

const servers = new Map<string, ReturnType<typeof resourceTestServer>>();

export function resourceServerFor(profile: string): ReturnType<typeof resourceTestServer> {
  let server = servers.get(profile);
  if (!server) {
    server = resourceTestServer(profile);
    servers.set(profile, server);
  }
  return server;
}

export async function resourceCallHandler(args: {
  expectedProfile?: unknown;
  call?: unknown;
}): Promise<unknown> {
  const profile = String(args.expectedProfile ?? "");
  return resourceServerFor(profile).call(profile, args.call as never);
}
