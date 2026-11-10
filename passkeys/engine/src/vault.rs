// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

use crate::pbkdf2::pbkdf2;
use crate::pin::PinHash;
use crate::seal::{Seal, Sealed, KEY_LEN};
use crate::{DEVICE_KEY_ITERATIONS, DEFAULT_PIN_ITERATIONS, LOCKOUT_BASE_SECS,
            LOCKOUT_MAX_SECS, MAX_PIN_FAILURES};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const FILE_VERSION: u8 = 1;
const SALT_LEN: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// The request or stored blob is structurally invalid.
    Invalid,
    /// The PIN does not meet the policy (6..=63 UTF-8 bytes).
    PinPolicy,
    /// The PIN, device key, or file authentication failed.
    AuthFailed,
    /// Too many wrong PINs; a retry is allowed after the delay.
    RateLimited { retry_after_secs: u64 },
    /// No vault has been created yet.
    NotInitialized,
    /// A vault already exists.
    AlreadyInitialized,
    /// The vault is locked.
    Locked,
    /// A cryptographic primitive failed.
    Crypto,
    /// Storage failed.
    Io,
    /// Not supported by this build or platform.
    Unsupported,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid => f.write_str("invalid vault data"),
            Self::PinPolicy => f.write_str("PIN must be 6 to 63 characters"),
            Self::AuthFailed => f.write_str("authentication failed"),
            Self::RateLimited { retry_after_secs } => {
                write!(f, "locked for {retry_after_secs} seconds")
            }
            Self::NotInitialized => f.write_str("passkeys are not set up"),
            Self::AlreadyInitialized => f.write_str("passkeys are already set up"),
            Self::Locked => f.write_str("passkey vault is locked"),
            Self::Crypto => f.write_str("cryptographic operation failed"),
            Self::Io => f.write_str("storage operation failed"),
            Self::Unsupported => f.write_str("not supported"),
        }
    }
}

impl std::error::Error for VaultError {}

#[derive(Clone, Default, Debug)]
pub struct VaultStatus {
    pub exists: bool,
    pub has_pin: bool,
    pub unlocked: bool,
    pub system_unlock: bool,
    pub system_auth_available: bool,
    pub credential_count: usize,
    pub pin_retries_left: u32,
    pub locked_for_secs: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NewCredential {
    pub id: Vec<u8>,
    pub rp_id: String,
    pub user_handle: Vec<u8>,
    pub user_name: Option<String>,
    pub private_key: Vec<u8>,
    pub public_key: Vec<u8>,
    pub discoverable: bool,
    pub cred_protect: u8,
}

impl std::fmt::Debug for NewCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewCredential")
            .field("id", &self.id)
            .field("rp_id", &self.rp_id)
            .field("user_handle", &self.user_handle)
            .field("discoverable", &self.discoverable)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct StoredCredential {
    pub id: Vec<u8>,
    pub rp_id: String,
    pub user_handle: Vec<u8>,
    pub user_name: Option<String>,
    pub private_key: Zeroizing<Vec<u8>>,
    pub public_key: Vec<u8>,
    pub discoverable: bool,
    pub cred_protect: u8,
}

impl std::fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredCredential")
            .field("id", &self.id)
            .field("rp_id", &self.rp_id)
            .field("discoverable", &self.discoverable)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialSummary {
    pub id: Vec<u8>,
    pub rp_id: String,
    pub user_name: Option<String>,
    pub discoverable: bool,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize)]
struct SealedJson {
    iv: String,
    ct: String,
    tag: String,
}

impl SealedJson {
    fn from_sealed(sealed: Sealed) -> Self {
        let e = base64::engine::general_purpose::STANDARD;
        Self {
            iv: e.encode(sealed.iv),
            ct: e.encode(sealed.ciphertext),
            tag: e.encode(sealed.tag),
        }
    }

