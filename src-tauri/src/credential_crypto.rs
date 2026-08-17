//! Encryption for credentials persisted in the local database.
//!
//! The database only stores versioned ciphertext. The 256-bit data encryption
//! key (DEK) is kept in the platform credential store, never in SQLite.
use std::sync::{LazyLock, Mutex};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use zeroize::Zeroize;

pub const LEGACY_FORMAT: i64 = 0;
pub const ENCRYPTED_V1_FORMAT: i64 = 1;
const DEK_SERVICE: &str = "com.cloudflare.r2-client.credential-encryption";
const DEK_ACCOUNT: &str = "installation-dek-v1";
const NONCE_LEN: usize = 24;
const DEK_LEN: usize = 32;

// Serialize key creation inside the application. Keyring implementations make
// writes atomic; re-reading after a write also makes concurrent first writers
// converge on the entry that actually survived.
static DEK_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn credential_error(message: &'static str) -> Box<dyn std::error::Error + Send + Sync> {
    message.into()
}

fn aad(provider: &str, record_id: &str, field: &str) -> Vec<u8> {
    format!("v1|{provider}|{record_id}|{field}").into_bytes()
}

fn entry() -> Result<keyring::Entry, Box<dyn std::error::Error + Send + Sync>> {
    keyring::Entry::new(DEK_SERVICE, DEK_ACCOUNT).map_err(|_| {
        credential_error(
            "Secure credential storage is unavailable or locked. Unlock it and try again.",
        )
    })
}

/// Gets the installation key. A new key is created only before *any* encrypted
/// database record exists. This is what distinguishes a new install from a
/// restored database whose matching keychain entry was lost.
fn dek(
    has_encrypted_records: bool,
) -> Result<[u8; DEK_LEN], Box<dyn std::error::Error + Send + Sync>> {
    let _guard = DEK_LOCK
        .lock()
        .map_err(|_| credential_error("Credential key lock failed"))?;
    let entry = entry()?;
    match entry.get_secret() {
        Ok(secret) => secret.as_slice().try_into().map_err(|_| {
            credential_error("Credential encryption key is invalid. Re-enter saved credentials.")
        }),
        Err(keyring::Error::NoEntry) if !has_encrypted_records => {
            let mut key = [0u8; DEK_LEN];
            rand::rng().fill_bytes(&mut key);
            entry.set_secret(&key).map_err(|_| credential_error("Unable to save the credential encryption key. Check your system keychain and try again."))?;
            // Read back the stored value so a racing first writer cannot leave
            // this process using a different DEK.
            let stored = entry.get_secret().map_err(|_| {
                credential_error("Unable to verify the credential encryption key. Try again.")
            })?;
            key.zeroize();
            stored.as_slice().try_into().map_err(|_| {
                credential_error(
                    "Credential encryption key is invalid. Re-enter saved credentials.",
                )
            })
        }
        Err(keyring::Error::NoEntry) => Err(credential_error(
            "The credential encryption key is missing. Re-enter saved credentials to recover.",
        )),
        Err(_) => Err(credential_error(
            "Secure credential storage is unavailable or locked. Unlock it and try again.",
        )),
    }
}

pub fn encrypt(
    plaintext: &str,
    provider: &str,
    record_id: &str,
    field: &str,
    has_encrypted_records: bool,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let mut key = dek(has_encrypted_records)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|_| credential_error("Unable to initialize credential encryption"))?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            &XNonce::try_from(nonce.as_slice())
                .map_err(|_| credential_error("Unable to initialize credential encryption"))?,
            Payload {
                msg: plaintext.as_bytes(),
                aad: &aad(provider, record_id, field),
            },
        )
        .map_err(|_| credential_error("Unable to encrypt credential"))?;
    key.zeroize();
    let mut encoded = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    encoded.push(ENCRYPTED_V1_FORMAT as u8);
    encoded.extend_from_slice(&nonce);
    encoded.extend_from_slice(&ciphertext);
    Ok(URL_SAFE_NO_PAD.encode(encoded))
}

