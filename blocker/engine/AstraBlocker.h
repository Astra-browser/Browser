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

bool ShouldBlockChannel(nsIChannel* aChannel);

nsresult InstallRules(const nsACString& aRules);
nsresult InstallResources(const nsACString& aResourcesJson);
void SetEnabled(bool aEnabled);
nsresult SetSiteEnabled(const nsACString& aHost, bool aEnabled);
bool IsSiteEnabled(const nsACString& aHost);
nsresult CosmeticFor(const nsACString& aUrl, const nsACString& aClassesJson,
                     const nsACString& aIdsJson, nsACString& aOutJson);

nsresult StatusJson(nsACString& aOutJson);
nsresult StatsJson(nsACString& aOutJson);
nsresult VersionJson(nsACString& aOutJson);
nsresult SiteExceptionsJson(nsACString& aOutJson);
void ResetStats();

}  // namespace mozilla::AstraBlocker

#endif  // mozilla_AstraBlocker_h
