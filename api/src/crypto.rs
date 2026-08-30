//! Encryption for user-supplied AI provider API keys.
//!
//! Keys are never stored in plaintext. AES-256-GCM with a random nonce per
//! encryption; the server-side master key comes from `INK_GATEWAY_MASTER_KEY`
//! (base64, 32 bytes) — never committed, never logged, generated once per
//! deployment (`openssl rand -base64 32`). Losing the master key means every
//! stored provider key must be re-entered — that's the intended trade-off
//! over a weaker, recoverable scheme.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

#[derive(Debug)]
pub struct Cipher {
    cipher: Aes256Gcm,
}

impl Cipher {
    pub fn from_env() -> Result<Self> {
        let key_b64 = std::env::var("INK_GATEWAY_MASTER_KEY").context(
            "INK_GATEWAY_MASTER_KEY is not set — required to encrypt stored provider API keys. \
             Generate one with `openssl rand -base64 32`.",
        )?;
        let key_bytes = STANDARD
            .decode(key_b64.trim())
            .context("INK_GATEWAY_MASTER_KEY must be valid base64")?;
        Self::from_key_bytes(&key_bytes)
    }

    fn from_key_bytes(key_bytes: &[u8]) -> Result<Self> {
        if key_bytes.len() != 32 {
            bail!(
                "INK_GATEWAY_MASTER_KEY must decode to exactly 32 bytes (got {}); \
                 generate one with `openssl rand -base64 32`",
                key_bytes.len()
            );
        }
        let cipher = Aes256Gcm::new_from_slice(key_bytes)
            .map_err(|e| anyhow::anyhow!("invalid master key: {e}"))?;
        Ok(Self { cipher })
    }

    /// Encrypts `plaintext`, returning base64(nonce || ciphertext).
    pub fn encrypt(&self, plaintext: &str) -> Result<String> {
        let nonce_bytes: [u8; 12] = rand::random();
        let nonce = Nonce::from(nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|e| anyhow::anyhow!("encryption failed: {e}"))?;
        let mut combined = nonce_bytes.to_vec();
        combined.extend_from_slice(&ciphertext);
        Ok(STANDARD.encode(combined))
    }

    /// Decrypts a value produced by `encrypt`.
    pub fn decrypt(&self, stored: &str) -> Result<String> {
        let combined = STANDARD
            .decode(stored)
            .context("invalid stored ciphertext")?;
        if combined.len() < 12 {
            bail!("stored ciphertext too short");
        }
        let (nonce_bytes, ciphertext) = combined.split_at(12);
        let nonce =
            Nonce::try_from(nonce_bytes).map_err(|_| anyhow::anyhow!("bad nonce length"))?;
        let plaintext = self
            .cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|e| anyhow::anyhow!("decryption failed (wrong master key?): {e}"))?;
        String::from_utf8(plaintext).context("decrypted key is not valid utf-8")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cipher() -> Cipher {
        Cipher::from_key_bytes(&[0u8; 32]).unwrap()
    }

    #[test]
    fn encrypt_then_decrypt_roundtrips() {
        let cipher = test_cipher();
        let encrypted = cipher.encrypt("sk-ant-super-secret-key").unwrap();
        assert_ne!(encrypted, "sk-ant-super-secret-key");
        assert_eq!(
            cipher.decrypt(&encrypted).unwrap(),
            "sk-ant-super-secret-key"
        );
    }

    #[test]
    fn encrypting_the_same_plaintext_twice_yields_different_ciphertext() {
        // Random nonce per call — never store the same ciphertext twice, even
        // for identical keys, so ciphertexts can't be compared to fingerprint keys.
        let cipher = test_cipher();
        let a = cipher.encrypt("same-key").unwrap();
        let b = cipher.encrypt("same-key").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_master_key_of_wrong_length() {
        let err = Cipher::from_key_bytes(&[0u8; 16]).unwrap_err();
        assert!(err.to_string().contains("32 bytes"));
    }
}
