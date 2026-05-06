//! roamfs integration for RapidRAW — manage remote NAS connections via FUSE or cache sync.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use roamfs::cache::CacheStore;
use roamfs::fs::RoamFs;
use roamfs::remote::{create_remote, AnyRemote, Remote};
use roamfs::sync::Strategy;

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

/// Serializable remote connection configuration.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RemoteConnection {
    /// Unique identifier.
    pub id: String,
    /// Display name chosen by the user.
    pub name: String,
    /// Remote URI or local path.
    pub uri: String,
    /// Directory where the local cache is stored.
    pub cache_dir: String,
    /// Maximum cache size in MiB.
    pub max_cache_mib: u64,
}

/// Current status of a connection.
#[derive(Serialize, Debug, Clone)]
pub struct RemoteConnectionStatus {
    #[serde(flatten)]
    pub conn: RemoteConnection,
    pub is_mounted: bool,
    pub local_path: Option<String>,
    pub dirty_count: usize,
    pub conflict_count: usize,
    pub total_cached_mib: u64,
}

/// Result of a manual sync operation.
#[derive(Serialize, Debug, Clone)]
pub struct SyncResultPayload {
    pub pushed: Vec<String>,
    pub conflicts: Vec<String>,
}

/// A single directory entry returned by the unified read-dir proxy.
#[derive(Clone, Debug)]
pub struct RoamDirEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub is_file: bool,
}

/// Strategy for resolving a sync conflict.
#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub enum ResolveStrategy {
    KeepLocal,
    KeepRemote,
}

impl From<ResolveStrategy> for Strategy {
    fn from(s: ResolveStrategy) -> Self {
        match s {
            ResolveStrategy::KeepLocal => Strategy::KeepLocal,
            ResolveStrategy::KeepRemote => Strategy::KeepRemote,
        }
    }
}

// ---------------------------------------------------------------------------
// Internal mount handles
// ---------------------------------------------------------------------------

#[cfg(unix)]
struct FuseMount {
    mountpoint: String,
    session: fuser::BackgroundSession,
    sync_worker: roamfs::fuse::SyncWorker,
    cache_dir: String,
    uri: String,
    max_cache: u64,
}

#[derive(Clone)]
struct CacheMount {
    local_path: String,
    fs: Arc<Mutex<RoamFs<AnyRemote>>>,
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
}

enum MountHandle {
    #[cfg(unix)]
    Fuse(FuseMount),
    Cache(CacheMount),
}

/// Internal enum used to pass mount info into `spawn_blocking` closures.
#[derive(Clone)]
enum MountSnapshot {
    #[cfg(unix)]
    Fuse {
        cache_dir: String,
        uri: String,
        max_cache: u64,
    },
    Cache {
        fs: Arc<Mutex<RoamFs<AnyRemote>>>,
    },
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

pub struct RoamFsManager {
    connections: Mutex<HashMap<String, RemoteConnection>>,
    mounts: Mutex<HashMap<String, MountHandle>>,
    config_path: PathBuf,
}

impl RoamFsManager {
    /// Load saved connections from RapidRAW's app data directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self, String> {
        let config_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?;
        let config_path = config_dir.join("remote_connections.json");
        let connections: HashMap<String, RemoteConnection> = if config_path.exists() {
            let content =
                std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self {
            connections: Mutex::new(connections),
            mounts: Mutex::new(HashMap::new()),
            config_path,
        })
    }

    fn save(&self) -> Result<(), String> {
        let connections = self.connections.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*connections).map_err(|e| e.to_string())?;
        std::fs::write(&self.config_path, json).map_err(|e| e.to_string())?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Connection CRUD
    // -----------------------------------------------------------------------

    pub fn list_connections(&self) -> Result<Vec<RemoteConnection>, String> {
        let connections = self.connections.lock().map_err(|e| e.to_string())?;
        Ok(connections.values().cloned().collect())
    }

    pub fn get_connection(&self, id: &str) -> Result<Option<RemoteConnection>, String> {
        let connections = self.connections.lock().map_err(|e| e.to_string())?;
        Ok(connections.get(id).cloned())
    }

    pub fn add_connection(&self, conn: RemoteConnection) -> Result<(), String> {
        let mut connections = self.connections.lock().map_err(|e| e.to_string())?;
        connections.insert(conn.id.clone(), conn);
        drop(connections);
        self.save()
    }

