//! Mount an S3-compatible bucket as a read-only folder on the local machine.
//!
//! The app starts a small NFSv3 server on `127.0.0.1` backed by the bucket and
//! then asks the operating system's built-in NFS client to mount it. That keeps
//! the feature driver-free on macOS, Linux and Windows — no macFUSE kernel
//! extension and no WinFsp installer.
//!
//! - `nfs_fs`: the read-only bucket filesystem exposed over NFS
//! - `manager`: mount lifecycle and the OS mount/unmount calls
//! - `platform`: per-OS command construction

mod manager;
mod nfs_fs;
mod platform;

pub use manager::{manager, MountInfo, MountProvider, MountRequest};
