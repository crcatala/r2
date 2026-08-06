//! Read-only NFSv3 view of an S3-compatible bucket.
//!
//! Object storage has no directories, so the tree is synthesized from
//! `ListObjectsV2` with `delimiter="/"`: common prefixes become directories and
//! the remaining keys become files. Every path the client has seen is assigned a
//! stable `fileid3` for the lifetime of the mount, because NFS file handles are
//! opaque ids the client may hold on to indefinitely.

use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use aws_sdk_s3::Client;
use nfsserve::nfs::{
    fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, specdata3,
};
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};

/// Reserved root id. `0` is reserved by the protocol and must never be used.
const ROOT_ID: fileid3 = 1;
/// How long a directory listing is served before it is re-fetched from S3.
const DIR_CACHE_TTL: Duration = Duration::from_secs(30);
const LIST_PAGE_SIZE: i32 = 1000;
/// Synthetic size reported for directories, matching a typical unix filesystem.
const DIR_SIZE: u64 = 4096;
const DIR_MODE: u32 = 0o755;
const FILE_MODE: u32 = 0o644;

// ============ Key helpers (pure) ============

/// Normalizes a directory key to the form used as a `ListObjectsV2` prefix:
/// the bucket root is `""` and every other directory ends with `/`.
fn normalize_dir_key(key: &str) -> String {
    let key = key.strip_prefix('/').unwrap_or(key);
    if key.is_empty() {
        String::new()
    } else if key.ends_with('/') {
        key.to_string()
    } else {
        format!("{}/", key)
    }
}

/// Last path component of a key. Directory keys carry a trailing slash that is
/// not part of the name.
fn entry_name(key: &str) -> &str {
    let trimmed = key.strip_suffix('/').unwrap_or(key);
    match trimmed.rfind('/') {
        Some(idx) => &trimmed[idx + 1..],
        None => trimmed,
    }
}

/// Key of `name` inside the directory `dir_key` (which is `""` or ends with `/`).
fn child_key(dir_key: &str, name: &str, is_dir: bool) -> String {
    let mut key = String::with_capacity(dir_key.len() + name.len() + 1);
    key.push_str(dir_key);
    key.push_str(name);
    if is_dir {
        key.push('/');
    }
    key
}

/// Where a `readdir` continuation resumes in a name-sorted child list.
///
/// The cursor is resolved by name rather than by position so a directory that
/// was re-listed between two `readdir` calls still resumes at the right place,
/// even if the entry the client last saw has since been deleted.
fn resume_index(children: &[DirChild], after_name: Option<&str>) -> usize {
    match after_name {
        None => 0,
        Some(name) => children.partition_point(|child| child.name.as_str() <= name),
    }
}

/// End index of the `readdir` page starting at `start`, and whether it reaches
/// the end of the directory.
///
/// `max_entries` is clamped to at least one entry: a page of nothing that is
/// not flagged as the end would make the client re-issue the same cookie
/// forever.
fn page_end(total: usize, start: usize, max_entries: usize) -> (usize, bool) {
    let end = start.saturating_add(max_entries.max(1)).min(total);
    (end, end >= total)
}

// ============ Inode table ============

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone)]
struct Inode {
    key: String,
    parent: fileid3,
    kind: EntryKind,
    size: u64,
    mtime_secs: u32,
}

/// Bidirectional key ↔ id map. Ids are handed out monotonically and never
/// reused or evicted, so a file handle stays valid for the whole session.
struct InodeTable {
    next_id: fileid3,
    by_id: HashMap<fileid3, Inode>,
    by_key: HashMap<String, fileid3>,
}

impl InodeTable {
    fn new() -> Self {
        let root = Inode {
            key: String::new(),
            parent: ROOT_ID,
            kind: EntryKind::Dir,
            size: DIR_SIZE,
            mtime_secs: 0,
        };
        let mut by_id = HashMap::new();
        by_id.insert(ROOT_ID, root);
        let mut by_key = HashMap::new();
        by_key.insert(String::new(), ROOT_ID);

        Self {
            next_id: ROOT_ID + 1,
            by_id,
            by_key,
        }
    }

