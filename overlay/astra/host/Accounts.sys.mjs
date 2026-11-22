/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Accounts module (v1, P3-T20). The New Tab's account pane asks
// `account_get` for the signed-in state; without a route the pane never
// appears at all (the reference UI shows "Sign in" when signed out).
//
// Astra accounts (plan §8, Phase 7) live in astra-core behind the cloud
// client; the shell has no account session yet, so this reports the honest
// signed-out state with the surface available. Nothing here talks to a
// server and no credentials exist.
//
// Pure logic, no Firefox internals.

import { HOST_API_VERSION } from "./Envelope.sys.mjs";

/** The signed-out account view (bindings.ts: AccountV1). */
function signedOutAccount() {
  return {
    version: 1,
    available: true,
    server: "",
    custom_server: false,
    hosted_models: null,
    billing: null,
    signup_open: null,
    update_required: false,
    signed_in: false,
    vault_fault: false,
    pending_email: null,
    resend_in: null,
    email: null,
    name: null,
    avatar: null,
    plan: null,
    usage: null,
    subscription: null,
    offers: [],
    checkout_open: false,
    portal_open: false,
    signup_mode: null,
    billing_review: false,
    plan_change: null,
    notice: null,
    unsettled: [],
  };
}

export const Accounts = {
  async get() {
    return { account: signedOutAccount(), fault: null, retry_after: null };
  },
};