    fn decode(&self) -> Result<Sealed, VaultError> {
        let e = base64::engine::general_purpose::STANDARD;
        let iv = e.decode(&self.iv).map_err(|_| VaultError::Invalid)?;
        let ciphertext = e.decode(&self.ct).map_err(|_| VaultError::Invalid)?;
        let tag = e.decode(&self.tag).map_err(|_| VaultError::Invalid)?;
        if iv.len() != crate::seal::IV_LEN || tag.len() != crate::seal::TAG_LEN {
            return Err(VaultError::Invalid);
        }
        let mut iv_out = [0u8; crate::seal::IV_LEN];
        iv_out.copy_from_slice(&iv);
        let mut tag_out = [0u8; crate::seal::TAG_LEN];
        tag_out.copy_from_slice(&tag);
        Ok(Sealed {
            iv: iv_out,
            ciphertext,
            tag: tag_out,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct DeviceWrap {
    iterations: u32,
    salt: String,
    sealed: SealedJson,
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    v: u8,
    iterations: u32,
    salt: String,
    pin: SealedJson,
    #[serde(default)]
    device: Option<DeviceWrap>,
    #[serde(default)]
    failures: u32,
    #[serde(default)]
    locked_until: u64,
    credentials: SealedJson,
}

#[derive(Serialize, Deserialize)]
struct CredentialRecord {
    id: Vec<u8>,
    rp_id: String,
    user_handle: Vec<u8>,
    user_name: Option<String>,
    private_key: Vec<u8>,
    public_key: Vec<u8>,
    discoverable: bool,
    cred_protect: u8,
    created_at: u64,
}

struct State {
    key: Option<Zeroizing<Vec<u8>>>,
    system_probe: Option<(Instant, bool)>,
}

/// A platform-passkey vault on disk. All methods are safe to call from the
/// WebAuthn background thread; the unlocked key lives in this process only.
pub struct Vault {
    path: PathBuf,
    seal: Arc<dyn Seal>,
    state: Mutex<State>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, VaultError> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| VaultError::Invalid)
}

fn lockout_seconds(failures: u32) -> u64 {
    if failures < MAX_PIN_FAILURES {
        return 0;
    }
    let over = failures - MAX_PIN_FAILURES;
    LOCKOUT_BASE_SECS
        .saturating_mul(1u64 << over.min(4))
        .min(LOCKOUT_MAX_SECS)
}

fn write_secret_file(path: &Path, data: &[u8]) -> Result<(), VaultError> {
    let parent = path.parent().ok_or(VaultError::Io)?;
    fs::create_dir_all(parent).map_err(|_| VaultError::Io)?;
    let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    let temp = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| VaultError::Io)?;
    file.write_all(data).map_err(|_| VaultError::Io)?;
    file.sync_all().map_err(|_| VaultError::Io)?;
    drop(file);
    fs::rename(&temp, path).map_err(|_| VaultError::Io)?;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    Ok(())
}

impl Vault {
    pub fn open(path: PathBuf, seal: Arc<dyn Seal>) -> Self {
        Self {
            path,
            seal,
            state: Mutex::new(State {
                key: None,
                system_probe: None,
            }),
        }
    }

    fn device_path(&self) -> PathBuf {
        self.path.with_extension("device")
    }

    fn read_file(&self) -> Result<Option<VaultFile>, VaultError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(VaultError::Io),
        };
        let file: VaultFile = serde_json::from_slice(&bytes).map_err(|_| VaultError::Invalid)?;
        if file.v != FILE_VERSION {
            return Err(VaultError::Invalid);
        }
        Ok(Some(file))
    }

    fn write_file(&self, file: &VaultFile) -> Result<(), VaultError> {
        let bytes = serde_json::to_vec(file).map_err(|_| VaultError::Io)?;
        write_secret_file(&self.path, &bytes)
    }

