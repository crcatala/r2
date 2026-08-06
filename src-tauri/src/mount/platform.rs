//! Per-OS NFS client command construction.
//!
//! The mount itself is performed by the operating system's built-in NFSv3
//! client talking to the localhost server started by [`crate::mount::manager`].
//! Every command is built here as a pure `argv` vector so the exact flags are
//! unit-testable for all three platforms regardless of the build host.

/// Operating systems with a built-in NFSv3 client we can drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MountPlatform {
    MacOs,
    Linux,
    Windows,
}

impl MountPlatform {
    /// The platform this binary was compiled for.
    pub const CURRENT: MountPlatform = if cfg!(target_os = "macos") {
        MountPlatform::MacOs
    } else if cfg!(windows) {
        MountPlatform::Windows
    } else {
        MountPlatform::Linux
    };
}

/// NFS client options for the unix mount commands. `actimeo` keeps attribute
/// lookups off the network for two minutes, which matters a lot when every
/// miss is an S3 round trip.
fn unix_options(port: u16) -> String {
    format!(
        "vers=3,tcp,rsize=131072,actimeo=120,port={port},mountport={port}",
        port = port
    )
}

/// Command that mounts the localhost NFS server listening on `port` at `target`.
///
/// `target` is a directory path on macOS/Linux and a drive specifier such as
/// `Z:` on Windows.
pub fn mount_argv(platform: MountPlatform, port: u16, target: &str) -> Vec<String> {
    match platform {
        MountPlatform::MacOs => vec![
            "/sbin/mount_nfs".to_string(),
            "-o".to_string(),
            format!("nolocks,{}", unix_options(port)),
            "localhost:/".to_string(),
            target.to_string(),
        ],
        MountPlatform::Linux => vec![
            "mount.nfs".to_string(),
            "-o".to_string(),
            format!("user,noacl,nolock,{}", unix_options(port)),
            "localhost:/".to_string(),
            target.to_string(),
        ],
        // The Windows NFS client has no `port=` option — it resolves the server
        // through the portmapper, so it only reaches a server on the standard
        // ports. Kept identical to the upstream nfsserve recipe.
        MountPlatform::Windows => vec![
            "mount.exe".to_string(),
            "-o".to_string(),
            "anon,nolock,mtype=soft,fileaccess=6,casesensitive,lang=ansi,rsize=128,wsize=128,timeout=60,retry=2".to_string(),
            r"\\127.0.0.1\".to_string(),
            target.to_string(),
        ],
    }
}

/// Unmount commands to try in order; the first one that exits 0 wins.
pub fn umount_argvs(platform: MountPlatform, target: &str) -> Vec<Vec<String>> {
    match platform {
        MountPlatform::MacOs => vec![
            vec!["umount".to_string(), target.to_string()],
            vec![
                "diskutil".to_string(),
                "unmount".to_string(),
                target.to_string(),
            ],
            vec!["umount".to_string(), "-f".to_string(), target.to_string()],
        ],
        MountPlatform::Linux => vec![
            vec!["umount".to_string(), target.to_string()],
            vec!["umount".to_string(), "-l".to_string(), target.to_string()],
        ],
        MountPlatform::Windows => vec![
            vec!["umount".to_string(), target.to_string()],
            vec!["umount".to_string(), "-f".to_string(), target.to_string()],
        ],
    }
}

/// Copy-pasteable mount command shown to the user when the automatic mount
/// fails. Linux distributions commonly require root for `mount.nfs`, so the
/// suggestion is prefixed with `sudo` there.
pub fn manual_mount_command(platform: MountPlatform, port: u16, target: &str) -> String {
    let argv = mount_argv(platform, port, target);
    let rendered = argv
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");

    match platform {
        MountPlatform::Linux => format!("sudo {}", rendered),
        _ => rendered,
    }
}