    /// Returns the stable id of `key`, allocating one the first time it is seen
    /// and refreshing the cached attributes on every later sighting.
    fn intern(
        &mut self,
        key: &str,
        parent: fileid3,
        kind: EntryKind,
        size: u64,
        mtime_secs: u32,
    ) -> fileid3 {
        if let Some(&id) = self.by_key.get(key) {
            if let Some(entry) = self.by_id.get_mut(&id) {
                entry.parent = parent;
                entry.kind = kind;
                entry.size = size;
                entry.mtime_secs = mtime_secs;
            }
            return id;
        }

        let id = self.next_id;
        self.next_id += 1;
        self.by_id.insert(
            id,
            Inode {
                key: key.to_string(),
                parent,
                kind,
                size,
                mtime_secs,
            },
        );
        self.by_key.insert(key.to_string(), id);
        id
    }

    fn get(&self, id: fileid3) -> Option<&Inode> {
        self.by_id.get(&id)
    }
}

// ============ Directory cache ============

#[derive(Debug, Clone)]
struct DirChild {
    fileid: fileid3,
    name: String,
}

struct DirListing {
    children: Arc<Vec<DirChild>>,
    fetched_at: Instant,
}

// ============ Filesystem ============

pub struct S3NfsFs {
    client: Client,
    bucket: String,
    inodes: RwLock<InodeTable>,
    dirs: RwLock<HashMap<fileid3, DirListing>>,
    uid: u32,
    gid: u32,
    fsid: u64,
}

impl S3NfsFs {
    pub fn new(client: Client, bucket: String) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        bucket.hash(&mut hasher);
        let fsid = hasher.finish();