    fn derive(&self, secret: &[u8], salt: &[u8], iterations: u32) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let seal = self.seal.clone();
        let hmac = |key: &[u8], data: &[u8]| seal.hmac_sha256(key, data);
        Ok(Zeroizing::new(pbkdf2(secret, salt, iterations, KEY_LEN, &hmac)?))
    }

    fn unwrap_key(
        &self,
        wrapped: &SealedJson,
        secret: &[u8],
        salt: &[u8],
        iterations: u32,
    ) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let kek = self.derive(secret, salt, iterations)?;
        let sealed = wrapped.decode()?;
        let key = sealed.open(self.seal.as_ref(), &kek)?;
        if key.len() != KEY_LEN {
            return Err(VaultError::Crypto);
        }
        Ok(Zeroizing::new(key))
    }

    fn wrap_key(
        &self,
        key: &[u8],
        secret: &[u8],
        salt: &[u8],
        iterations: u32,
    ) -> Result<SealedJson, VaultError> {
        let kek = self.derive(secret, salt, iterations)?;
        Ok(SealedJson::from_sealed(Sealed::seal(
            self.seal.as_ref(),
            &kek,
            key,
        )?))
    }

    fn read_credentials(
        &self,
        key: &[u8],
        file: &VaultFile,
    ) -> Result<Vec<CredentialRecord>, VaultError> {
        let sealed = file.credentials.decode()?;
        let plain = sealed.open(self.seal.as_ref(), key)?;
        serde_json::from_slice(&plain).map_err(|_| VaultError::Invalid)
    }

    fn write_credentials(
        &self,
        key: &[u8],
        file: &mut VaultFile,
        credentials: &[CredentialRecord],
    ) -> Result<(), VaultError> {
        let plain = serde_json::to_vec(credentials).map_err(|_| VaultError::Io)?;
        file.credentials =
            SealedJson::from_sealed(Sealed::seal(self.seal.as_ref(), key, &plain)?);
        self.write_file(file)
    }

    fn require_key(&self) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let guard = self.state.lock().map_err(|_| VaultError::Crypto)?;
        guard.key.clone().ok_or(VaultError::Locked)
    }

    fn unlock_with(&self, key: Zeroizing<Vec<u8>>) {
        if let Ok(mut guard) = self.state.lock() {
            guard.key = Some(key);
        }
    }

    pub fn status(&self) -> VaultStatus {
        let unlocked = self
            .state
            .lock()
            .map(|g| g.key.is_some())
            .unwrap_or(false);
        let mut status = VaultStatus {
            exists: false,
            has_pin: false,
            unlocked,
            system_auth_available: self.system_auth_available(),
            ..Default::default()
        };
        let Ok(Some(file)) = self.read_file() else {
            return status;
        };
        status.exists = true;
        status.has_pin = true;
        status.system_unlock = file.device.is_some();
        let now = now_unix();
        status.locked_for_secs = file.locked_until.saturating_sub(now);
        status.pin_retries_left = MAX_PIN_FAILURES.saturating_sub(file.failures);
        if let Ok(key) = self.require_key() {
            if let Ok(creds) = self.read_credentials(&key, &file) {
                status.credential_count = creds.len();
            }
        }
        status
    }

    /// Probe `fprintd` at most once a minute; the UI asks for status often.
    fn system_auth_available(&self) -> bool {
        if let Ok(mut guard) = self.state.lock() {
            if let Some((at, value)) = guard.system_probe {
                if at.elapsed() < std::time::Duration::from_secs(60) {
                    return value;
                }
            }
            let value = crate::system_auth_available();
            guard.system_probe = Some((Instant::now(), value));
            return value;
        }
        false
    }

    /// Create the vault. Fails if one already exists: enabling passkeys twice
    /// must never silently discard the user's credentials.
    pub fn create(&self, pin: &PinHash, system_unlock: bool) -> Result<(), VaultError> {
        if self.read_file()?.is_some() {
            return Err(VaultError::AlreadyInitialized);
        }
        let vault_key = Zeroizing::new(self.seal.random(KEY_LEN)?);
        let salt = self.seal.random(SALT_LEN)?;
        let pin_wrap = self.wrap_key(
            &vault_key,
            pin.as_bytes(),
            &salt,
            DEFAULT_PIN_ITERATIONS,
        )?;
        let empty = serde_json::to_vec(&Vec::<CredentialRecord>::new())
            .map_err(|_| VaultError::Io)?;
        let credentials =
            SealedJson::from_sealed(Sealed::seal(self.seal.as_ref(), &vault_key, &empty)?);
        let mut file = VaultFile {
            v: FILE_VERSION,
            iterations: DEFAULT_PIN_ITERATIONS,
            salt: b64(&salt),
            pin: pin_wrap,
            device: None,
            failures: 0,
            locked_until: 0,
            credentials,
        };
        if system_unlock {
            file.device = Some(self.new_device_wrap(&vault_key)?);
        }
        self.write_file(&file)?;
        self.unlock_with(vault_key);
        Ok(())
    }

    fn new_device_wrap(&self, vault_key: &[u8]) -> Result<DeviceWrap, VaultError> {
        let device_key = self.seal.random(KEY_LEN)?;
        let salt = self.seal.random(SALT_LEN)?;
        let sealed = self.wrap_key(vault_key, &device_key, &salt, DEVICE_KEY_ITERATIONS)?;
        write_secret_file(&self.device_path(), &device_key)?;
        Ok(DeviceWrap {
            iterations: DEVICE_KEY_ITERATIONS,
            salt: b64(&salt),
            sealed,
        })
    }

    fn check_lockout(file: &VaultFile) -> Result<(), VaultError> {
        let now = now_unix();
        if file.locked_until > now {
            return Err(VaultError::RateLimited {
                retry_after_secs: file.locked_until - now,
            });
        }
        Ok(())
    }

    fn record_failure(&self, file: &mut VaultFile) -> Result<VaultError, VaultError> {
        file.failures = file.failures.saturating_add(1);
        let delay = lockout_seconds(file.failures);
        if delay > 0 {
            file.locked_until = now_unix().saturating_add(delay);
        }
        self.write_file(file)?;
        if delay > 0 {
            Ok(VaultError::RateLimited {
                retry_after_secs: delay,
            })
        } else {
            Ok(VaultError::AuthFailed)
        }
    }

    pub fn unlock_with_pin(&self, pin: &PinHash) -> Result<(), VaultError> {
        let Some(mut file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        Self::check_lockout(&file)?;
        let salt = unb64(&file.salt)?;
        match self.unwrap_key(&file.pin, pin.as_bytes(), &salt, file.iterations) {
            Ok(key) => {
                if file.failures != 0 || file.locked_until != 0 {
                    file.failures = 0;
                    file.locked_until = 0;
                    self.write_file(&file)?;
                }
                self.unlock_with(key);
                Ok(())
            }
            Err(VaultError::AuthFailed) | Err(VaultError::Invalid) => {
                Err(self.record_failure(&mut file)?)
            }
            Err(e) => Err(e),
        }
    }

    /// Unlock through the device key. The caller must run OS user verification
    /// (fingerprint) first; this key is high-entropy and not user-derived.
    pub fn unlock_with_device(&self) -> Result<(), VaultError> {
        let Some(file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        let Some(device) = &file.device else {
            return Err(VaultError::Unsupported);
        };
        let device_key = fs::read(self.device_path()).map_err(|_| VaultError::Unsupported)?;
        let salt = unb64(&device.salt)?;
        let sealed = device.sealed.decode()?;
        let kek = self.derive(&device_key, &salt, device.iterations)?;
        let key = sealed.open(self.seal.as_ref(), &kek)?;
        if key.len() != KEY_LEN {
            return Err(VaultError::Crypto);
        }
        self.unlock_with(Zeroizing::new(key));
        Ok(())
    }

    pub fn lock(&self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.key = None;
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.state.lock().map(|g| g.key.is_some()).unwrap_or(false)
    }

    /// Change the PIN. The vault must be unlocked (the settings flow unlocks
    /// with the current PIN first, which also exercises the rate limit).
    pub fn change_pin(&self, new_pin: &PinHash) -> Result<(), VaultError> {
        let key = self.require_key()?;
        let Some(mut file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        let salt = self.seal.random(SALT_LEN)?;
        file.salt = b64(&salt);
        file.iterations = DEFAULT_PIN_ITERATIONS;
        file.pin = self.wrap_key(&key, new_pin.as_bytes(), &salt, file.iterations)?;
        file.failures = 0;
        file.locked_until = 0;
        self.write_file(&file)
    }

    /// Enable or remove the system-authentication (device key) path.
    pub fn set_system_unlock(&self, enabled: bool) -> Result<(), VaultError> {
        let key = self.require_key()?;
        let Some(mut file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        if enabled {
            if file.device.is_none() {
                file.device = Some(self.new_device_wrap(&key)?);
            }
        } else if file.device.is_some() {
            file.device = None;
            let _ = fs::remove_file(self.device_path());
        }
        self.write_file(&file)
    }

    pub fn add_credential(&self, credential: NewCredential) -> Result<(), VaultError> {
        let key = self.require_key()?;
        let Some(mut file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        if credential.id.len() != 32 || credential.private_key.is_empty() {
            return Err(VaultError::Invalid);
        }
        let mut credentials = self.read_credentials(&key, &file)?;
        if credentials.iter().any(|c| c.id == credential.id) {
            return Err(VaultError::Invalid);
        }
        credentials.push(CredentialRecord {
            id: credential.id,
            rp_id: credential.rp_id,
            user_handle: credential.user_handle,
            user_name: credential.user_name,
            private_key: credential.private_key,
            public_key: credential.public_key,
            discoverable: credential.discoverable,
            cred_protect: credential.cred_protect,
            created_at: now_unix(),
        });
        self.write_credentials(&key, &mut file, &credentials)
    }

    pub fn credentials_for_rp(
        &self,
        rp_id: &str,
        allow_list: &[Vec<u8>],
        discoverable_only: bool,
    ) -> Result<Vec<StoredCredential>, VaultError> {
        let key = self.require_key()?;
        let Some(file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        let credentials = self.read_credentials(&key, &file)?;
        Ok(credentials
            .into_iter()
            .filter(|c| c.rp_id == rp_id)
            .filter(|c| !discoverable_only || c.discoverable)
            .filter(|c| allow_list.is_empty() || allow_list.iter().any(|id| id == &c.id))
            .map(|c| StoredCredential {
                id: c.id,
                rp_id: c.rp_id,
                user_handle: c.user_handle,
                user_name: c.user_name,
                private_key: Zeroizing::new(c.private_key),
                public_key: c.public_key,
                discoverable: c.discoverable,
                cred_protect: c.cred_protect,
            })
            .collect())
    }

    pub fn list(&self) -> Result<Vec<CredentialSummary>, VaultError> {
        let key = self.require_key()?;
        let Some(file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        let credentials = self.read_credentials(&key, &file)?;
        let mut out: Vec<CredentialSummary> = credentials
            .into_iter()
            .map(|c| CredentialSummary {
                id: c.id,
                rp_id: c.rp_id,
                user_name: c.user_name,
                discoverable: c.discoverable,
                created_at: c.created_at,
            })
            .collect();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    pub fn delete(&self, id: &[u8]) -> Result<bool, VaultError> {
        let key = self.require_key()?;
        let Some(mut file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        let mut credentials = self.read_credentials(&key, &file)?;
        let before = credentials.len();
        credentials.retain(|c| c.id != id);
        if credentials.len() == before {
            return Ok(false);
        }
        self.write_credentials(&key, &mut file, &credentials)?;
        Ok(true)
    }

    pub fn delete_all(&self) -> Result<(), VaultError> {
        let key = self.require_key()?;
        let Some(mut file) = self.read_file()? else {
            return Err(VaultError::NotInitialized);
        };
        self.write_credentials(&key, &mut file, &[])
    }

    /// Destroy the vault and its device key. Used by "Remove all passkeys".
    pub fn destroy(&self) -> Result<(), VaultError> {
        self.lock();
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(self.device_path());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pin::hash_pin;
    use crate::seal::TestSeal;
    use std::sync::Arc;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        let seal: Arc<dyn Seal> = Arc::new(TestSeal);
        (dir, Vault::open(path, seal))
    }

    fn credential(id: u8, rp: &str) -> NewCredential {
        NewCredential {
            id: vec![id; 32],
            rp_id: rp.into(),
            user_handle: vec![1, 2, 3],
            user_name: Some("user@example.com".into()),
            private_key: vec![9u8; 32],
            public_key: vec![4u8; 65],
            discoverable: true,
            cred_protect: 0,
        }
    }

    #[test]
    fn create_unlock_and_assert() {
        let (_dir, vault) = vault();
        let pin = hash_pin("123456").unwrap();
        vault.create(&pin, false).unwrap();
        assert!(vault.is_unlocked());

        vault.add_credential(credential(1, "example.com")).unwrap();
        let found = vault
            .credentials_for_rp("example.com", &[], true)
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].private_key.as_slice(), &[9u8; 32]);
        assert!(vault
            .credentials_for_rp("other.example", &[], true)
            .unwrap()
            .is_empty());

        vault.lock();
        assert!(matches!(
            vault.credentials_for_rp("example.com", &[], true),
            Err(VaultError::Locked)
        ));
        vault.unlock_with_pin(&pin).unwrap();
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn wrong_pin_fails_and_locks_out() {
        let (_dir, vault) = vault();
        let pin = hash_pin("123456").unwrap();
        vault.create(&pin, false).unwrap();
        vault.lock();

        let wrong = hash_pin("654321").unwrap();
        for _ in 0..MAX_PIN_FAILURES - 1 {
            assert_eq!(vault.unlock_with_pin(&wrong), Err(VaultError::AuthFailed));
        }
        match vault.unlock_with_pin(&wrong) {
            Err(VaultError::RateLimited { retry_after_secs }) => {
                assert!(retry_after_secs > 0);
            }
            other => panic!("expected lockout, got {other:?}"),
        }
        // The correct PIN is still refused while locked out.
        assert!(matches!(
            vault.unlock_with_pin(&pin),
            Err(VaultError::RateLimited { .. })
        ));
    }

    #[test]
    fn device_unlock_round_trip() {
        let (_dir, vault) = vault();
        let pin = hash_pin("123456").unwrap();
        vault.create(&pin, true).unwrap();
        vault.add_credential(credential(2, "example.com")).unwrap();
        vault.lock();
        vault.unlock_with_device().unwrap();
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn changing_the_pin_keeps_credentials() {
        let (_dir, vault) = vault();
        let pin = hash_pin("123456").unwrap();
        vault.create(&pin, false).unwrap();
        vault.add_credential(credential(3, "example.com")).unwrap();
        let new_pin = hash_pin("abcdef").unwrap();
        vault.change_pin(&new_pin).unwrap();
        vault.lock();
        assert_eq!(vault.unlock_with_pin(&pin), Err(VaultError::AuthFailed));
        vault.unlock_with_pin(&new_pin).unwrap();
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_credential_persists() {
        let (_dir, vault) = vault();
        let pin = hash_pin("123456").unwrap();
        vault.create(&pin, false).unwrap();
        vault.add_credential(credential(4, "example.com")).unwrap();
        assert!(vault.delete(&[4u8; 32]).unwrap());
        assert!(!vault.delete(&[4u8; 32]).unwrap());
        assert!(vault.list().unwrap().is_empty());
    }

    #[test]
    fn creating_twice_is_refused() {
        let (_dir, vault) = vault();
        let pin = hash_pin("123456").unwrap();
        vault.create(&pin, false).unwrap();
        assert_eq!(
            vault.create(&pin, false),
            Err(VaultError::AlreadyInitialized)
        );
    }

    #[test]
    fn a_corrupt_file_is_not_mistaken_for_an_empty_vault() {
        let (dir, vault) = vault();
        let pin = hash_pin("123456").unwrap();
        vault.create(&pin, false).unwrap();
        vault.lock();
        let path = dir.path().join("vault.json");
        let mut bytes = fs::read(&path).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0x40;
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            vault.unlock_with_pin(&pin),
            Err(VaultError::Invalid) | Err(VaultError::AuthFailed)
        ));
    }
}
