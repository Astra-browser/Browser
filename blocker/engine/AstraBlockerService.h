/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_AstraBlockerService_h
#define mozilla_AstraBlockerService_h

#include "nsIAstraBlockerService.h"

namespace mozilla {

class AstraBlockerService final : public nsIAstraBlockerService {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIASTRABLOCKERSERVICE

  AstraBlockerService() = default;

 private:
  ~AstraBlockerService() = default;
};

already_AddRefed<nsIAstraBlockerService> AstraBlockerServiceConstructor();

}  // namespace mozilla

#endif  // mozilla_AstraBlockerService_h
