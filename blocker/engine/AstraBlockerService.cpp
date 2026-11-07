/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AstraBlockerService.h"

#include "mozilla/AstraBlocker.h"
#include "mozilla/RefPtr.h"

namespace mozilla {

NS_IMPL_ISUPPORTS(AstraBlockerService, nsIAstraBlockerService)

NS_IMETHODIMP
AstraBlockerService::GetInitialized(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = AstraBlocker::IsInitialized();
  return NS_OK;
}

NS_IMETHODIMP
AstraBlockerService::GetEnabled(bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = AstraBlocker::IsEnabled();
  return NS_OK;
}

NS_IMETHODIMP
AstraBlockerService::Status(nsACString& aResult) {
  return AstraBlocker::StatusJson(aResult);
}

NS_IMETHODIMP
AstraBlockerService::InstallRules(const nsACString& aRules) {
  return AstraBlocker::InstallRules(aRules);
}

NS_IMETHODIMP
AstraBlockerService::SetResources(const nsACString& aResourcesJson) {
  return AstraBlocker::InstallResources(aResourcesJson);
}

NS_IMETHODIMP
AstraBlockerService::SetEnabled(bool aEnabled) {
  AstraBlocker::SetEnabled(aEnabled);
  return NS_OK;
}

NS_IMETHODIMP
AstraBlockerService::SetSiteEnabled(const nsACString& aHost, bool aEnabled) {
  return AstraBlocker::SetSiteEnabled(aHost, aEnabled);
}

NS_IMETHODIMP
AstraBlockerService::IsSiteEnabled(const nsACString& aHost, bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = AstraBlocker::IsSiteEnabled(aHost);
  return NS_OK;
}

NS_IMETHODIMP
AstraBlockerService::SiteExceptions(nsACString& aResult) {
  return AstraBlocker::SiteExceptionsJson(aResult);
}

NS_IMETHODIMP
AstraBlockerService::CosmeticFor(const nsACString& aUrl,
                                 const nsACString& aClassesJson,
                                 const nsACString& aIdsJson,
                                 nsACString& aResult) {
  return AstraBlocker::CosmeticFor(aUrl, aClassesJson, aIdsJson, aResult);
}

NS_IMETHODIMP
AstraBlockerService::Stats(nsACString& aResult) {
  return AstraBlocker::StatsJson(aResult);
}

NS_IMETHODIMP
AstraBlockerService::ResetStats() {
  AstraBlocker::ResetStats();
  return NS_OK;
}

already_AddRefed<nsIAstraBlockerService> AstraBlockerServiceConstructor() {
  RefPtr<AstraBlockerService> service = new AstraBlockerService();
  return service.forget().downcast<nsIAstraBlockerService>();
}

}  // namespace mozilla