pub fn decrypt(
    value: &str,
    format: i64,
    provider: &str,
    record_id: &str,
    field: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if format == LEGACY_FORMAT {
        return Ok(value.to_string());
    }
    if format != ENCRYPTED_V1_FORMAT {
        return Err(credential_error(
            "Unsupported credential storage format. Re-enter saved credentials.",
        ));
    }
    let raw = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        credential_error("Stored credential is corrupted. Re-enter saved credentials.")
    })?;
    if raw.len() <= 1 + NONCE_LEN || raw[0] != ENCRYPTED_V1_FORMAT as u8 {
        return Err(credential_error(
            "Stored credential is corrupted. Re-enter saved credentials.",
        ));
    }
    let mut key = dek(true)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|_| credential_error("Unable to initialize credential encryption"))?;
    let plaintext = cipher
        .decrypt(
            &XNonce::try_from(&raw[1..1 + NONCE_LEN]).map_err(|_| {
                credential_error("Stored credential is corrupted. Re-enter saved credentials.")
            })?,
            Payload {
                msg: &raw[1 + NONCE_LEN..],
                aad: &aad(provider, record_id, field),
            },
        )
        .map_err(|_| {
            credential_error(
                "Stored credential cannot be authenticated. Re-enter saved credentials.",
            )
        })?;
    key.zeroize();
    String::from_utf8(plaintext).map_err(|_| {
        credential_error("Stored credential is corrupted. Re-enter saved credentials.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt_with_key(
        key: &[u8; DEK_LEN],
        value: &str,
        provider: &str,
        id: &str,
        field: &str,
        nonce: [u8; NONCE_LEN],
    ) -> String {
        let cipher = XChaCha20Poly1305::new_from_slice(key).unwrap();
        let ciphertext = cipher
            .encrypt(
                &XNonce::try_from(nonce.as_slice()).unwrap(),
                Payload {
                    msg: value.as_bytes(),
                    aad: &aad(provider, id, field),
                },
            )
            .unwrap();
        let mut encoded = vec![ENCRYPTED_V1_FORMAT as u8];
        encoded.extend_from_slice(&nonce);
        encoded.extend_from_slice(&ciphertext);
        URL_SAFE_NO_PAD.encode(encoded)
    }

    #[test]
    fn format_contains_version_and_unique_nonce_material() {
        let key = [7u8; DEK_LEN];
        let a = encrypt_with_key(
            &key,
            "secret",
            "aws",
            "id",
            "secret_access_key",
            [1; NONCE_LEN],
        );
        let b = encrypt_with_key(
            &key,
            "secret",
            "aws",
            "id",
            "secret_access_key",
            [2; NONCE_LEN],
        );
        assert_ne!(a, b);
        assert_eq!(
            URL_SAFE_NO_PAD.decode(a).unwrap()[0],
            ENCRYPTED_V1_FORMAT as u8
        );
    }

    #[test]
    fn aad_mismatch_and_tampering_fail_authentication() {
        let key = [9u8; DEK_LEN];
        let encoded = encrypt_with_key(
            &key,
            "secret",
            "aws",
            "id",
            "secret_access_key",
            [3; NONCE_LEN],
        );
        let mut raw = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
        assert!(cipher
            .decrypt(
                &XNonce::try_from(&raw[1..1 + NONCE_LEN]).unwrap(),
                Payload {
                    msg: &raw[1 + NONCE_LEN..],
                    aad: &aad("aws", "other", "secret_access_key")
                }
            )
            .is_err());
        *raw.last_mut().unwrap() ^= 1;
        assert!(cipher
            .decrypt(
                &XNonce::try_from(&raw[1..1 + NONCE_LEN]).unwrap(),
                Payload {
                    msg: &raw[1 + NONCE_LEN..],
                    aad: &aad("aws", "id", "secret_access_key")
                }
            )
            .is_err());
    }

    #[test]
    fn legacy_values_are_dispatched_without_keychain_access() {
        assert_eq!(
            decrypt("old-value", LEGACY_FORMAT, "aws", "id", "secret_access_key").unwrap(),
            "old-value"
        );
    }
}
