/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/AstraBlocker.h"

#include "astra_blocker_ffi.h"

#include "mozilla/OriginAttributes.h"
#include "mozilla/Preferences.h"
#include "nsCOMPtr.h"
#include "nsIChannel.h"
#include "nsIContentPolicy.h"
#include "nsILoadInfo.h"
#include "nsIPrincipal.h"
#include "nsIURI.h"

namespace mozilla::AstraBlocker {

// Registered by the Astra overlay. Default false: no rules installed at
// first boot means no blocks until the Host module pushes a rule set.
static const char* kEnabledPref = "astra.blocker.enabled";

namespace {

void TakeString(char* aText, nsACString& aOut) {
  if (!aText) {
    aOut.Truncate();
    return;
  }
  aOut.Assign(aText);
  astra_blocker_string_free(aText);
}

bool ReportOk(const nsACString& aReport) {
  return aReport.Find("{\"ok\":true") == 0;
}

void RequestTypeForPolicy(ExtContentPolicyType aType, nsACString& aOut) {
  switch (aType) {
    case ExtContentPolicyType::TYPE_CSP_REPORT:
      aOut.AssignLiteral("csp_report");
      break;
    case ExtContentPolicyType::TYPE_DOCUMENT:
      aOut.AssignLiteral("document");
      break;
    case ExtContentPolicyType::TYPE_FONT:
      aOut.AssignLiteral("font");
      break;
    case ExtContentPolicyType::TYPE_IMAGE:
    case ExtContentPolicyType::TYPE_IMAGESET:
      aOut.AssignLiteral("image");
      break;
    case ExtContentPolicyType::TYPE_MEDIA:
      aOut.AssignLiteral("media");
      break;
    case ExtContentPolicyType::TYPE_OBJECT:
      aOut.AssignLiteral("object");
      break;
    case ExtContentPolicyType::TYPE_BEACON:
    case ExtContentPolicyType::TYPE_PING:
      aOut.AssignLiteral("ping");
      break;
    case ExtContentPolicyType::TYPE_SCRIPT:
      aOut.AssignLiteral("script");
      break;
    case ExtContentPolicyType::TYPE_STYLESHEET:
      aOut.AssignLiteral("stylesheet");
      break;
    case ExtContentPolicyType::TYPE_SUBDOCUMENT:
      aOut.AssignLiteral("subdocument");
      break;
    case ExtContentPolicyType::TYPE_WEBSOCKET:
      aOut.AssignLiteral("websocket");
      break;
    case ExtContentPolicyType::TYPE_XMLHTTPREQUEST:
      aOut.AssignLiteral("xmlhttprequest");
      break;
    default:
      aOut.AssignLiteral("other");
      break;
  }
}

bool IsBrowserInternalScheme(nsIURI* aURI) {
  return aURI->SchemeIs("about") || aURI->SchemeIs("chrome") ||
         aURI->SchemeIs("resource") || aURI->SchemeIs("moz-extension") ||
         aURI->SchemeIs("moz-page-mod") || aURI->SchemeIs("data") ||
         aURI->SchemeIs("blob") || aURI->SchemeIs("file") ||
         aURI->SchemeIs("view-source");
}

}  // namespace

bool IsInitialized() { return astra_blocker_engine_is_installed(); }

bool IsEnabled() {
  // Pref gate first so disabled builds skip the FFI round-trip.
  return Preferences::GetBool(kEnabledPref, false) && IsInitialized();
}

bool ShouldBlockChannel(nsIChannel* aChannel) {
  if (!IsEnabled() || !aChannel) {
    return false;
  }

  nsCOMPtr<nsIURI> uri;
  if (NS_FAILED(aChannel->GetURI(getter_AddRefs(uri))) || !uri ||
      IsBrowserInternalScheme(uri)) {
    return false;
  }

  nsCString url;
  if (NS_FAILED(uri->GetAsciiSpec(url))) {
    return false;
  }

  nsCOMPtr<nsILoadInfo> loadInfo;
  if (NS_FAILED(aChannel->GetLoadInfo(getter_AddRefs(loadInfo))) || !loadInfo) {
    return false;
  }
  nsCOMPtr<nsIPrincipal> loadingPrincipal = loadInfo->GetLoadingPrincipal();
  bool isSystem = false;
  if (!loadingPrincipal ||
      (NS_SUCCEEDED(loadingPrincipal->GetIsSystemPrincipal(&isSystem)) &&
       isSystem)) {
    return false;
  }
  nsCString sourceSpec;
  if (NS_FAILED(loadingPrincipal->GetAsciiSpec(sourceSpec))) {
    return false;
  }

  nsCString requestType;
  RequestTypeForPolicy(loadInfo->GetExternalContentPolicyType(), requestType);

  bool isPrivate = loadInfo->GetOriginAttributes().IsPrivateBrowsing();

  bool block = false;
  nsresult rv = astra_blocker_engine_should_block(
      url.get(), url.Length(), sourceSpec.get(), sourceSpec.Length(),
      requestType.get(), requestType.Length(), !isPrivate, &block);
  if (NS_FAILED(rv)) {
    return false;
  }
  return block;
}

nsresult InstallRules(const nsACString& aRules) {
  char* report =
      astra_blocker_engine_install(aRules.BeginReading(), aRules.Length());
  if (!report) {
    return NS_ERROR_FAILURE;
  }
  nsCString text;
  TakeString(report, text);
  if (!ReportOk(text)) {
    NS_WARNING("AstraBlocker: rule compilation failed; previous engine kept");
    return NS_ERROR_FAILURE;
  }
  return NS_OK;
}

nsresult InstallResources(const nsACString& aResourcesJson) {
  char* report = astra_blocker_engine_set_resources(aResourcesJson.BeginReading(),
                                                    aResourcesJson.Length());
  if (!report) {
    return NS_ERROR_FAILURE;
  }
  nsCString text;
  TakeString(report, text);
  return ReportOk(text) ? NS_OK : NS_ERROR_FAILURE;
}

void SetEnabled(bool aEnabled) {
  Preferences::SetBool(kEnabledPref, aEnabled);
}

nsresult SetSiteEnabled(const nsACString& aHost, bool aEnabled) {
  return astra_blocker_set_site_enabled(aHost.BeginReading(), aHost.Length(),
                                        aEnabled);
}

bool IsSiteEnabled(const nsACString& aHost) {
  return astra_blocker_is_site_enabled(aHost.BeginReading(), aHost.Length());
}

nsresult CosmeticFor(const nsACString& aUrl, const nsACString& aClassesJson,
                     const nsACString& aIdsJson, nsACString& aOutJson) {
  char* json = astra_blocker_engine_cosmetic(
      aUrl.BeginReading(), aUrl.Length(), aClassesJson.BeginReading(),
      aClassesJson.Length(), aIdsJson.BeginReading(), aIdsJson.Length());
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

nsresult StatusJson(nsACString& aOutJson) {
  nsCString version;
  nsresult rv = VersionJson(version);
  if (NS_FAILED(rv)) {
    return rv;
  }
  aOutJson.Truncate();
  aOutJson.AppendPrintf("{\"initialized\":%s,\"enabled\":%s,\"version\":",
                        IsInitialized() ? "true" : "false",
                        IsEnabled() ? "true" : "false");
  aOutJson.Append(version);
  aOutJson.AppendLiteral("}");
  return NS_OK;
}

nsresult StatsJson(nsACString& aOutJson) {
  char* json = astra_blocker_engine_stats_json();
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

nsresult VersionJson(nsACString& aOutJson) {
  char* json = astra_blocker_engine_version_json();
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

nsresult SiteExceptionsJson(nsACString& aOutJson) {
  char* json = astra_blocker_site_exceptions_json();
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

void ResetStats() { astra_blocker_engine_reset_stats(); }

}  // namespace mozilla::AstraBlocker