    pub fn update_connection(&self, conn: RemoteConnection) -> Result<(), String> {
        let mut connections = self.connections.lock().map_err(|e| e.to_string())?;
        connections.insert(conn.id.clone(), conn);
        drop(connections);
        self.save()
    }

    pub fn remove_connection(&self, id: &str) -> Result<(), String> {
        self.unmount(id)?;
        let mut connections = self.connections.lock().map_err(|e| e.to_string())?;
        connections.remove(id);
        drop(connections);
        self.save()
    }

    // -----------------------------------------------------------------------
    // Mount / unmount
    // -----------------------------------------------------------------------

    pub fn mount(&self, id: &str, app_handle: &AppHandle) -> Result<String, String> {
        // Already mounted?
        {
            let mounts = self.mounts.lock().map_err(|e| e.to_string())?;
            if let Some(handle) = mounts.get(id) {
                return Ok(match handle {
                    #[cfg(unix)]
                    MountHandle::Fuse(f) => f.mountpoint.clone(),
                    MountHandle::Cache(c) => c.local_path.clone(),
                });
            }
        }

        let conn = self
            .get_connection(id)?
            .ok_or_else(|| "Connection not found".to_string())?;

        let max_cache = conn.max_cache_mib * 1024 * 1024;
        let cache_path = PathBuf::from(&conn.cache_dir);

        #[cfg(unix)]
        {
            let mountpoint = cache_path.join("mount").to_string_lossy().to_string();
            std::fs::create_dir_all(&mountpoint).map_err(|e| e.to_string())?;

            let remote = create_remote(&conn.uri).map_err(|e| e.message().to_string())?;
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            let fs = rt.block_on(async {
                let cache = CacheStore::new(&cache_path, max_cache)
                    .map_err(|e| e.message().to_string())?;
                Ok::<_, String>(RoamFs::new(remote, cache))
            })?;

            let fuse = roamfs::fuse::RoamFsFuse::new(fs, rt.handle().clone());
            let sync_worker = fuse.spawn_sync_worker(Duration::from_secs(30));

            let mut config = fuser::Config::default();
            config.acl = fuser::SessionACL::All;
            config.mount_options = vec![
                fuser::MountOption::FSName("roamfs".to_string()),
                fuser::MountOption::DefaultPermissions,
            ];

            let session = fuser::spawn_mount2(fuse, &mountpoint, &config)
                .map_err(|e| format!("FUSE mount failed: {e}"))?;

            let mut mounts = self.mounts.lock().map_err(|e| e.to_string())?;
            mounts.insert(
                id.to_string(),
                MountHandle::Fuse(FuseMount {
                    mountpoint: mountpoint.clone(),
                    session,
                    sync_worker,
                    cache_dir: conn.cache_dir,
                    uri: conn.uri,
                    max_cache,
                }),
            );
            drop(mounts);

            let _ = app_handle.emit(
                "roamfs-mounted",
                serde_json::json!({ "id": id, "path": &mountpoint }),
            );
            Ok(mountpoint)
        }

        #[cfg(not(unix))]
        {
            let data_dir = cache_path.join("data");
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            let local_path = data_dir.to_string_lossy().to_string();

            let remote = create_remote(&conn.uri).map_err(|e| e.message().to_string())?;
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            let fs = Arc::new(Mutex::new(rt.block_on(async {
                let cache = CacheStore::new(&cache_path, max_cache)
                    .map_err(|e| e.message().to_string())?;
                Ok::<_, String>(RoamFs::new(remote, cache))
            })?));

            // Initial sync
            let fs_clone = Arc::clone(&fs);
            let initial_report: roamfs::sync::SyncReport = rt.block_on(async {
                let guard = fs_clone.lock().map_err(|e| e.to_string())?;
                guard.sync_all().await.map_err(|e| e.message().to_string())
            })?;

            if !initial_report.conflicts.is_empty() {
                let _ = app_handle.emit(
                    "roamfs-conflicts-detected",
                    serde_json::json!({
                        "connectionId": id,
                        "conflicts": initial_report.conflicts,
                    }),
                );
            }

            // Background sync worker
            let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
            let fs_bg = Arc::clone(&fs);
            let app_handle_bg = app_handle.clone();
            let conn_id = id.to_string();

            let _handle = std::thread::spawn(move || {
                let sync_interval = Duration::from_secs(30);
                let check_period = Duration::from_secs(5);
                let mut elapsed = Duration::ZERO;

                loop {
                    match stop_rx.recv_timeout(check_period) {
                        Ok(()) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            elapsed += check_period;
                            if elapsed >= sync_interval {
                                elapsed = Duration::ZERO;

                                // Scan local changes
                                if let Err(e) = scan_local_changes(&fs_bg) {
                                    log::warn!("roamfs local scan error: {e}");
                                    continue;
                                }

                                let report = rt.block_on(async {
                                    let guard = fs_bg.lock().map_err(|e| e.to_string())?;
                                    guard.sync_all().await.map_err(|e| e.message().to_string())
                                });

                                match report {
                                    Ok(r) => {
                                        if !r.conflicts.is_empty() {
                                            let _ = app_handle_bg.emit(
                                                "roamfs-conflicts-detected",
                                                serde_json::json!({
                                                    "connectionId": conn_id,
                                                    "conflicts": r.conflicts,
                                                }),
                                            );
                                        }
                                    }
                                    Err(e) => log::warn!("roamfs background sync error: {e}"),
                                }
                            }
                        }
                    }
                }
            });

            let mut mounts = self.mounts.lock().map_err(|e| e.to_string())?;
            mounts.insert(
                id.to_string(),
                MountHandle::Cache(CacheMount {
                    local_path: local_path.clone(),
                    fs,
                    stop_tx: Some(stop_tx),
                }),
            );
            drop(mounts);

            let _ = app_handle.emit(
                "roamfs-mounted",
                serde_json::json!({ "id": id, "path": &local_path }),
            );
            Ok(local_path)
        }
    }

    pub fn unmount(&self, id: &str) -> Result<(), String> {
        let mut mounts = self.mounts.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = mounts.remove(id) {
            match handle {
                #[cfg(unix)]
                MountHandle::Fuse(f) => {
                    f.sync_worker.stop();
                    let _ = f.session.umount_and_join();
                }
                MountHandle::Cache(_c) => {
                    // The background thread will exit when the receiver is dropped,
                    // which happens when stop_tx is dropped. Since we drop the
                    // MountHandle here, stop_tx is dropped and the thread exits.
                }
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------------

    pub fn status(&self, id: &str) -> Result<RemoteConnectionStatus, String> {
        let conn = self
            .get_connection(id)?
            .ok_or_else(|| "Connection not found".to_string())?;

        let (is_mounted, local_path) = {
            let mounts = self.mounts.lock().map_err(|e| e.to_string())?;
            match mounts.get(id) {
                #[cfg(unix)]
                Some(MountHandle::Fuse(f)) => (true, Some(f.mountpoint.clone())),
                Some(MountHandle::Cache(c)) => (true, Some(c.local_path.clone())),
                None => (false, None),
            }
        };

        let cache_path = PathBuf::from(&conn.cache_dir);
        let (dirty_count, conflict_count, total_cached) =
            match CacheStore::new(&cache_path, conn.max_cache_mib * 1024 * 1024) {
                Ok(store) => {
                    let dirty = store.list_dirty().unwrap_or_default().len();
                    let conflicts = store.list_conflicts().unwrap_or_default().len();
                    let total = store.total_size().unwrap_or(0);
                    (dirty, conflicts, total)
                }
                Err(_) => (0, 0, 0),
            };

        Ok(RemoteConnectionStatus {
            conn,
            is_mounted,
            local_path,
            dirty_count,
            conflict_count,
            total_cached_mib: total_cached / (1024 * 1024),
        })
    }

    // -----------------------------------------------------------------------
    // Sync & conflict resolution
    // -----------------------------------------------------------------------

    fn snapshot_mount(&self, id: &str) -> Result<MountSnapshot, String> {
        let mounts = self.mounts.lock().map_err(|e| e.to_string())?;
        match mounts.get(id) {
            #[cfg(unix)]
            Some(MountHandle::Fuse(f)) => Ok(MountSnapshot::Fuse {
                cache_dir: f.cache_dir.clone(),
                uri: f.uri.clone(),
                max_cache: f.max_cache,
            }),
            Some(MountHandle::Cache(c)) => Ok(MountSnapshot::Cache {
                fs: Arc::clone(&c.fs),
            }),
            None => Err("Not mounted".to_string()),
        }
    }

    pub async fn sync_now(&self, id: &str) -> Result<SyncResultPayload, String> {
        let snapshot = self.snapshot_mount(id)?;

        let report = tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            match snapshot {
                #[cfg(unix)]
                MountSnapshot::Fuse {
                    cache_dir,
                    uri,
                    max_cache,
                } => {
                    let remote = create_remote(&uri).map_err(|e| e.message().to_string())?;
                    let fs = rt.block_on(async {
                        let cache = CacheStore::new(&cache_dir, max_cache)
                            .map_err(|e| e.message().to_string())?;
                        Ok::<_, String>(RoamFs::new(remote, cache))
                    })?;
                    rt.block_on(fs.sync_all()).map_err(|e| e.message().to_string())
                }
                MountSnapshot::Cache { fs } => {
                    let guard = fs.lock().map_err(|e| e.to_string())?;
                    rt.block_on(guard.sync_all()).map_err(|e| e.message().to_string())
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        let report = report?;
        Ok(SyncResultPayload {
            pushed: report.pushed,
            conflicts: report.conflicts,
        })
    }

    pub async fn resolve_conflict(
        &self,
        id: &str,
        path: &str,
        strategy: ResolveStrategy,
    ) -> Result<(), String> {
        let snapshot = self.snapshot_mount(id)?;
        let path = path.to_string();
        let strategy = Strategy::from(strategy);

        tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            match snapshot {
                #[cfg(unix)]
                MountSnapshot::Fuse {
                    cache_dir,
                    uri,
                    max_cache,
                } => {
                    let remote = create_remote(&uri).map_err(|e| e.message().to_string())?;
                    let fs = rt.block_on(async {
                        let cache = CacheStore::new(&cache_dir, max_cache)
                            .map_err(|e| e.message().to_string())?;
                        Ok::<_, String>(RoamFs::new(remote, cache))
                    })?;
                    rt.block_on(fs.resolve_conflict(Path::new(&path), strategy))
                        .map_err(|e| e.message().to_string())
                }
                MountSnapshot::Cache { fs } => {
                    let guard = fs.lock().map_err(|e| e.to_string())?;
                    rt.block_on(guard.resolve_conflict(Path::new(&path), strategy))
                        .map_err(|e| e.message().to_string())
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn list_conflicts(&self, id: &str) -> Result<Vec<String>, String> {
        let conn = self
            .get_connection(id)?
            .ok_or_else(|| "Connection not found".to_string())?;
        let cache_path = PathBuf::from(&conn.cache_dir);
        let store = CacheStore::new(&cache_path, conn.max_cache_mib * 1024 * 1024)
            .map_err(|e| e.message().to_string())?;
        store.list_conflicts().map_err(|e| e.message().to_string())
    }

    // -----------------------------------------------------------------------
    // Unified directory listing (remote-aware for non-Unix)
    // -----------------------------------------------------------------------

    /// Find the roamfs mount that owns `local_path` and return its
    /// `(connection_id, relative_path_inside_mount)`.
    pub fn find_mount_by_local_path(&self, local_path: &Path) -> Option<(String, PathBuf)> {
        let mounts = self.mounts.lock().ok()?;
        let mut best_match: Option<(String, PathBuf)> = None;
        let mut best_root_len: usize = 0;

        for (id, handle) in mounts.iter() {
            let mount_root = match handle {
                #[cfg(unix)]
                MountHandle::Fuse(f) => Path::new(&f.mountpoint),
                MountHandle::Cache(c) => Path::new(&c.local_path),
            };
            if let Ok(rel) = local_path.strip_prefix(mount_root) {
                let root_len = mount_root.components().count();
                if root_len >= best_root_len {
                    best_root_len = root_len;
                    best_match = Some((id.clone(), rel.to_path_buf()));
                }
            }
        }
        best_match
    }

    /// Synchronous read-dir that falls back to the remote on non-Unix.
    ///
    /// * Returns `Ok(Some(entries))` when the path belongs to a non-Unix
    ///   roamfs mount — the entries come from `RoamFs::list_dir`.
    /// * Returns `Ok(None)` for normal local paths (caller should use
    ///   `std::fs::read_dir`) or for Unix FUSE mounts (already transparent).
    pub fn read_dir_sync(&self, local_path: &Path) -> Result<Option<Vec<RoamDirEntry>>, String> {
        let (id, rel_path) = match self.find_mount_by_local_path(local_path) {
            Some(x) => x,
            None => return Ok(None),
        };

        // On Unix FUSE handles readdir transparently.
        #[cfg(unix)]
        {
            let _ = (id, rel_path);
            return Ok(None);
        }

        #[cfg(not(unix))]
        {
            let mounts = self.mounts.lock().map_err(|e| e.to_string())?;
            let fs = match mounts.get(&id) {
                Some(MountHandle::Cache(c)) => Arc::clone(&c.fs),
                _ => return Ok(None),
            };
            drop(mounts);

            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            let entries = rt.block_on(async {
                let guard = fs.lock().map_err(|e| e.to_string())?;
                let remote_entries = guard
                    .list_dir(&rel_path)
                    .await
                    .map_err(|e| e.message().to_string())?;
                Ok::<_, String>(remote_entries)
            })?;

            let mut result = Vec::new();
            for entry in entries {
                let mut path = local_path.to_path_buf();
                path.push(&entry.name);
                result.push(RoamDirEntry {
                    name: entry.name,
                    path,
                    is_dir: entry.meta.is_dir,
                    is_file: entry.meta.is_file,
                });
            }
            Ok(Some(result))
        }
    }

    }

// ---------------------------------------------------------------------------
// Non-Unix: local change scanner
// ---------------------------------------------------------------------------

#[cfg(not(unix))]
fn scan_local_changes(fs: &Arc<Mutex<RoamFs<AnyRemote>>>) -> Result<(), String> {
    let guard = fs.lock().map_err(|e| e.to_string())?;
    let cache = guard.cache();
    let data_dir = cache.data_path("");

    for entry in walkdir::WalkDir::new(&data_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel_path = match entry.path().strip_prefix(&data_dir) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let rel_str = rel_path.to_string_lossy().replace('\\', "/");

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let fs_mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        match cache.stat(&rel_str) {
            Ok(Some(db_entry)) => {
                if fs_mtime > db_entry.mtime || meta.len() != db_entry.size {
                    if let Err(e) = cache.update_size_and_dirty(&rel_str, meta.len(), true) {
                        log::warn!("mark dirty failed for {rel_str}: {}", e.message());
                    }
                }
            }
            Ok(None) => {
                if let Err(e) = cache.record(&rel_str, meta.len(), true, None, None) {
                    log::warn!("record new file failed for {rel_str}: {}", e.message());
                }
            }
            Err(_) => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn roamfs_list_connections(
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<Vec<RemoteConnection>, String> {
    manager.list_connections()
}

#[tauri::command]
pub fn roamfs_add_connection(
    conn: RemoteConnection,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<(), String> {
    manager.add_connection(conn)
}

#[tauri::command]
pub fn roamfs_remove_connection(
    id: String,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<(), String> {
    manager.remove_connection(&id)
}

#[tauri::command]
pub fn roamfs_mount(
    id: String,
    app_handle: AppHandle,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<String, String> {
    manager.mount(&id, &app_handle)
}

#[tauri::command]
pub fn roamfs_unmount(
    id: String,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<(), String> {
    manager.unmount(&id)
}

#[tauri::command]
pub fn roamfs_status(
    id: String,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<RemoteConnectionStatus, String> {
    manager.status(&id)
}

#[tauri::command]
pub async fn roamfs_sync_now(
    id: String,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<SyncResultPayload, String> {
    manager.sync_now(&id).await
}

#[tauri::command]
pub async fn roamfs_resolve_conflict(
    id: String,
    path: String,
    strategy: ResolveStrategy,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<(), String> {
    manager.resolve_conflict(&id, &path, strategy).await
}

#[tauri::command]
pub fn roamfs_list_conflicts(
    id: String,
    manager: tauri::State<'_, RoamFsManager>,
) -> Result<Vec<String>, String> {
    manager.list_conflicts(&id)
}

#[tauri::command]
pub async fn roamfs_test_connection(uri: String) -> Result<(), String> {
    let remote = create_remote(&uri).map_err(|e| e.message().to_string())?;
    remote.ping().await.map_err(|e| e.message().to_string())
}

