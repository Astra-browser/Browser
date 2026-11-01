/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Stable string-typed identifiers shared by the Host API seam.

use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! string_id {
    ($($doc:expr, $name:ident;)*) => {
        $(
            #[doc = $doc]
            #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
            pub struct $name(pub String);

            impl $name {
                pub fn new(id: impl Into<String>) -> Self {
                    Self(id.into())
                }

                pub fn as_str(&self) -> &str {
                    &self.0
                }
            }

            impl fmt::Display for $name {
                fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str(&self.0)
                }
            }

            impl From<&str> for $name {
                fn from(value: &str) -> Self {
                    Self(value.to_owned())
                }
            }

            impl From<String> for $name {
                fn from(value: String) -> Self {
                    Self(value)
                }
            }
        )*
    };
}

string_id! {
    "Tab identifier (Host API `Tabs` module).",
    TabId;
    "Window identifier (Host API `Windows` module).",
    WindowId;
    "Profile / container identifier (Host API `Containers` module).",
    ProfileId;
    "Space identifier (shell UI state, applied via `Containers`).",
    SpaceId;
    "Download identifier (Host API `Downloads` module).",
    DownloadId;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_display_and_from() {
        let tab = TabId::new("tab-1");
        assert_eq!(tab.to_string(), "tab-1");
        assert_eq!(TabId::from("x"), TabId::new("x"));
        assert_eq!(ProfileId::from(String::from("p")), ProfileId::new("p"));
        // Serde shape stays a plain string on the wire.
        let json = serde_json::to_string(&tab).unwrap();
        assert_eq!(json, "\"tab-1\"");
    }
}