        Self {
            client,
            bucket,
            inodes: RwLock::new(InodeTable::new()),
            dirs: RwLock::new(HashMap::new()),
            uid: current_uid(),
            gid: current_gid(),
            fsid,
        }
    }

    fn inode(&self, id: fileid3) -> Result<Inode, nfsstat3> {
        self.inodes
            .read()
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?
            .get(id)
            .cloned()
            .ok_or(nfsstat3::NFS3ERR_NOENT)
    }

    fn dir_inode(&self, id: fileid3) -> Result<Inode, nfsstat3> {
        let inode = self.inode(id)?;
        if inode.kind != EntryKind::Dir {
            return Err(nfsstat3::NFS3ERR_NOTDIR);
        }
        Ok(inode)
    }

    fn attr_of(&self, id: fileid3, inode: &Inode) -> fattr3 {
        let (ftype, mode, nlink, size) = match inode.kind {
            EntryKind::Dir => (ftype3::NF3DIR, DIR_MODE, 2, DIR_SIZE),
            EntryKind::File => (ftype3::NF3REG, FILE_MODE, 1, inode.size),
        };
        let time = nfstime3 {
            seconds: inode.mtime_secs,
            nseconds: 0,
        };

        fattr3 {
            ftype,
            mode,
            nlink,
            uid: self.uid,
            gid: self.gid,
            size,
            used: size,
            rdev: specdata3 {
                specdata1: 0,
                specdata2: 0,
            },
            fsid: self.fsid,
            fileid: id,
            atime: time,
            mtime: time,
            ctime: time,
        }
    }

    /// Cached children of `dirid`, re-listing from S3 once the entry is older
    /// than [`DIR_CACHE_TTL`].
    async fn children_of(
        &self,
        dirid: fileid3,
        dir_key: &str,
    ) -> Result<Arc<Vec<DirChild>>, nfsstat3> {
        if let Ok(dirs) = self.dirs.read() {
            if let Some(listing) = dirs.get(&dirid) {
                if listing.fetched_at.elapsed() < DIR_CACHE_TTL {
                    return Ok(listing.children.clone());
                }
            }
        }

        self.list_dir(dirid, dir_key).await
    }

    /// Lists one directory level and registers an inode for every child.
    async fn list_dir(
        &self,
        dirid: fileid3,
        dir_key: &str,
    ) -> Result<Arc<Vec<DirChild>>, nfsstat3> {
        // BTreeMap gives the deterministic, name-sorted ordering readdir needs.
        let mut entries: BTreeMap<String, (EntryKind, u64, u32)> = BTreeMap::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut request = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .delimiter("/")
                .max_keys(LIST_PAGE_SIZE);

            if !dir_key.is_empty() {
                request = request.prefix(dir_key);
            }
            if let Some(token) = &continuation_token {
                request = request.continuation_token(token);
            }

            let response = request.send().await.map_err(|e| {
                log::error!("mount: failed to list \"{}\": {}", dir_key, e);
                nfsstat3::NFS3ERR_IO
            })?;

            for prefix in response.common_prefixes() {
                let Some(prefix) = prefix.prefix() else {
                    continue;
                };
                let name = entry_name(prefix);
                if name.is_empty() {
                    continue;
                }
                // A directory always wins over an object with the same name so
                // the subtree underneath it stays reachable.
                entries.insert(name.to_string(), (EntryKind::Dir, DIR_SIZE, 0));
            }

            for object in response.contents() {
                let Some(key) = object.key() else {
                    continue;
                };
                // The prefix itself and any other explicit folder marker are
                // already represented as directories.
                if key == dir_key || key.ends_with('/') {
                    continue;
                }
                let name = entry_name(key);
                if name.is_empty() {
                    continue;
                }
                let size = object.size().unwrap_or(0).max(0) as u64;
                let mtime = object
                    .last_modified()
                    .map(|time| time.secs())
                    .unwrap_or_default();
                let mtime = u32::try_from(mtime.max(0)).unwrap_or(u32::MAX);
                entries
                    .entry(name.to_string())
                    .or_insert((EntryKind::File, size, mtime));
            }

            if !response.is_truncated().unwrap_or(false) {
                break;
            }
            continuation_token = response.next_continuation_token().map(str::to_string);
            if continuation_token.is_none() {
                break;
            }
        }

        let children = {
            let mut inodes = self
                .inodes
                .write()
                .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
            entries
                .into_iter()
                .map(|(name, (kind, size, mtime))| {
                    let key = child_key(dir_key, &name, kind == EntryKind::Dir);
                    let fileid = inodes.intern(&key, dirid, kind, size, mtime);
                    DirChild { fileid, name }
                })
                .collect::<Vec<_>>()
        };

        let children = Arc::new(children);
        if let Ok(mut dirs) = self.dirs.write() {
            dirs.insert(
                dirid,
                DirListing {
                    children: children.clone(),
                    fetched_at: Instant::now(),
                },
            );
        }

        Ok(children)
    }

    /// Resolves a name the cached listing does not contain by asking S3
    /// directly, which covers objects written after the listing was taken.
    async fn lookup_uncached(
        &self,
        dirid: fileid3,
        dir_key: &str,
        name: &str,
    ) -> Result<fileid3, nfsstat3> {
        let key = child_key(dir_key, name, false);
        let head = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
            .map_err(|_| nfsstat3::NFS3ERR_NOENT)?;

        let size = head.content_length().unwrap_or(0).max(0) as u64;
        let mtime = head
            .last_modified()
            .map(|time| time.secs())
            .unwrap_or_default();
        let mtime = u32::try_from(mtime.max(0)).unwrap_or(u32::MAX);

        let mut inodes = self
            .inodes
            .write()
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
        Ok(inodes.intern(&key, dirid, EntryKind::File, size, mtime))
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: getuid is always safe to call and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(unix)]
fn current_gid() -> u32 {
    // SAFETY: getgid is always safe to call and cannot fail.
    unsafe { libc::getgid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

#[cfg(not(unix))]
fn current_gid() -> u32 {
    0
}

#[async_trait]
impl NFSFileSystem for S3NfsFs {
    fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadOnly
    }

    fn root_dir(&self) -> fileid3 {
        ROOT_ID
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let dir = self.dir_inode(dirid)?;
        let name = std::str::from_utf8(filename).map_err(|_| nfsstat3::NFS3ERR_NOENT)?;

        if name.is_empty() || name == "." {
            return Ok(dirid);
        }
        if name == ".." {
            return Ok(dir.parent);
        }

        let dir_key = normalize_dir_key(&dir.key);
        let children = self.children_of(dirid, &dir_key).await?;
        if let Some(child) = children.iter().find(|child| child.name == name) {
            return Ok(child.fileid);
        }

        self.lookup_uncached(dirid, &dir_key, name).await
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let inode = self.inode(id)?;
        Ok(self.attr_of(id, &inode))
    }

    async fn setattr(&self, _id: fileid3, _setattr: sattr3) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn read(
        &self,
        id: fileid3,
        offset: u64,
        count: u32,
    ) -> Result<(Vec<u8>, bool), nfsstat3> {
        let inode = self.inode(id)?;
        if inode.kind != EntryKind::File {
            return Err(nfsstat3::NFS3ERR_ISDIR);
        }

        if offset >= inode.size || count == 0 {
            return Ok((Vec::new(), offset >= inode.size));
        }

        let last = offset
            .saturating_add(u64::from(count))
            .min(inode.size)
            .saturating_sub(1);
        let range = format!("bytes={}-{}", offset, last);

        let response = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&inode.key)
            .range(range)
            .send()
            .await
            .map_err(|e| {
                log::error!("mount: failed to read \"{}\": {}", inode.key, e);
                nfsstat3::NFS3ERR_IO
            })?;

        let data = response
            .body
            .collect()
            .await
            .map_err(|e| {
                log::error!("mount: failed to buffer \"{}\": {}", inode.key, e);
                nfsstat3::NFS3ERR_IO
            })?
            .into_bytes()
            .to_vec();

        let eof = offset.saturating_add(data.len() as u64) >= inode.size;
        Ok((data, eof))
    }

    async fn write(&self, _id: fileid3, _offset: u64, _data: &[u8]) -> Result<fattr3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn create(
        &self,
        _dirid: fileid3,
        _filename: &filename3,
        _attr: sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn create_exclusive(
        &self,
        _dirid: fileid3,
        _filename: &filename3,
    ) -> Result<fileid3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn mkdir(
        &self,
        _dirid: fileid3,
        _dirname: &filename3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn remove(&self, _dirid: fileid3, _filename: &filename3) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn rename(
        &self,
        _from_dirid: fileid3,
        _from_filename: &filename3,
        _to_dirid: fileid3,
        _to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        Err(nfsstat3::NFS3ERR_ROFS)
    }

    async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let dir = self.dir_inode(dirid)?;
        let dir_key = normalize_dir_key(&dir.key);
        let children = self.children_of(dirid, &dir_key).await?;

        let after_name = if start_after == 0 {
            None
        } else {
            // An unknown cookie is the one case we cannot interpret at all.
            let inode = self
                .inode(start_after)
                .map_err(|_| nfsstat3::NFS3ERR_BAD_COOKIE)?;
            Some(entry_name(&inode.key).to_string())
        };

        let start = resume_index(&children, after_name.as_deref());
        let (end, is_last_page) = page_end(children.len(), start, max_entries);

        let mut entries = Vec::with_capacity(end.saturating_sub(start));
        for child in &children[start..end] {
            let inode = self.inode(child.fileid)?;
            entries.push(DirEntry {
                fileid: child.fileid,
                name: child.name.as_bytes().into(),
                attr: self.attr_of(child.fileid, &inode),
            });
        }

        Ok(ReadDirResult {
            entries,
            end: is_last_page,
        })
    }

    async fn symlink(
        &self,
        _dirid: fileid3,
        _linkname: &filename3,
        _symlink: &nfspath3,
        _attr: &sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn readlink(&self, _id: fileid3) -> Result<nfspath3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(fileid: fileid3, name: &str) -> DirChild {
        DirChild {
            fileid,
            name: name.to_string(),
        }
    }

    // ---- key normalization ----

    #[test]
    fn root_normalizes_to_the_empty_prefix() {
        assert_eq!(normalize_dir_key(""), "");
        assert_eq!(normalize_dir_key("/"), "");
    }

    #[test]
    fn directory_keys_always_end_with_a_single_slash() {
        assert_eq!(normalize_dir_key("photos"), "photos/");
        assert_eq!(normalize_dir_key("photos/"), "photos/");
        assert_eq!(normalize_dir_key("/photos"), "photos/");
        assert_eq!(normalize_dir_key("a/b/c"), "a/b/c/");
        assert_eq!(normalize_dir_key("a/b/c/"), "a/b/c/");
    }

    #[test]
    fn entry_names_drop_the_parent_path_and_trailing_slash() {
        assert_eq!(entry_name("photos/"), "photos");
        assert_eq!(entry_name("a/b/c/"), "c");
        assert_eq!(entry_name("a/b/note.txt"), "note.txt");
        assert_eq!(entry_name("note.txt"), "note.txt");
        assert_eq!(entry_name(""), "");
        // A key ending in "//" names an entry with an empty name, which cannot
        // be represented over NFS and is filtered out of listings.
        assert_eq!(entry_name("a//"), "");
    }

    #[test]
    fn child_keys_compose_from_the_parent_prefix() {
        assert_eq!(child_key("", "photos", true), "photos/");
        assert_eq!(child_key("", "note.txt", false), "note.txt");
        assert_eq!(child_key("a/b/", "c", true), "a/b/c/");
        assert_eq!(child_key("a/b/", "note.txt", false), "a/b/note.txt");
    }

    #[test]
    fn normalized_dir_key_round_trips_through_child_key() {
        let dir = normalize_dir_key("photos");
        let nested = child_key(&dir, "2024", true);
        assert_eq!(nested, "photos/2024/");
        assert_eq!(normalize_dir_key(&nested), nested);
        assert_eq!(entry_name(&nested), "2024");
    }

    // ---- inode table ----

    #[test]
    fn root_is_id_one_and_its_own_parent() {
        let table = InodeTable::new();
        let root = table.get(ROOT_ID).expect("root inode");
        assert_eq!(root.key, "");
        assert_eq!(root.parent, ROOT_ID);
        assert_eq!(root.kind, EntryKind::Dir);
    }

    #[test]
    fn ids_are_stable_across_relisting_and_attrs_refresh() {
        let mut table = InodeTable::new();
        let first = table.intern("a/note.txt", ROOT_ID, EntryKind::File, 10, 100);
        let second = table.intern("a/note.txt", ROOT_ID, EntryKind::File, 42, 200);

        assert_eq!(first, second, "re-listing must not renumber a known key");
        let inode = table.get(first).expect("inode");
        assert_eq!(inode.size, 42);
        assert_eq!(inode.mtime_secs, 200);
    }

    #[test]
    fn distinct_keys_get_distinct_monotonic_ids() {
        let mut table = InodeTable::new();
        let a = table.intern("a/", ROOT_ID, EntryKind::Dir, DIR_SIZE, 0);
        let b = table.intern("b/", ROOT_ID, EntryKind::Dir, DIR_SIZE, 0);
        let c = table.intern("a/x.txt", a, EntryKind::File, 1, 0);

        assert_ne!(a, b);
        assert_ne!(b, c);
        assert!(a > ROOT_ID && b > a && c > b);
        assert_eq!(table.get(c).expect("inode").parent, a);
    }

    #[test]
    fn a_file_and_a_directory_of_the_same_name_are_separate_inodes() {
        let mut table = InodeTable::new();
        let file = table.intern("x", ROOT_ID, EntryKind::File, 3, 0);
        let dir = table.intern("x/", ROOT_ID, EntryKind::Dir, DIR_SIZE, 0);
        assert_ne!(file, dir);
    }

    #[test]
    fn parenting_is_updated_when_a_key_is_re_interned() {
        let mut table = InodeTable::new();
        let dir = table.intern("a/", ROOT_ID, EntryKind::Dir, DIR_SIZE, 0);
        let id = table.intern("a/x.txt", ROOT_ID, EntryKind::File, 1, 0);
        table.intern("a/x.txt", dir, EntryKind::File, 1, 0);
        assert_eq!(table.get(id).expect("inode").parent, dir);
    }

    // ---- readdir pagination ----

    #[test]
    fn a_zero_cookie_starts_at_the_beginning() {
        let children = vec![child(2, "a"), child(3, "b"), child(4, "c")];
        assert_eq!(resume_index(&children, None), 0);
    }

    #[test]
    fn the_cursor_resumes_after_the_named_entry() {
        let children = vec![child(2, "a"), child(3, "b"), child(4, "c")];
        assert_eq!(resume_index(&children, Some("a")), 1);
        assert_eq!(resume_index(&children, Some("b")), 2);
        assert_eq!(resume_index(&children, Some("c")), 3);
    }

    #[test]
    fn paging_through_a_directory_visits_every_entry_once() {
        let children: Vec<DirChild> = (0..7)
            .map(|i| child(i as fileid3 + 2, &format!("f{}", i)))
            .collect();

        let mut seen = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let start = resume_index(&children, cursor.as_deref());
            let end = (start + 3).min(children.len());
            if start >= end {
                break;
            }
            for entry in &children[start..end] {
                seen.push(entry.name.clone());
            }
            cursor = Some(children[end - 1].name.clone());
            if end >= children.len() {
                break;
            }
        }

        let expected: Vec<String> = children.iter().map(|c| c.name.clone()).collect();
        assert_eq!(seen, expected);
    }

    #[test]
    fn the_cursor_survives_deletion_of_the_entry_it_points_at() {
        // The client paged up to "b", then "b" disappeared before the next call.
        let after_delete = vec![child(2, "a"), child(4, "c"), child(5, "d")];
        assert_eq!(resume_index(&after_delete, Some("b")), 1);
        assert_eq!(after_delete[1].name, "c");
    }

    #[test]
    fn the_cursor_accounts_for_entries_inserted_before_it() {
        // "aa" was uploaded while the client was paging past "b".
        let after_insert = vec![child(2, "a"), child(6, "aa"), child(3, "b"), child(4, "c")];
        assert_eq!(resume_index(&after_insert, Some("b")), 3);
        assert_eq!(after_insert[3].name, "c");
    }

    #[test]
    fn a_cursor_past_the_last_entry_yields_an_empty_page() {
        let children = vec![child(2, "a"), child(3, "b")];
        let start = resume_index(&children, Some("z"));
        assert_eq!(start, children.len());
        assert!(children[start..].is_empty());

        // An empty page must still be flagged as the end of the directory.
        let (end, is_last) = page_end(children.len(), start, 8);
        assert_eq!(end, start);
        assert!(is_last);
    }

    #[test]
    fn a_page_always_advances_even_when_no_entries_are_requested() {
        let (end, is_last) = page_end(5, 0, 0);
        assert_eq!(end, 1, "a zero-sized page would stall the client");
        assert!(!is_last);
    }

    #[test]
    fn only_the_page_reaching_the_last_entry_is_flagged_as_the_end() {
        assert_eq!(page_end(5, 0, 3), (3, false));
        assert_eq!(page_end(5, 3, 3), (5, true));
        assert_eq!(page_end(5, 0, 99), (5, true));
        assert_eq!(page_end(0, 0, 3), (0, true));
    }
}
