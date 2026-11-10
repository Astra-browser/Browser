// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Optional OS user verification.
//!
//! On Linux the only user-authentication service a browser can drive without
//! owning the policy layer is `fprintd`. It is used when the user enables
//! system authentication and a fingerprint device is present; every failure
//! path falls back to the PIN, which is always available.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn current_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| {
            Command::new("id")
                .arg("-un")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        })
}

/// True when `fprintd` reports at least one device for this user.
pub fn system_auth_available() -> bool {
    let user = current_user();
    if user.is_empty() {
        return false;
    }
    let Ok(output) = Command::new("fprintd-list")
        .arg(&user)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    output.status.success() && !text.contains("no devices available") && !text.trim().is_empty()
}

/// Run `fprintd-verify` and report whether the user passed. Never blocks the
/// caller longer than `timeout`.
pub fn verify_system_auth(timeout: Duration) -> bool {
    let user = current_user();
    if user.is_empty() {
        return false;
    }
    run_for("fprintd-verify", &[user.as_str()], timeout)
}

fn run_for(program: &str, args: &[&str], timeout: Duration) -> bool {
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::run_for;
    use std::time::Duration;

    #[test]
    fn a_successful_command_verifies() {
        assert!(run_for("true", &[], Duration::from_secs(5)));
    }

    #[test]
    fn a_failed_command_does_not() {
        assert!(!run_for("false", &[], Duration::from_secs(5)));
    }

    #[test]
    fn a_missing_program_does_not_verify() {
        assert!(!run_for("astra-no-such-verifier", &[], Duration::from_secs(1)));
    }
}
