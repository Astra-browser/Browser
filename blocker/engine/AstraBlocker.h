/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_AstraBlocker_h
#define mozilla_AstraBlocker_h

#include "nsError.h"
#include "nsString.h"

class nsIChannel;

namespace mozilla::AstraBlocker {

bool IsInitialized();

bool IsEnabled();

/**
 * Inspect one channel before connect. Either cancels it (blocked), redirects
 * it (removeparam / bounce / redirect resource), or lets it continue.
 * Returns true when the channel was cancelled.
 */
bool ApplyChannelAction(nsIChannel* aChannel);

nsresult InstallRules(const nsACString& aRules);
nsresult InstallResources(const nsACString& aResourcesJson);
void SetEnabled(bool aEnabled);
nsresult SetSiteEnabled(const nsACString& aHost, bool aEnabled);
nsresult SetSitePolicy(const nsACString& aHost, bool aEnabled, bool aAggressive,
                       bool aScripts);
bool IsSiteEnabled(const nsACString& aHost);
nsresult SitePolicyJson(const nsACString& aHost, nsACString& aOutJson);
nsresult CosmeticFor(const nsACString& aUrl, const nsACString& aClassesJson,
                     const nsACString& aIdsJson, nsACString& aOutJson);

nsresult ClassifyHostJson(const nsACString& aHost, nsACString& aOutJson);
nsresult ClassifyBounceJson(const nsACString& aUrl, nsACString& aOutJson);

/** System-resolver CNAME chain for one host (fallback for platforms whose
 *  getaddrinfo does not return a canonical name). */
nsresult CnameJson(const nsACString& aHost, nsACString& aOutJson);

/** Diagnostic verdict for one request: block, redirect resource, rewrite. */
nsresult CheckUrlJson(const nsACString& aUrl, const nsACString& aSourceUrl,
                      const nsACString& aType, nsACString& aOutJson);
nsresult SetCloakedHost(const nsACString& aHost, bool aBlocked);
bool IsCloaked(const nsACString& aHost);
nsresult CloakedHostsJson(nsACString& aOutJson);

nsresult StatusJson(nsACString& aOutJson);
nsresult StatsJson(nsACString& aOutJson);
nsresult VersionJson(nsACString& aOutJson);
nsresult SiteExceptionsJson(nsACString& aOutJson);
void ResetStats();

}  // namespace mozilla::AstraBlocker

#endif  // mozilla_AstraBlocker_h