/// POSIX single-quote escaping so a path with spaces survives copy-paste.
fn shell_quote(arg: &str) -> String {
    let safe = !arg.is_empty()
        && arg.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | ',' | '=' | '@')
        });
    if safe {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

/// Normalizes a Windows mount target to the bare `X:` drive specifier the NFS
/// client expects, rejecting anything that is not a drive letter.
///
/// Compiled on all platforms during tests so the parsing rules stay covered on
/// the macOS/Linux CI runners too.
#[cfg(any(windows, test))]
pub fn normalize_drive_spec(target: &str) -> Option<String> {
    let trimmed = target.trim().trim_end_matches(['/', '\\']);
    let mut chars = trimmed.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() || chars.next() != Some(':') || chars.next().is_some() {
        return None;
    }
    Some(format!("{}:", letter.to_ascii_uppercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_mount_uses_nolocks_and_both_ports() {
        let argv = mount_argv(MountPlatform::MacOs, 51234, "/Users/me/CloudMounts/photos");
        assert_eq!(
            argv,
            vec![
                "/sbin/mount_nfs",
                "-o",
                "nolocks,vers=3,tcp,rsize=131072,actimeo=120,port=51234,mountport=51234",
                "localhost:/",
                "/Users/me/CloudMounts/photos",
            ]
        );
    }

    #[test]
    fn linux_mount_requests_user_mount() {
        let argv = mount_argv(MountPlatform::Linux, 9, "/mnt/photos");
        assert_eq!(argv[0], "mount.nfs");
        assert!(argv[2].starts_with("user,noacl,nolock,"));
        assert!(argv[2].ends_with("port=9,mountport=9"));
        assert_eq!(argv[3], "localhost:/");
        assert_eq!(argv[4], "/mnt/photos");
    }

    #[test]
    fn windows_mount_targets_the_loopback_unc_share() {
        let argv = mount_argv(MountPlatform::Windows, 2049, "Z:");
        assert_eq!(
            argv,
            vec![
                "mount.exe",
                "-o",
                "anon,nolock,mtype=soft,fileaccess=6,casesensitive,lang=ansi,rsize=128,wsize=128,timeout=60,retry=2",
                r"\\127.0.0.1\",
                "Z:",
            ]
        );
    }

    #[test]
    fn umount_falls_back_after_the_plain_attempt() {
        let macos = umount_argvs(MountPlatform::MacOs, "/tmp/m");
        assert_eq!(macos[0], vec!["umount", "/tmp/m"]);
        assert_eq!(macos[1], vec!["diskutil", "unmount", "/tmp/m"]);

        let linux = umount_argvs(MountPlatform::Linux, "/tmp/m");
        assert_eq!(linux[0], vec!["umount", "/tmp/m"]);
        assert_eq!(linux[1], vec!["umount", "-l", "/tmp/m"]);
    }

    #[test]
    fn manual_command_is_sudo_prefixed_only_on_linux() {
        let linux = manual_mount_command(MountPlatform::Linux, 42, "/mnt/photos");
        assert!(linux.starts_with("sudo mount.nfs -o "));

        let macos = manual_mount_command(MountPlatform::MacOs, 42, "/tmp/m");
        assert!(macos.starts_with("/sbin/mount_nfs -o "));
        assert!(!macos.contains("sudo"));
    }

    #[test]
    fn manual_command_quotes_paths_with_spaces() {
        let cmd = manual_mount_command(MountPlatform::MacOs, 1, "/Users/me/My Drive");
        assert!(cmd.ends_with("'/Users/me/My Drive'"), "{}", cmd);
    }

    #[test]
    fn drive_specs_are_normalized_and_validated() {
        assert_eq!(normalize_drive_spec("z:").as_deref(), Some("Z:"));
        assert_eq!(normalize_drive_spec("Z:\\").as_deref(), Some("Z:"));
        assert_eq!(normalize_drive_spec(" Z:/ ").as_deref(), Some("Z:"));
        assert_eq!(normalize_drive_spec("Z:\\mnt"), None);
        assert_eq!(normalize_drive_spec("/mnt/photos"), None);
        assert_eq!(normalize_drive_spec(""), None);
        assert_eq!(normalize_drive_spec("1:"), None);
    }
}
