# Saved credential storage

R2 Client protects **newly saved** R2, AWS, MinIO, and RustFS credential values at rest. It does not protect credentials while they are being used by the running application or sent to the Tauri backend for an operation.

Each installation has a random 256-bit data-encryption key (DEK). The DEK is stored only in the platform credential store:

- macOS: Keychain Services
- Windows: Windows Credential Manager
- Linux: the Freedesktop Secret Service (for example GNOME Keyring or KWallet) over the user session D-Bus

SQLite stores a versioned XChaCha20-Poly1305 ciphertext with a fresh nonce for every field write. Ciphertexts are bound to the provider, immutable record ID, and field name, preventing a value from being moved between credential records.

## Linux requirements

A running, unlocked Secret Service provider and a user session D-Bus are required to save or use encrypted credentials. The app fails closed if they are unavailable; it never saves a plaintext fallback. Linux packages must include the runtime dependencies required by the selected desktop/keyring implementation and manual release validation must cover a clean user session, a locked keyring, and an unavailable D-Bus/keyring.

## Backup, recovery, and deletion

A database backup must be restored alongside access to the same OS credential-store entry. If encrypted rows exist but the DEK is missing, corrupted, locked, or inaccessible, credentials cannot be recovered: re-enter them to create new encrypted records.

Removing an account or token removes its active credential row. SQLite pages, WAL/journal files, backups, and copied database files are not guaranteed to be securely or forensically erased. Rotate credentials if prior plaintext exposure is suspected.
