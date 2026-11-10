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
#include "nsIHttpChannel.h"
#include "nsILoadInfo.h"
#include "nsIPrincipal.h"
#include "nsIURI.h"
#include "nsNetUtil.h"

namespace mozilla::AstraBlocker {

// Registered by the Astra overlay. Default false: no rules installed at
// first boot means no blocks until the Host module pushes a rule set.
static const char* kEnabledPref = "astra.blocker.enabled";
static const char* kRemoveParamPref = "astra.blocker.removeparam";
static const char* kBouncePref = "astra.blocker.bounce";
static const char* kBlockScriptsPref = "astra.blocker.block-scripts";
static const char* kRedirectsPref = "astra.blocker.redirects";

namespace {

constexpr uint32_t kFlagRemoveParam = 1 << 0;
constexpr uint32_t kFlagBounce = 1 << 1;
constexpr uint32_t kFlagBlockScripts = 1 << 2;
constexpr uint32_t kFlagRedirects = 1 << 3;

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

uint32_t RequestFlags() {
  uint32_t flags = 0;
  if (Preferences::GetBool(kRemoveParamPref, true)) {
    flags |= kFlagRemoveParam;
  }
  if (Preferences::GetBool(kBouncePref, true)) {
    flags |= kFlagBounce;
  }
  if (Preferences::GetBool(kBlockScriptsPref, false)) {
    flags |= kFlagBlockScripts;
  }
  if (Preferences::GetBool(kRedirectsPref, true)) {
    flags |= kFlagRedirects;
  }
  return flags;
}

}  // namespace

bool IsInitialized() { return astra_blocker_engine_is_installed(); }

bool IsEnabled() {
  // Pref gate first so disabled builds skip the FFI round-trip.
  return Preferences::GetBool(kEnabledPref, false) && IsInitialized();
}

bool ApplyChannelAction(nsIChannel* aChannel) {
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

  // Never classify chrome/system loads. A top-level document has no loading
  // principal, so fall back to the triggering principal (the referrer or the
  // system principal) and let the engine treat an empty source as the
  // destination host.
  nsCOMPtr<nsIPrincipal> principal = loadInfo->GetLoadingPrincipal();
  if (!principal) {
    (void)loadInfo->GetTriggeringPrincipal(getter_AddRefs(principal));
  }
  nsCString sourceSpec;
  const bool isDocument =
      loadInfo->GetExternalContentPolicyType() ==
      ExtContentPolicyType::TYPE_DOCUMENT;
  if (principal) {
    bool isSystem = false;
    const bool system =
        NS_SUCCEEDED(principal->GetIsSystemPrincipal(&isSystem)) && isSystem;
    if (system) {
      // A browser-initiated top-level navigation has a system triggering
      // principal; it is still a web document and must be classified so
      // removeparam/bounce/CNAME work on it. Every non-document system load
      // (chrome, updater, internal fetch) is left alone.
      if (!isDocument) {
        return false;
      }
    } else if (!isDocument) {
      // A document's loading principal is the referrer; per-site policy must
      // key on the destination, so leave the source empty for the engine.
      (void)principal->GetAsciiSpec(sourceSpec);
    }
  }

  nsCString requestType;
  RequestTypeForPolicy(loadInfo->GetExternalContentPolicyType(), requestType);

  bool isPrivate = loadInfo->GetOriginAttributes().IsPrivateBrowsing();

  bool block = false;
  char* redirect = nullptr;
  char* rewrite = nullptr;
  nsresult rv = astra_blocker_engine_decide(
      url.get(), url.Length(), sourceSpec.get(), sourceSpec.Length(),
      requestType.get(), requestType.Length(), RequestFlags(), !isPrivate,
      &block, &redirect, &rewrite);
  if (NS_FAILED(rv)) {
    return false;
  }

  auto freeActions = [&]() {
    if (redirect) {
      astra_blocker_string_free(redirect);
      redirect = nullptr;
    }
    if (rewrite) {
      astra_blocker_string_free(rewrite);
      rewrite = nullptr;
    }
  };

  if (block) {
    // Never silently cancel a top-level document. The engine has its own Safe
    // Browsing interstitial for malware; a filter-list document rule killed
    // the navigation before connect, so the stage stayed on its own dark
    // ground with no page and no explanation (owner: tlauncher.org). Filter
    // lists still block every subresource, which is where the trackers and
    // ads live.
    if (isDocument) {
      freeActions();
      return false;
    }
    freeActions();
    aChannel->Cancel(NS_ERROR_ABORT);
    return true;
  }

  if (!redirect && !rewrite) {
    return false;
  }

  nsCString targetSpec;
  const bool isResourceRedirect = redirect != nullptr;
  targetSpec.Assign(isResourceRedirect ? redirect : rewrite);
  freeActions();

  nsCOMPtr<nsIURI> target;
  rv = NS_NewURI(getter_AddRefs(target), targetSpec);
  if (NS_FAILED(rv) || !target) {
    // A redirect resource must not fall back to the ad request; a rewrite
    // (removeparam / bounce) may fail open to the original URL.
    if (isResourceRedirect) {
      aChannel->Cancel(NS_ERROR_ABORT);
      return true;
    }
    return false;
  }

  nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(aChannel);
  if (!http) {
    if (isResourceRedirect) {
      aChannel->Cancel(NS_ERROR_ABORT);
      return true;
    }
    return false;
  }

  rv = http->RedirectTo(target);
  if (NS_FAILED(rv)) {
    if (isResourceRedirect) {
      aChannel->Cancel(NS_ERROR_ABORT);
      return true;
    }
    return false;
  }

  if (isResourceRedirect) {
    // `RedirectTo` clears the WebExtension flag. Restore it on this channel's
    // loadInfo so a data: body (script, image, ...) is accepted when the new
    // channel opens. No web content can reach this path.
    loadInfo->SetAllowInsecureRedirectToDataURI(true);
  }
  return false;
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

nsresult SetSitePolicy(const nsACString& aHost, bool aEnabled, bool aAggressive,
                       bool aScripts) {
  return astra_blocker_set_site_policy(aHost.BeginReading(), aHost.Length(),
                                       aEnabled, aAggressive, aScripts);
}

bool IsSiteEnabled(const nsACString& aHost) {
  return astra_blocker_is_site_enabled(aHost.BeginReading(), aHost.Length());
}

nsresult SitePolicyJson(const nsACString& aHost, nsACString& aOutJson) {
  char* json =
      astra_blocker_site_policy_json(aHost.BeginReading(), aHost.Length());
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
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

nsresult ClassifyHostJson(const nsACString& aHost, nsACString& aOutJson) {
  char* json =
      astra_blocker_classify_host_json(aHost.BeginReading(), aHost.Length());
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

nsresult ClassifyBounceJson(const nsACString& aUrl, nsACString& aOutJson) {
  char* json =
      astra_blocker_classify_bounce_json(aUrl.BeginReading(), aUrl.Length());
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

nsresult CnameJson(const nsACString& aHost, nsACString& aOutJson) {
  char* json = astra_blocker_cname_json(aHost.BeginReading(), aHost.Length());
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

nsresult CheckUrlJson(const nsACString& aUrl, const nsACString& aSourceUrl,
                      const nsACString& aType, nsACString& aOutJson) {
  // Diagnostic flags: redirect + removeparam + bounce (no Block Scripts, so a
  // normal page's scripts are still described accurately).
  constexpr uint32_t kDiagnosticFlags =
      kFlagRemoveParam | kFlagBounce | kFlagRedirects;
  char* json = astra_blocker_engine_check_json(
      aUrl.BeginReading(), aUrl.Length(), aSourceUrl.BeginReading(),
      aSourceUrl.Length(), aType.BeginReading(), aType.Length(),
      kDiagnosticFlags);
  if (!json) {
    return NS_ERROR_FAILURE;
  }
  TakeString(json, aOutJson);
  return NS_OK;
}

nsresult SetCloakedHost(const nsACString& aHost, bool aBlocked) {
  return astra_blocker_set_cloaked_host(aHost.BeginReading(), aHost.Length(),
                                        aBlocked);
}

bool IsCloaked(const nsACString& aHost) {
  return astra_blocker_is_cloaked(aHost.BeginReading(), aHost.Length());
}

nsresult CloakedHostsJson(nsACString& aOutJson) {
  char* json = astra_blocker_cloaked_hosts_json();
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
