//! Installed-app catalog recovered from official `src/shell/process.rs` + `src/shell/app_catalog.rs`.
//!
//! Sources: user/machine Start Menu `.lnk` trees, `%LOCALAPPDATA%\Microsoft\WindowsApps`
//! execution aliases, `shell:AppsFolder`, App Paths, Uninstall, and Appx package keys.
//! Cached as `%LOCALAPPDATA%\computer-use-app-catalog\shell-apps.json`.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use windows::core::{w, HSTRING, IUnknown, Interface, PCWSTR, PWSTR};
use windows::ApplicationModel::{AppInfo as PackagedAppInfo, PackageSignatureKind};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, FILETIME, HWND, RPC_E_CHANGED_MODE};
use windows::Win32::Storage::FileSystem::{SearchPathW, WIN32_FIND_DATAW};
use windows::Win32::Storage::Packaging::Appx::VerifyApplicationUserModelId;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    IBindCtx, IPersistFile, STGM_READ,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryInfoKeyW, RegQueryValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::System::Threading::GetProcessId;
use windows::Win32::UI::Shell::{
    ApplicationActivationManager, BHID_EnumItems, IApplicationActivationManager, IEnumShellItems,
    IShellItem, IShellLinkW, SHCreateItemFromParsingName, SHGetIDListFromObject, SHGetKnownFolderItem,
    ShellExecuteExW, ShellExecuteW, ShellLink, AO_NOERRORUI, FOLDERID_AppsFolder, KF_FLAG_DEFAULT,
    SEE_MASK_FLAG_NO_UI, SEE_MASK_IDLIST, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING, SLR_NO_UI, SLR_NOUPDATE,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::assist;
use crate::enum_windows::{
    activate_hwnd, enum_windows, exe_name, exe_path, hwnd_from_id, pids_matching_keys,
    restore_running_processes, window_pid, AppInfo, WindowRef,
};
use crate::interrupt;
use crate::policy;
use crate::protocol::Error;

const CACHE_DIR_NAME: &str = "computer-use-app-catalog";

/// Official src/shell/app_identity/native.rs — PE `\\StringFileInfo\\*\\ProductName`.
pub fn product_name(path: &str) -> Option<String> {
    policy::product_name(path)
}

/// Resolved PE product names, keyed by executable path.
///
/// `list_apps` resolves one per installed app -- 751 on this machine -- and every
/// resolution opens the executable. On a machine with a busy filesystem or an antivirus
/// that scans each open that is the expensive part of the call, and it ran again on every
/// observation. Cleared whenever the catalog is rebuilt.
static PRODUCT_NAMES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn cached_product_name(path: &str) -> Option<String> {
    let mut guard = PRODUCT_NAMES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(hit) = map.get(path) {
        return if hit.is_empty() { None } else { Some(hit.clone()) };
    }
    let name = product_name(path).unwrap_or_default();
    map.insert(path.to_string(), name.clone());
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Display name for a window that matched no installed entry. Bounded by the number of
/// open windows, so the file open per window is acceptable (and memoized).
fn prefer_product_name(current: &str, path: Option<&str>) -> String {
    path.and_then(cached_product_name).unwrap_or_else(|| current.to_string())
}

/// Display name for an installed catalog entry. Deliberately I/O-free: the name was
/// resolved during the rebuild, and resolving 751 of them inside a request is what made
/// `list_apps` take 31 s on a machine whose antivirus scans every opened executable.
fn installed_display_name(current: &str, stored: &str) -> String {
    if stored.trim().is_empty() {
        current.to_string()
    } else {
        stored.to_string()
    }
}

const CACHE_FILE_NAME: &str = "shell-apps.json";
const CACHE_TTL_SECS: u64 = 86_400;
const START_MENU_TAIL: &str = r"Microsoft\Windows\Start Menu\Programs";
const WINDOWSAPPS_TAIL: &str = r"Microsoft\WindowsApps";
const APP_PATHS: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths";
const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_WOW64: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
const HKCU_PACKAGES: &str =
    r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
const HKLM_APPX: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\Applications";
const APPSFOLDER_OPEN: &str = "failed to open shell:AppsFolder";
const APPSFOLDER_ENUM: &str = "failed to enumerate shell:AppsFolder";
const APPSFOLDER_ITEM: &str = "failed to fetch shell:AppsFolder item";
const COINIT_FAILED: &str = "CoInitializeEx failed";
const MAX_WALK: usize = 4_000;
const MAX_DEPTH: usize = 12;

const WELL_KNOWN: &[(&str, &[&str])] = &[
    ("Microsoft.Paint_8wekyb3d8bbwe!App", &["mspaint.exe", "mspaint"]),
    ("Microsoft.ScreenSketch_8wekyb3d8bbwe!App", &["snippingtool.exe", "snippingtool"]),
    ("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", &["calc.exe", "calc", "calculatorapp.exe"]),
    ("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", &["windowsterminal.exe", "wt.exe", "wt"]),
];

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ShellApp {
    display_name: String,
    identifier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    process_keys: Vec<String>,
    /// PE `ProductName`, resolved once during the rebuild.
    ///
    /// `list_apps` used to resolve it per installed app on every call: 751 executable
    /// opens here, and **31.5 s inside one request** when an antivirus scans each open
    /// (measured 2026-09-15, `slow-requests.log`: `listMs=31466 mergeMs=31285`). The
    /// rebuild runs on its own thread, so the cost belongs there; the request path uses
    /// this value and never touches the filesystem.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    product_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct ChangeSignal {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    registry: Option<String>,
    item_count: u64,
    modified_unix_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ShellInstallState {
    #[serde(default)]
    apps: Vec<ShellApp>,
    #[serde(default)]
    signals: Vec<ChangeSignal>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SessionCacheEnvelope {
    cached_at_unix_seconds: u64,
    value: ShellInstallState,
}

struct CachedCatalog {
    apps: Vec<ShellApp>,
    signals: Vec<ChangeSignal>,
    cached_at: u64,
}

fn catalog_cell() -> &'static Mutex<Option<CachedCatalog>> {
    static CELL: OnceLock<Mutex<Option<CachedCatalog>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Where the time in `list_apps` goes. The catalog is the one Computer Use method that can
/// run for seconds on a cold machine, and the transport kills the helper when a request
/// exceeds its budget -- which throws the warm cache away and makes the next attempt cold
/// again. These counters are what tell "slow but working" apart from "wedged" without a
/// debugger, so the budget can be fixed in the right place.
static SIGNALS_MS: AtomicU64 = AtomicU64::new(0);
static SIGNALS_COUNT: AtomicU64 = AtomicU64::new(0);
static INSTALLED_MS: AtomicU64 = AtomicU64::new(0);
static REBUILD_MS: AtomicU64 = AtomicU64::new(0);
static REBUILDS: AtomicU64 = AtomicU64::new(0);
static CATALOG_APPS: AtomicU64 = AtomicU64::new(0);
static LIST_MS: AtomicU64 = AtomicU64::new(0);
static MERGE_MS: AtomicU64 = AtomicU64::new(0);
static CACHE_SOURCE: Mutex<&'static str> = Mutex::new("none");

fn note_cache_source(source: &'static str) {
    if let Ok(mut slot) = CACHE_SOURCE.lock() {
        *slot = source;
    }
}

fn ms_since(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

/// Where the background catalog rebuild currently is, and how long each stage took.
///
/// The rebuild runs on its own thread and a stage that never returns (a Shell enumeration
/// waiting on a third-party handler, a registry hive being scanned) leaves
/// `rebuilds = 0` forever with an empty catalog and no way to tell which scan it was.
static REBUILD_STAGE: Mutex<&'static str> = Mutex::new("idle");
static REBUILD_STAGE_STARTED: Mutex<Option<Instant>> = Mutex::new(None);
static REBUILD_STAGES: Mutex<Vec<(&'static str, u64)>> = Mutex::new(Vec::new());

fn note_rebuild_stage(name: &'static str) {
    let now = Instant::now();
    let previous = {
        let mut stage = REBUILD_STAGE.lock().unwrap_or_else(|e| e.into_inner());
        let previous = *stage;
        *stage = name;
        previous
    };
    let elapsed = {
        let mut started = REBUILD_STAGE_STARTED.lock().unwrap_or_else(|e| e.into_inner());
        let elapsed = started.map(|s| s.elapsed().as_millis() as u64);
        *started = Some(now);
        elapsed
    };
    if let Some(ms) = elapsed {
        if let Ok(mut rows) = REBUILD_STAGES.lock() {
            rows.push((previous, ms));
            if rows.len() > 24 {
                rows.remove(0);
            }
        }
    }
}

/// Catalog timing, surfaced through `diagnostic_state` as `appCatalog`.
pub fn catalog_diagnostics() -> serde_json::Value {
    serde_json::json!({
        "cacheSource": CACHE_SOURCE.lock().map(|s| *s).unwrap_or("none"),
        "signalsMs": SIGNALS_MS.load(Ordering::Relaxed),
        "signals": SIGNALS_COUNT.load(Ordering::Relaxed),
        "installedMs": INSTALLED_MS.load(Ordering::Relaxed),
        "rebuildMs": REBUILD_MS.load(Ordering::Relaxed),
        "rebuilds": REBUILDS.load(Ordering::Relaxed),
        "apps": CATALOG_APPS.load(Ordering::Relaxed),
        "listMs": LIST_MS.load(Ordering::Relaxed),
        "mergeMs": MERGE_MS.load(Ordering::Relaxed),
        "appsFolderError": last_appsfolder_error(),
        "rebuildStage": REBUILD_STAGE.lock().map(|s| *s).unwrap_or("idle"),
        "rebuildStageMs": REBUILD_STAGE_STARTED
            .lock()
            .ok()
            .and_then(|s| *s)
            .map(|s| s.elapsed().as_millis() as u64)
            .unwrap_or(0),
        "rebuildStages": REBUILD_STAGES
            .lock()
            .map(|rows| rows.iter().map(|(name, ms)| serde_json::json!({ "stage": name, "ms": ms })).collect::<Vec<_>>())
            .unwrap_or_default(),
    })
}

fn rebuilding() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
}

fn kick_rebuild(signals: Vec<ChangeSignal>) {
    if rebuilding().swap(true, Ordering::SeqCst) {
        return;
    }
    thread::Builder::new()
        .name("cu-app-catalog".into())
        .spawn(move || {
            let now = now_unix();
            let started = Instant::now();
            let apps = rebuild_installed();
            // The catalog changed, so the previously resolved product names may no longer
            // describe the same executables.
            if let Ok(mut slot) = PRODUCT_NAMES.lock() {
                *slot = None;
            }
            REBUILD_MS.store(ms_since(started), Ordering::Relaxed);
            CATALOG_APPS.store(apps.len() as u64, Ordering::Relaxed);
            REBUILDS.fetch_add(1, Ordering::Relaxed);
            write_cache(&apps, &signals, now);
            if let Ok(mut guard) = catalog_cell().lock() {
                *guard = Some(CachedCatalog {
                    apps,
                    signals,
                    cached_at: now,
                });
            }
            rebuilding().store(false, Ordering::SeqCst);
        })
        .ok();
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_path() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join(CACHE_DIR_NAME).join(CACHE_FILE_NAME))
}

fn env_join(var: &str, tail: &str) -> Option<PathBuf> {
    let base = std::env::var_os(var)?;
    if base.is_empty() {
        return None;
    }
    Some(PathBuf::from(base).join(tail))
}

fn file_stem_name(path: &Path) -> String {
    path.file_stem()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            path.file_name()
                .and_then(OsStr::to_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_string()
}

fn path_leaf(path: &str) -> String {
    path.replace('/', "\\")
        .rsplit('\\')
        .next()
        .unwrap_or(path)
        .trim_matches('"')
        .to_string()
}

/// Canonical comparison key. Official AppIdentifier prefixes (CW-5) are removed so
/// that `process:C:\a\msedge.exe` and `C:\a\msedge.exe` collapse to one key.
fn normalize_key(value: &str) -> String {
    let stripped = crate::enum_windows::strip_app_prefix(value);
    stripped.trim().trim_matches('"').to_ascii_lowercase().replace('/', "\\")
}

fn exe_key(path: &str) -> String {
    path_leaf(path).to_ascii_lowercase()
}

fn stem_key(path: &str) -> String {
    let name = exe_key(path);
    name.strip_suffix(".exe").unwrap_or(&name).to_string()
}

fn strip_quotes(value: &str) -> String {
    value.trim().trim_matches('"').trim().to_string()
}

fn is_http(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn skip_entry_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.is_empty()
        || n == "desktop.ini"
        || n.ends_with(".ini")
        || n.ends_with(".txt")
        || n.starts_with("uninstall ")
        || n == "uninstall.lnk"
        || n.ends_with(" uninstall.lnk")
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn ensure_com() -> Result<(), &'static str> {
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        Err(COINIT_FAILED)
    } else {
        Ok(())
    }
}

fn filetime_unix(ft: FILETIME) -> u64 {
    let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    if ticks == 0 {
        0
    } else {
        ticks.saturating_sub(11_644_473_600_000_0000) / 10_000_000
    }
}

fn metadata_unix(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn dir_stats(root: &Path, recursive: bool) -> (u64, u64) {
    let mut count = 0u64;
    let mut mtime = metadata_unix(root);
    fn walk(dir: &Path, recursive: bool, depth: usize, count: &mut u64, mtime: &mut u64) {
        if depth > MAX_DEPTH || *count as usize > MAX_WALK {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            *count += 1;
            let path = entry.path();
            *mtime = (*mtime).max(metadata_unix(&path));
            if recursive && path.is_dir() {
                walk(&path, true, depth + 1, count, mtime);
            }
        }
    }
    if root.is_dir() {
        walk(root, recursive, 0, &mut count, &mut mtime);
    }
    (count, mtime)
}

fn path_signal(name: &str, path: &Path, recursive: bool) -> ChangeSignal {
    let (item_count, modified_unix_seconds) = dir_stats(path, recursive);
    let _ = name;
    ChangeSignal {
        path: Some(format!("path:{}", path.display())),
        registry: None,
        item_count,
        modified_unix_seconds,
    }
}

fn registry_signal(name: &str, root: HKEY, sub: &str) -> ChangeSignal {
    let mut key = HKEY::default();
    let path: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
    let mut subkeys = 0u32;
    let mut values = 0u32;
    let mut last = FILETIME::default();
    unsafe {
        if RegOpenKeyExW(root, PCWSTR(path.as_ptr()), Some(0), KEY_READ, &mut key) == ERROR_SUCCESS {
            let _ = RegQueryInfoKeyW(
                key,
                None,
                None,
                None,
                Some(&mut subkeys as *mut u32),
                None,
                None,
                Some(&mut values as *mut u32),
                None,
                None,
                None,
                Some(&mut last as *mut FILETIME),
            );
            let _ = RegCloseKey(key);
        }
    }
    ChangeSignal {
        path: None,
        registry: Some(format!("registry:{name}")),
        item_count: u64::from(subkeys.saturating_add(values)),
        modified_unix_seconds: filetime_unix(last),
    }
}

fn collect_signals() -> Vec<ChangeSignal> {
    let mut out = Vec::new();
    if let Some(path) = env_join("APPDATA", START_MENU_TAIL) {
        out.push(path_signal("user-start-menu-programs", &path, true));
    }
    if let Some(path) = env_join("ProgramData", START_MENU_TAIL) {
        out.push(path_signal("machine-start-menu-programs", &path, true));
    }
    if let Some(path) = env_join("LOCALAPPDATA", WINDOWSAPPS_TAIL) {
        out.push(path_signal("windows-app-execution-aliases", &path, false));
    }
    out.push(registry_signal("hkcu-uninstall", HKEY_CURRENT_USER, UNINSTALL));
    out.push(registry_signal("hklm-uninstall", HKEY_LOCAL_MACHINE, UNINSTALL));
    out.push(registry_signal("hklm-wow64-uninstall", HKEY_LOCAL_MACHINE, UNINSTALL_WOW64));
    out.push(registry_signal("hkcu-app-paths", HKEY_CURRENT_USER, APP_PATHS));
    out.push(registry_signal("hklm-app-paths", HKEY_LOCAL_MACHINE, APP_PATHS));
    out.push(registry_signal("hkcu-packages", HKEY_CURRENT_USER, HKCU_PACKAGES));
    out.push(registry_signal("hklm-appx-applications", HKEY_LOCAL_MACHINE, HKLM_APPX));
    out
}

fn extra_keys(id: &str, exe: Option<&str>) -> Vec<String> {
    let mut keys = Vec::new();
    let lower = id.to_ascii_lowercase();
    for (aumid, aliases) in WELL_KNOWN {
        if lower == aumid.to_ascii_lowercase() || lower.starts_with(&aumid[..aumid.find('_').unwrap_or(aumid.len())].to_ascii_lowercase()) {
            keys.extend(aliases.iter().map(|s| (*s).to_string()));
        }
        if let Some(exe) = exe {
            let stem = stem_key(exe);
            if aliases.iter().any(|alias| stem_key(alias) == stem) {
                keys.push((*aumid).to_string());
                keys.extend(aliases.iter().map(|s| (*s).to_string()));
            }
        }
    }
    keys
}

fn push_key(keys: &mut Vec<String>, value: &str) {
    let cleaned = strip_quotes(value);
    if cleaned.is_empty() || is_http(&cleaned) {
        return;
    }
    let lower = normalize_key(&cleaned);
    if !keys.iter().any(|k| normalize_key(k) == lower) {
        keys.push(cleaned);
    }
}

fn canonical_id(display: &str, target: Option<&str>, fallback: &str) -> String {
    if let Some(target) = target {
        let leaf = path_leaf(target);
        if leaf.to_ascii_lowercase().ends_with(".exe") && !is_http(target) {
            return leaf;
        }
        if target.contains('!') && !target.contains('\\') {
            return target.to_string();
        }
    }
    if fallback.contains('!') {
        return fallback.to_string();
    }
    if fallback.to_ascii_lowercase().ends_with(".exe") {
        return path_leaf(fallback);
    }
    if !display.is_empty() {
        display.to_string()
    } else {
        fallback.to_string()
    }
}

fn upsert(apps: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>, app: ShellApp) {
    if app.identifier.is_empty() && app.display_name.is_empty() {
        return;
    }
    let mut keys: Vec<String> = Vec::new();
    push_key(&mut keys, &app.identifier);
    push_key(&mut keys, &exe_key(&app.identifier));
    push_key(&mut keys, &stem_key(&app.identifier));
    if let Some(path) = &app.target_path {
        push_key(&mut keys, path);
        push_key(&mut keys, &exe_key(path));
        push_key(&mut keys, &stem_key(path));
    }
    for key in &app.process_keys {
        push_key(&mut keys, key);
        push_key(&mut keys, &exe_key(key));
        push_key(&mut keys, &stem_key(key));
    }
    let mut found = None;
    for key in &keys {
        if let Some(&i) = index.get(&normalize_key(key)) {
            found = Some(i);
            break;
        }
    }
    if let Some(i) = found {
        let existing = &mut apps[i];
        if existing.display_name.eq_ignore_ascii_case(&existing.identifier) && !app.display_name.is_empty() {
            existing.display_name = app.display_name.clone();
        }
        if existing.target_path.is_none() {
            existing.target_path = app.target_path.clone();
        }
        if existing.identifier.contains(' ') && app.identifier.to_ascii_lowercase().ends_with(".exe") {
            existing.identifier = app.identifier.clone();
        }
        for key in app.process_keys {
            push_key(&mut existing.process_keys, &key);
        }
        for key in keys {
            index.insert(normalize_key(&key), i);
        }
        return;
    }
    let i = apps.len();
    for key in keys {
        index.insert(normalize_key(&key), i);
    }
    apps.push(app);
}

fn finish_app(mut app: ShellApp) -> Option<ShellApp> {
    if let Some(path) = &app.target_path {
        if is_http(path) {
            return None;
        }
        push_key(&mut app.process_keys, &exe_key(path));
        if path.to_ascii_lowercase().contains("\\windowsapps\\") {
            push_key(&mut app.process_keys, &format!("\\windowsapps\\__{}", exe_key(path)));
        }
    }
    for extra in extra_keys(&app.identifier, app.target_path.as_deref()) {
        push_key(&mut app.process_keys, &extra);
    }
    if app.identifier.is_empty() {
        app.identifier = canonical_id(&app.display_name, app.target_path.as_deref(), "");
    }
    if app.display_name.is_empty() {
        app.display_name = app.identifier.clone();
    }
    if app.identifier.is_empty() {
        return None;
    }
    Some(app)
}

fn resolve_shortcut(link: &IShellLinkW, persist: &IPersistFile, path: &Path) -> Option<String> {
    let wide = wide(path);
    unsafe {
        persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
        let _ = link.Resolve(HWND::default(), (SLR_NO_UI.0 | SLR_NOUPDATE.0) as u32);
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut::<WIN32_FIND_DATAW>(), 0).ok()?;
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let target = String::from_utf16_lossy(&buf[..end]);
        let target = strip_quotes(&target);
        if target.is_empty() {
            None
        } else {
            Some(target)
        }
    }
}

fn walk_files(root: &Path, recursive: bool, files: &mut Vec<PathBuf>) {
    fn walk(dir: &Path, recursive: bool, depth: usize, files: &mut Vec<PathBuf>) {
        if depth > MAX_DEPTH || files.len() >= MAX_WALK {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if files.len() >= MAX_WALK {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                if recursive {
                    walk(&path, true, depth + 1, files);
                }
            } else {
                files.push(path);
            }
        }
    }
    walk(root, recursive, 0, files);
}

fn scan_start_menu(root: &Path, link: Option<&IShellLinkW>, persist: Option<&IPersistFile>, out: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>) {
    let mut files = Vec::new();
    walk_files(root, true, &mut files);
    for path in files {
        let name = file_name(&path);
        if skip_entry_name(&name) {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".lnk") || lower.ends_with(".exe") || lower.ends_with(".appref-ms")) {
            continue;
        }
        let display = file_stem_name(&path);
        let resolved = if lower.ends_with(".lnk") {
            match (link, persist) {
                (Some(link), Some(persist)) => resolve_shortcut(link, persist, &path),
                _ => None,
            }
        } else {
            Some(path.to_string_lossy().into_owned())
        };
        let target = resolved.or_else(|| Some(path.to_string_lossy().into_owned()));
        let identifier = canonical_id(&display, target.as_deref(), &name);
        let mut process_keys = Vec::new();
        push_key(&mut process_keys, &identifier);
        if let Some(target) = &target {
            push_key(&mut process_keys, &exe_key(target));
        }
        let app = ShellApp {
            display_name: display,
            identifier,
            target_path: target,
            process_keys,
            product_name: String::new(),
        };
        if let Some(app) = finish_app(app) {
            upsert(out, index, app);
        }
    }
}

fn scan_windows_apps(root: &Path, out: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>) {
    let mut files = Vec::new();
    walk_files(root, false, &mut files);
    for path in files {
        let name = file_name(&path);
        if skip_entry_name(&name) {
            continue;
        }
        if !name.to_ascii_lowercase().ends_with(".exe") {
            continue;
        }
        let display = file_stem_name(&path);
        let identifier = name.clone();
        let target = path.to_string_lossy().into_owned();
        let mut process_keys = vec![identifier.clone(), exe_key(&identifier)];
        push_key(&mut process_keys, &format!("\\windowsapps\\__{}", exe_key(&identifier)));
        let app = ShellApp {
            display_name: display,
            identifier,
            target_path: Some(target),
            process_keys,
            product_name: String::new(),
        };
        if let Some(app) = finish_app(app) {
            upsert(out, index, app);
        }
    }
}

fn pwstr_to_string(ptr: PWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let text = unsafe { ptr.to_string().unwrap_or_default() };
    unsafe { CoTaskMemFree(Some(ptr.0 as *const core::ffi::c_void)) };
    text
}

static LAST_APPSFOLDER_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn last_appsfolder_error() -> Option<String> {
    LAST_APPSFOLDER_ERROR.lock().ok().and_then(|g| g.clone())
}

fn set_appsfolder_error(message: impl Into<String>) {
    if let Ok(mut slot) = LAST_APPSFOLDER_ERROR.lock() {
        *slot = Some(message.into());
    }
}

fn clear_appsfolder_error() {
    if let Ok(mut slot) = LAST_APPSFOLDER_ERROR.lock() {
        *slot = None;
    }
}

fn scan_apps_folder(out: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>) -> Result<(), Error> {
    ensure_com().map_err(Error::desktop)?;
    let folder = unsafe {
        SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)
            .or_else(|_| SHCreateItemFromParsingName(w!("shell:AppsFolder"), None::<&IBindCtx>))
    }
    .map_err(|_| Error::desktop(APPSFOLDER_OPEN))?;
    let enumerator: IEnumShellItems = unsafe { folder.BindToHandler(None::<&IBindCtx>, &BHID_EnumItems) }
        .map_err(|_| Error::desktop(APPSFOLDER_ENUM))?;
    loop {
        let mut slot: [Option<IShellItem>; 1] = [None];
        let mut fetched = 0u32;
        let _ = unsafe { enumerator.Next(&mut slot, Some(&mut fetched)) };
        if fetched == 0 {
            break;
        }
        let Some(item) = slot[0].take() else {
            set_appsfolder_error(APPSFOLDER_ITEM);
            continue;
        };
        let display = unsafe { item.GetDisplayName(SIGDN_NORMALDISPLAY) }
            .map(pwstr_to_string)
            .unwrap_or_default();
        let parsing = unsafe { item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING) }
            .map(pwstr_to_string)
            .unwrap_or_default();
        let parsing = parsing
            .trim()
            .trim_start_matches("shell:AppsFolder\\")
            .trim_start_matches("shell:AppsFolder/")
            .to_string();
        if display.is_empty() || parsing.is_empty() || parsing.starts_with("::") {
            continue;
        }
        let identifier = if parsing.contains('!') {
            parsing.clone()
        } else {
            canonical_id(&display, None, &parsing)
        };
        let mut process_keys = vec![identifier.clone(), parsing];
        if identifier.contains('!') {
            process_keys.push(format!("app-user-model-id:{identifier}"));
        }
        let app = ShellApp {
            display_name: display,
            identifier,
            target_path: None,
            process_keys,
            product_name: String::new(),
        };
        if let Some(app) = finish_app(app) {
            upsert(out, index, app);
        }
    }
    Ok(())
}

fn open_key(root: HKEY, sub: &str) -> Option<HKEY> {
    let mut key = HKEY::default();
    let path: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
    let status = unsafe { RegOpenKeyExW(root, PCWSTR(path.as_ptr()), Some(0), KEY_READ, &mut key) };
    if status == ERROR_SUCCESS {
        Some(key)
    } else {
        None
    }
}

fn enum_subkeys(key: HKEY) -> Vec<String> {
    let mut names = Vec::new();
    let mut index = 0u32;
    loop {
        let mut name = [0u16; 512];
        let mut name_len = name.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(key, index, Some(PWSTR(name.as_mut_ptr())), &mut name_len, None, None, None, None)
        };
        if status != ERROR_SUCCESS {
            break;
        }
        index += 1;
        names.push(String::from_utf16_lossy(&name[..name_len as usize]));
        if names.len() >= MAX_WALK {
            break;
        }
    }
    names
}

fn reg_sz(key: HKEY, value: &str) -> Option<String> {
    let name: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut kind = REG_VALUE_TYPE(0);
    let mut data = vec![0u8; 4096];
    let mut len = data.len() as u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut kind),
            Some(data.as_mut_ptr()),
            Some(&mut len),
        )
    };
    if status != ERROR_SUCCESS || (kind != REG_SZ && kind != REG_EXPAND_SZ) {
        return None;
    }
    let n = (len as usize / 2).saturating_sub(1);
    let wide = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u16, n.min(data.len() / 2)) };
    let text = strip_quotes(&String::from_utf16_lossy(wide));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn icon_exe(display_icon: &str) -> Option<String> {
    let cleaned = strip_quotes(display_icon);
    let path = cleaned.split(',').next().unwrap_or(&cleaned).trim();
    if path.to_ascii_lowercase().ends_with(".exe") {
        Some(path.to_string())
    } else {
        None
    }
}

fn scan_app_paths(root: HKEY, sub: &str, out: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>) {
    let Some(key) = open_key(root, sub) else {
        return;
    };
    for name in enum_subkeys(key) {
        if !name.to_ascii_lowercase().ends_with(".exe") {
            continue;
        }
        let child_path = format!("{sub}\\{name}");
        let Some(child) = open_key(root, &child_path) else {
            continue;
        };
        let target = reg_sz(child, "").or_else(|| Some(name.clone()));
        let _ = unsafe { RegCloseKey(child) };
        let identifier = path_leaf(&name);
        let display = file_stem_name(Path::new(&identifier));
        let mut process_keys = vec![identifier.clone()];
        if let Some(target) = &target {
            push_key(&mut process_keys, &exe_key(target));
        }
        let app = ShellApp {
            display_name: display,
            identifier,
            target_path: target,
            process_keys,
            product_name: String::new(),
        };
        if let Some(app) = finish_app(app) {
            upsert(out, index, app);
        }
    }
    let _ = unsafe { RegCloseKey(key) };
}

fn scan_uninstall(root: HKEY, sub: &str, out: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>) {
    let Some(key) = open_key(root, sub) else {
        return;
    };
    for name in enum_subkeys(key) {
        let child_path = format!("{sub}\\{name}");
        let Some(child) = open_key(root, &child_path) else {
            continue;
        };
        let display = reg_sz(child, "DisplayName").unwrap_or_default();
        let icon = reg_sz(child, "DisplayIcon");
        let _ = unsafe { RegCloseKey(child) };
        if display.is_empty() || skip_entry_name(&display) {
            continue;
        }
        let target = icon.as_deref().and_then(icon_exe);
        if target.is_none() {
            continue;
        }
        let identifier = canonical_id(&display, target.as_deref(), &display);
        let mut process_keys = vec![identifier.clone()];
        if let Some(target) = &target {
            push_key(&mut process_keys, &exe_key(target));
        }
        let app = ShellApp {
            display_name: display,
            identifier,
            target_path: target,
            process_keys,
            product_name: String::new(),
        };
        if let Some(app) = finish_app(app) {
            upsert(out, index, app);
        }
    }
    let _ = unsafe { RegCloseKey(key) };
}

fn scan_appx_applications(root: HKEY, sub: &str, out: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>) {
    let Some(key) = open_key(root, sub) else {
        return;
    };
    for name in enum_subkeys(key) {
        if !name.contains('!') {
            continue;
        }
        let display = name
            .split('!')
            .next()
            .unwrap_or(&name)
            .split('_')
            .next()
            .unwrap_or(&name)
            .replace('.', " ");
        let mut process_keys = vec![name.clone(), format!("app-user-model-id:{name}")];
        for extra in extra_keys(&name, None) {
            push_key(&mut process_keys, &extra);
        }
        let app = ShellApp {
            display_name: display,
            identifier: name,
            target_path: None,
            process_keys,
            product_name: String::new(),
        };
        if let Some(app) = finish_app(app) {
            upsert(out, index, app);
        }
    }
    let _ = unsafe { RegCloseKey(key) };
}

fn scan_appx_packages(out: &mut Vec<ShellApp>, index: &mut HashMap<String, usize>) {
    let Some(key) = open_key(HKEY_CURRENT_USER, HKCU_PACKAGES) else {
        return;
    };
    for pkg in enum_subkeys(key) {
        let apps_path = format!("{HKCU_PACKAGES}\\{pkg}\\Applications");
        let Some(apps_key) = open_key(HKEY_CURRENT_USER, &apps_path) else {
            continue;
        };
        for app_name in enum_subkeys(apps_key) {
            let child_path = format!("{apps_path}\\{app_name}");
            let Some(child) = open_key(HKEY_CURRENT_USER, &child_path) else {
                continue;
            };
            let aumid = reg_sz(child, "ApplicationUserModelId").unwrap_or_else(|| {
                if app_name.contains('!') {
                    app_name.clone()
                } else {
                    format!("{pkg}!{app_name}")
                }
            });
            let _ = unsafe { RegCloseKey(child) };
            if aumid.is_empty() {
                continue;
            }
            let display = aumid
                .split('!')
                .next()
                .unwrap_or(&aumid)
                .split('_')
                .next()
                .unwrap_or(&aumid)
                .replace('.', " ");
            let mut process_keys = vec![aumid.clone(), format!("app-user-model-id:{aumid}")];
            for extra in extra_keys(&aumid, None) {
                push_key(&mut process_keys, &extra);
            }
            let app = ShellApp {
                display_name: display,
                identifier: aumid,
                target_path: None,
                process_keys,
                product_name: String::new(),
            };
            if let Some(app) = finish_app(app) {
                upsert(out, index, app);
            }
        }
        let _ = unsafe { RegCloseKey(apps_key) };
    }
    let _ = unsafe { RegCloseKey(key) };
}

fn shortcut_pair() -> Option<(IShellLinkW, IPersistFile)> {
    ensure_com().ok()?;
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        Some((link, persist))
    }
}

fn rebuild_installed() -> Vec<ShellApp> {
    let mut apps = Vec::new();
    let mut index = HashMap::new();
    note_rebuild_stage("shortcut-pair");
    let pair = shortcut_pair();
    let (link, persist) = match &pair {
        Some((link, persist)) => (Some(link), Some(persist)),
        None => (None, None),
    };
    if let Some(path) = env_join("APPDATA", START_MENU_TAIL) {
        note_rebuild_stage("start-menu-user");
        scan_start_menu(&path, link, persist, &mut apps, &mut index);
    }
    if let Some(path) = env_join("ProgramData", START_MENU_TAIL) {
        note_rebuild_stage("start-menu-machine");
        scan_start_menu(&path, link, persist, &mut apps, &mut index);
    }
    if let Some(path) = env_join("LOCALAPPDATA", WINDOWSAPPS_TAIL) {
        note_rebuild_stage("windows-apps-aliases");
        scan_windows_apps(&path, &mut apps, &mut index);
    }
    note_rebuild_stage("apps-folder");
    clear_appsfolder_error();
    if let Err(err) = scan_apps_folder(&mut apps, &mut index) {
        set_appsfolder_error(err.message.clone());
    }
    note_rebuild_stage("app-paths-hkcu");
    scan_app_paths(HKEY_CURRENT_USER, APP_PATHS, &mut apps, &mut index);
    note_rebuild_stage("app-paths-hklm");
    scan_app_paths(HKEY_LOCAL_MACHINE, APP_PATHS, &mut apps, &mut index);
    note_rebuild_stage("uninstall-hkcu");
    scan_uninstall(HKEY_CURRENT_USER, UNINSTALL, &mut apps, &mut index);
    note_rebuild_stage("uninstall-hklm");
    scan_uninstall(HKEY_LOCAL_MACHINE, UNINSTALL, &mut apps, &mut index);
    note_rebuild_stage("uninstall-wow64");
    scan_uninstall(HKEY_LOCAL_MACHINE, UNINSTALL_WOW64, &mut apps, &mut index);
    note_rebuild_stage("appx-packages");
    scan_appx_packages(&mut apps, &mut index);
    note_rebuild_stage("appx-applications");
    scan_appx_applications(HKEY_LOCAL_MACHINE, HKLM_APPX, &mut apps, &mut index);
    // Resolve PE product names here, on the background thread. Doing it in the request
    // path is what turned one `list_apps` into 31.5 s of executable opens.
    note_rebuild_stage("product-names");
    for app in apps.iter_mut() {
        if app.product_name.is_empty() {
            if let Some(path) = app.target_path.as_deref() {
                app.product_name = product_name(path).unwrap_or_default();
            }
        }
    }
    note_rebuild_stage("done");
    apps
}

fn write_cache(apps: &[ShellApp], signals: &[ChangeSignal], cached_at: u64) {
    let Some(path) = cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let envelope = SessionCacheEnvelope {
        cached_at_unix_seconds: cached_at,
        value: ShellInstallState {
            apps: apps.to_vec(),
            signals: signals.to_vec(),
        },
    };
    if let Ok(bytes) = serde_json::to_vec(&envelope) {
        let _ = fs::write(path, bytes);
    }
}

fn read_cache(signals: &[ChangeSignal]) -> Option<Vec<ShellApp>> {
    let path = cache_path()?;
    let bytes = fs::read(path).ok()?;
    let envelope: SessionCacheEnvelope = serde_json::from_slice(&bytes).ok()?;
    let now = now_unix();
    if now.saturating_sub(envelope.cached_at_unix_seconds) >= CACHE_TTL_SECS {
        return None;
    }
    if envelope.value.signals != *signals {
        return None;
    }
    Some(envelope.value.apps)
}

fn read_cache_any() -> Option<(Vec<ShellApp>, Vec<ChangeSignal>, u64)> {
    let path = cache_path()?;
    let bytes = fs::read(path).ok()?;
    let envelope: SessionCacheEnvelope = serde_json::from_slice(&bytes).ok()?;
    Some((
        envelope.value.apps,
        envelope.value.signals,
        envelope.cached_at_unix_seconds,
    ))
}

fn installed_apps() -> Vec<ShellApp> {
    let started = Instant::now();
    let signals = collect_signals();
    SIGNALS_MS.store(ms_since(started), Ordering::Relaxed);
    SIGNALS_COUNT.store(signals.len() as u64, Ordering::Relaxed);
    let now = now_unix();
    {
        let mut guard = catalog_cell().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.as_ref() {
            let fresh = now.saturating_sub(cached.cached_at) < CACHE_TTL_SECS && cached.signals == signals;
            if !fresh {
                kick_rebuild(signals.clone());
            }
            let apps = cached.apps.clone();
            note_cache_source(if fresh { "memory-fresh" } else { "memory-stale" });
            INSTALLED_MS.store(ms_since(started), Ordering::Relaxed);
            CATALOG_APPS.store(apps.len() as u64, Ordering::Relaxed);
            return apps;
        }
        if let Some(apps) = read_cache(&signals) {
            *guard = Some(CachedCatalog {
                apps: apps.clone(),
                signals: signals.clone(),
                cached_at: now,
            });
            note_cache_source("disk-fresh");
            INSTALLED_MS.store(ms_since(started), Ordering::Relaxed);
            CATALOG_APPS.store(apps.len() as u64, Ordering::Relaxed);
            return apps;
        }
        if let Some((apps, cached_signals, cached_at)) = read_cache_any() {
            *guard = Some(CachedCatalog {
                apps: apps.clone(),
                signals: cached_signals,
                cached_at,
            });
            kick_rebuild(signals);
            note_cache_source("disk-stale");
            INSTALLED_MS.store(ms_since(started), Ordering::Relaxed);
            CATALOG_APPS.store(apps.len() as u64, Ordering::Relaxed);
            return apps;
        }
    }
    kick_rebuild(signals);
    note_cache_source("none");
    INSTALLED_MS.store(ms_since(started), Ordering::Relaxed);
    Vec::new()
}

fn window_match_keys(window: &WindowRef) -> Vec<String> {
    // `window.app` is the official `process:<full path>` form (CW-5); the bare path is
    // added so installed-app entries stored as plain paths still match.
    let bare = crate::enum_windows::strip_app_prefix(&window.app).to_string();
    let mut keys = vec![window.app.clone(), bare, exe_key(&window.app), stem_key(&window.app)];
    let hwnd = hwnd_from_id(window.id);
    let pid = window_pid(hwnd);
    if let Some(path) = exe_path(pid) {
        push_key(&mut keys, &path);
        push_key(&mut keys, &exe_key(&path));
        push_key(&mut keys, &stem_key(&path));
        if path.to_ascii_lowercase().contains("\\windowsapps\\") {
            push_key(&mut keys, &format!("\\windowsapps\\__{}", exe_key(&path)));
        }
    } else {
        if let Some(name) = exe_name(pid) {
            push_key(&mut keys, &name);
            push_key(&mut keys, &stem_key(&name));
        }
    }
    let aumid = policy::process_aumid(pid);
    if !aumid.is_empty() {
        push_key(&mut keys, &aumid);
        push_key(&mut keys, &format!("app-user-model-id:{aumid}"));
        for extra in extra_keys(&aumid, Some(&window.app)) {
            push_key(&mut keys, &extra);
        }
    }
    keys
}

fn attach_usage(app: &mut AppInfo, shell: Option<&ShellApp>, usage: &HashMap<String, assist::Usage>) {
    let mut keys = vec![app.id.as_str(), app.display_name.as_str()];
    let extra: Vec<String> = shell
        .map(|s| {
            let mut v = s.process_keys.clone();
            if let Some(path) = &s.target_path {
                v.push(path.clone());
            }
            v.push(s.identifier.clone());
            v
        })
        .unwrap_or_default();
    let extra_ref: Vec<&str> = extra.iter().map(String::as_str).collect();
    keys.extend(extra_ref);
    let (count, last) = assist::merge_usage_keys(keys, usage);
    app.use_count = count;
    app.last_used_date = last;
}

/// Installed Start Menu / WindowsApps / registry apps merged with open windows + UserAssist.
pub fn list_apps(windows: &[WindowRef]) -> Vec<AppInfo> {
    let started = Instant::now();
    let installed = installed_apps();
    let merge_started = Instant::now();
    let apps = list_apps_merge(installed, windows);
    MERGE_MS.store(ms_since(merge_started), Ordering::Relaxed);
    LIST_MS.store(ms_since(started), Ordering::Relaxed);
    apps
}

fn list_apps_merge(installed: Vec<ShellApp>, windows: &[WindowRef]) -> Vec<AppInfo> {
    let usage = assist::read_user_assist();
    let mut apps: Vec<AppInfo> = Vec::new();
    let mut shells: Vec<Option<ShellApp>> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for shell in &installed {
        let i = apps.len();
        let mut keys = vec![shell.identifier.clone()];
        for key in &shell.process_keys {
            push_key(&mut keys, key);
            push_key(&mut keys, &exe_key(key));
            push_key(&mut keys, &stem_key(key));
        }
        if let Some(path) = &shell.target_path {
            push_key(&mut keys, path);
            push_key(&mut keys, &exe_key(path));
        }
        for key in &keys {
            index.entry(normalize_key(key)).or_insert(i);
        }
        apps.push(AppInfo {
            id: shell.identifier.clone(),
            display_name: installed_display_name(&shell.display_name, &shell.product_name),
            is_running: false,
            windows: Vec::new(),
            use_count: None,
            last_used_date: None,
        });
        shells.push(Some(shell.clone()));
    }

    for window in windows {
        let keys = window_match_keys(window);
        let mut hit = None;
        for key in &keys {
            if let Some(&i) = index.get(&normalize_key(key)) {
                hit = Some(i);
                break;
            }
        }
        if let Some(i) = hit {
            let id = apps[i].id.clone();
            apps[i].is_running = true;
            apps[i].windows.push(WindowRef {
                app: id,
                id: window.id,
                title: window.title.clone(),
            });
        } else {
            let i = apps.len();
            for key in &keys {
                index.entry(normalize_key(key)).or_insert(i);
            }
            let pid = window_pid(hwnd_from_id(window.id));
            let display = crate::enum_windows::app_base_name(&window.app);
            let mut app = AppInfo {
                id: window.app.clone(),
                display_name: prefer_product_name(&display, exe_path(pid).as_deref()),
                is_running: true,
                windows: vec![window.clone()],
                use_count: None,
                last_used_date: None,
            };
            attach_usage(&mut app, None, &usage);
            apps.push(app);
            shells.push(None);
        }
    }

    let running = crate::enum_windows::running_exe_stems();
    for (app, shell) in apps.iter_mut().zip(shells.iter()) {
        attach_usage(app, shell.as_ref(), &usage);
        if app.is_running {
            continue;
        }
        let mut keys = vec![app.id.clone(), app.display_name.clone()];
        if let Some(shell) = shell {
            keys.extend(shell.process_keys.iter().cloned());
            if let Some(path) = &shell.target_path {
                keys.push(path.clone());
                keys.push(exe_key(path));
                keys.push(stem_key(path));
            }
        }
        if keys_match_running(&keys, &running) {
            app.is_running = true;
        }
    }

    apps.sort_by(|a, b| {
        b.is_running
            .cmp(&a.is_running)
            .then_with(|| b.use_count.unwrap_or(0).cmp(&a.use_count.unwrap_or(0)))
            .then_with(|| a.display_name.to_ascii_lowercase().cmp(&b.display_name.to_ascii_lowercase()))
    });
    apps
}

fn keys_match_running(keys: &[String], running: &std::collections::HashSet<String>) -> bool {
    keys.iter().any(|key| {
        let file = exe_key(key);
        let stem = stem_key(key);
        running.contains(&file) || running.contains(&stem)
    })
}

const MISSING_LAUNCH_ID: &str =
    "launch_app requires an installed app id from list_apps or a launchable executable identifier";
const PID_LAUNCH_ID: &str = "launch_app does not support pid app identifiers";
const PACKAGED_REQUIRED: &str = "app policy requires a registered packaged app";
const PACKAGE_INVALID_STATE: &str = "app package is not in a valid state";
const PACKAGE_NOT_SIGNED: &str = "app package is not signed";
const PACKAGE_IDENTITY_MISMATCH: &str = "registered app identity does not match the launch target";
const RESOLVED_EXE_PATH: &str = "app policy requires a resolved executable path";
const EXE_LAUNCH_TARGET: &str = "app policy requires an executable launch target";
const CATALOG_IDENTITY_CHANGED: &str = "app catalog identity changed before launch";
const CATALOG_NOT_LAUNCHABLE: &str = "app catalog entry is not launchable";
const DECODE_SHELL: &str = "failed to decode shell string";
const APPSFOLDER_ITEM_ID: &str = "app catalog item has no launch identifier";
const APPSFOLDER_LAUNCH: &str = "failed to launch the verified app catalog item";
const APPSFOLDER_RESOLVE: &str = "failed to resolve the current app catalog entry";
const LAUNCH_WAIT: Duration = Duration::from_millis(12_000);
const LAUNCH_POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug)]
pub struct LaunchTargetInfo {
    pub requested: String,
    pub identity: String,
    pub launch_file: String,
    pub product_name: Option<String>,
    pub original_filename: Option<String>,
}

impl LaunchTargetInfo {
    /// Friendly name for the approval prompt. The official
    /// `AppApprovalRequest.displayName` is the app's user-visible name, not a raw
    /// identifier, so prefer the executable's `ProductName`, then its
    /// `OriginalFilename`, then the file stem.
    pub fn display_name(&self) -> String {
        if let Some(name) = self.product_name.as_ref().filter(|n| !n.trim().is_empty()) {
            return name.trim().to_string();
        }
        if let Some(name) = self.original_filename.as_ref().filter(|n| !n.trim().is_empty()) {
            return name.trim().to_string();
        }
        let leaf = self
            .launch_file
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&self.launch_file)
            .trim();
        if leaf.is_empty() {
            self.requested.clone()
        } else {
            leaf.to_string()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum LaunchKind {
    Executable(String),
    Packaged(String),
    AppsFolder(String),
}

#[derive(Clone, Debug)]
struct LaunchPlan {
    requested: String,
    identity: String,
    kind: LaunchKind,
    keys: Vec<String>,
}

impl LaunchPlan {
    fn launch_file(&self) -> String {
        match &self.kind {
            LaunchKind::Executable(path) => path.clone(),
            LaunchKind::Packaged(aumid) => aumid.clone(),
            LaunchKind::AppsFolder(id) => format!("shell:AppsFolder\\{id}"),
        }
    }
}

fn looks_like_pid(app: &str) -> bool {
    let lower = app.trim().to_ascii_lowercase();
    lower.starts_with("pid-") || lower.starts_with("pid:") || lower.starts_with("pid ")
}

fn is_exe_or_lnk(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".exe") || lower.ends_with(".lnk")
}

fn is_aumid(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.contains('!') && !trimmed.contains('\\') && !trimmed.contains('/')
}

fn verify_aumid_format(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let wide: Vec<u16> = trimmed.encode_utf16().chain(std::iter::once(0)).collect();
    let err = unsafe { VerifyApplicationUserModelId(PCWSTR(wide.as_ptr())) };
    err == ERROR_SUCCESS
}

fn family_of(value: &str) -> String {
    let trimmed = value.trim();
    trimmed
        .split_once('!')
        .map(|(fam, _)| fam.to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

fn registered_matches_launch(registered: &str, family: &str, aumid: &str, launch_target: &str) -> bool {
    let reg = normalize_key(registered);
    let fam = normalize_key(family);
    let aumid_n = normalize_key(aumid);
    let target_n = normalize_key(launch_target);
    if !reg.is_empty() && (reg == aumid_n || (!target_n.is_empty() && reg == target_n)) {
        return true;
    }
    let aumid_fam = normalize_key(&family_of(&aumid_n));
    let target_fam = normalize_key(&family_of(&target_n));
    if !fam.is_empty()
        && (fam == aumid_fam
            || (!target_fam.is_empty() && fam == target_fam)
            || (!target_n.is_empty() && fam == target_n))
    {
        return true;
    }
    false
}

fn strip_extended(path: String) -> String {
    let trimmed = path.trim();
    if let Some(rest) = trimmed.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = trimmed.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Accept every official AppIdentifier prefix (CW-5) plus the shell namespace form
/// `launch_app` also understands. The official prefix list is owned by
/// `enum_windows::strip_app_prefix` so the emit side and the accept side cannot drift.
fn strip_known_prefixes(app: &str) -> String {
    let stripped = crate::enum_windows::strip_app_prefix(app);
    let lower = stripped.to_ascii_lowercase();
    for prefix in [r"shell:appsfolder\", "shell:appsfolder/"] {
        if lower.starts_with(prefix) {
            return stripped[prefix.len()..].trim().trim_matches('"').trim().to_string();
        }
    }
    stripped.to_string()
}

fn looks_launchable(app: &str) -> bool {
    let trimmed = app.trim();
    if trimmed.is_empty() {
        return false;
    }
    if Path::new(trimmed).is_file() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.ends_with(".exe") || lower.ends_with(".lnk") || trimmed.contains('!') || trimmed.contains('\\')
}

fn search_path(name: &str) -> Option<String> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 32768];
    let n = unsafe {
        SearchPathW(
            PCWSTR::null(),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            Some(&mut buf),
            None,
        )
    };
    if n == 0 {
        return None;
    }
    let len = (n as usize).min(buf.len());
    let end = if len > 0 && buf[len - 1] == 0 { len - 1 } else { len };
    let found = String::from_utf16_lossy(&buf[..end]);
    if found.is_empty() {
        None
    } else {
        Some(found)
    }
}

fn resolve_exe_file(path: &str) -> Option<String> {
    let path = strip_quotes(path);
    if path.is_empty() || is_http(&path) {
        return None;
    }
    let candidate = if Path::new(&path).is_file() {
        path
    } else if is_exe_or_lnk(&path) {
        search_path(&path)?
    } else {
        return None;
    };
    fs::canonicalize(&candidate)
        .ok()
        .map(|p| strip_extended(p.to_string_lossy().into_owned()))
        .filter(|p| Path::new(p).is_file() && is_exe_or_lnk(p))
}

fn verify_exe_identity(path: &str) -> Result<policy::VersionIdentity, Error> {
    let id = policy::version_identity(path).map_err(Error::desktop)?;
    policy::deny_product_identity(&id.product_name, id.original_filename.as_deref()).map_err(Error::desktop)?;
    Ok(id)
}

fn verify_executable(path: &str) -> Result<String, Error> {
    let first = resolve_exe_file(path).ok_or_else(|| {
        if Path::new(path).is_absolute() || path.contains('\\') || path.contains('/') {
            Error::desktop("executable path could not be resolved")
        } else {
            Error::desktop(EXE_LAUNCH_TARGET)
        }
    })?;
    let second = resolve_exe_file(path).ok_or_else(|| Error::desktop("executable path could not be resolved"))?;
    if normalize_key(&first) != normalize_key(&second) {
        return Err(Error::desktop("executable path changed while resolving it"));
    }
    if !Path::new(&first).is_absolute() {
        return Err(Error::desktop("app policy requires an absolute executable path"));
    }
    if first.to_ascii_lowercase().ends_with(".exe") {
        if let Err(err) = verify_exe_identity(&first) {
            if !soft_version_identity_error(&err.message) {
                return Err(err);
            }
        }
    }
    Ok(first)
}

fn soft_version_identity_error(message: &str) -> bool {
    message == policy::ERR_UNTERMINATED_VERSION_STRING
        || message == policy::ERR_INVALID_VERSION_STRING
        || message == policy::ERR_NO_VERSION_INFO
        || message == policy::ERR_NO_TRANSLATIONS
        || message == policy::ERR_NO_PRODUCT_NAME
        || message == policy::ERR_INCOMPLETE_IDENTITY
}

fn catalog_matches<'a>(app: &'a str, installed: &'a [ShellApp]) -> Vec<&'a ShellApp> {
    let needle = strip_known_prefixes(app);
    let stripped = normalize_key(&needle);
    let mut exact = Vec::new();
    let mut fuzzy = Vec::new();
    for shell in installed {
        let id = normalize_key(&shell.identifier);
        let display = normalize_key(&shell.display_name);
        if id == stripped || display == stripped {
            exact.push(shell);
            continue;
        }
        if shell.process_keys.iter().any(|k| normalize_key(k) == stripped || exe_key(k) == stripped || stem_key(k) == stripped) {
            exact.push(shell);
            continue;
        }
        if let Some(path) = &shell.target_path {
            if normalize_key(path) == stripped || exe_key(path) == stripped {
                exact.push(shell);
                continue;
            }
        }
        if !stripped.is_empty() && stripped.len() >= 3 && (id.contains(&stripped) || display.contains(&stripped)) {
            fuzzy.push(shell);
        }
    }
    if !exact.is_empty() {
        exact
    } else {
        fuzzy
    }
}

fn keys_from_shell(shell: &ShellApp) -> Vec<String> {
    let mut keys = Vec::new();
    push_key(&mut keys, &shell.identifier);
    push_key(&mut keys, &shell.display_name);
    if let Some(path) = &shell.target_path {
        push_key(&mut keys, path);
        push_key(&mut keys, &exe_key(path));
        push_key(&mut keys, &stem_key(path));
    }
    for key in &shell.process_keys {
        push_key(&mut keys, key);
        push_key(&mut keys, &exe_key(key));
        push_key(&mut keys, &stem_key(key));
    }
    keys
}

fn keys_from_exe(path: &str) -> Vec<String> {
    let mut keys = Vec::new();
    push_key(&mut keys, path);
    push_key(&mut keys, &exe_key(path));
    push_key(&mut keys, &stem_key(path));
    keys
}

fn keys_from_aumid(aumid: &str) -> Vec<String> {
    let mut keys = Vec::new();
    push_key(&mut keys, aumid);
    push_key(&mut keys, &format!("app-user-model-id:{aumid}"));
    for extra in extra_keys(aumid, None) {
        push_key(&mut keys, &extra);
    }
    keys
}

fn plan_from_shell(requested: &str, shell: &ShellApp) -> Result<LaunchPlan, Error> {
    if shell.identifier.is_empty() {
        return Err(Error::desktop("app catalog entry has no canonical ID"));
    }
    let mut had_unresolved_target = false;
    if let Some(path) = &shell.target_path {
        if !is_http(path) {
            if let Some(exe) = resolve_exe_file(path) {
                let mut keys = keys_from_shell(shell);
                for key in keys_from_exe(&exe) {
                    push_key(&mut keys, &key);
                }
                return Ok(LaunchPlan {
                    requested: requested.to_string(),
                    identity: shell.identifier.clone(),
                    kind: LaunchKind::Executable(exe),
                    keys,
                });
            }
            had_unresolved_target = true;
        }
    }
    if is_aumid(&shell.identifier) {
        let mut keys = keys_from_shell(shell);
        for key in keys_from_aumid(&shell.identifier) {
            push_key(&mut keys, &key);
        }
        return Ok(LaunchPlan {
            requested: requested.to_string(),
            identity: shell.identifier.clone(),
            kind: LaunchKind::Packaged(shell.identifier.clone()),
            keys,
        });
    }
    if let Some(exe) = resolve_exe_file(&shell.identifier) {
        let mut keys = keys_from_shell(shell);
        for key in keys_from_exe(&exe) {
            push_key(&mut keys, &key);
        }
        return Ok(LaunchPlan {
            requested: requested.to_string(),
            identity: shell.identifier.clone(),
            kind: LaunchKind::Executable(exe),
            keys,
        });
    }
    if had_unresolved_target {
        if let Some(path) = &shell.target_path {
            if is_exe_or_lnk(path) {
                return Err(Error::desktop(RESOLVED_EXE_PATH));
            }
        }
    }
    if shell.identifier.is_empty() {
        return Err(Error::desktop(CATALOG_NOT_LAUNCHABLE));
    }
    let mut keys = keys_from_shell(shell);
    push_key(&mut keys, &shell.identifier);
    Ok(LaunchPlan {
        requested: requested.to_string(),
        identity: shell.identifier.clone(),
        kind: LaunchKind::AppsFolder(shell.identifier.clone()),
        keys,
    })
}

fn resolve_plan(app: &str) -> Result<LaunchPlan, Error> {
    let requested = strip_known_prefixes(app);
    if requested.is_empty() {
        return Err(Error::desktop(MISSING_LAUNCH_ID));
    }
    if looks_like_pid(&requested) {
        return Err(Error::desktop(PID_LAUNCH_ID));
    }
    if let Some(exe) = resolve_exe_file(&requested) {
        return Ok(LaunchPlan {
            requested: requested.clone(),
            identity: exe_key(&exe),
            kind: LaunchKind::Executable(exe.clone()),
            keys: keys_from_exe(&exe),
        });
    }
    let installed = installed_apps();
    let matches = catalog_matches(&requested, &installed);
    if matches.len() > 1 {
        let distinct: Vec<&str> = {
            let mut ids: Vec<&str> = matches.iter().map(|s| s.identifier.as_str()).collect();
            ids.sort();
            ids.dedup();
            ids
        };
        if distinct.len() > 1 {
            return Err(Error::desktop(format!(
                "app identifier {requested} is ambiguous; use the canonical app id from list_apps"
            )));
        }
    }
    if let Some(shell) = matches.first() {
        return plan_from_shell(&requested, shell);
    }
    if is_aumid(&requested) {
        return Ok(LaunchPlan {
            requested: requested.clone(),
            identity: requested.clone(),
            kind: LaunchKind::Packaged(requested.clone()),
            keys: keys_from_aumid(&requested),
        });
    }
    if looks_launchable(&requested) {
        if let Some(exe) = resolve_exe_file(&requested) {
            return Ok(LaunchPlan {
                requested: requested.clone(),
                identity: exe_key(&exe),
                kind: LaunchKind::Executable(exe.clone()),
                keys: keys_from_exe(&exe),
            });
        }
        if requested.contains('\\') || requested.contains('/') {
            return Err(Error::desktop("executable path could not be resolved"));
        }
    }
    Err(Error::desktop(MISSING_LAUNCH_ID))
}

pub fn resolve_launch_target(app: &str) -> Result<String, Error> {
    Ok(resolve_plan(app)?.launch_file())
}

pub fn resolve_launch_info(app: &str) -> Result<LaunchTargetInfo, Error> {
    let plan = resolve_plan(app)?;
    let launch_file = plan.launch_file();
    let (product_name, original_filename) = match &plan.kind {
        LaunchKind::Executable(path) if path.to_ascii_lowercase().ends_with(".exe") => {
            let id = verify_exe_identity(path)?;
            (Some(id.product_name), id.original_filename)
        }
        _ => (None, None),
    };
    Ok(LaunchTargetInfo {
        requested: plan.requested.clone(),
        identity: plan.identity.clone(),
        launch_file,
        product_name,
        original_filename,
    })
}

pub fn launch_target_approved(approved: &HashSet<String>, app: &str, info: &LaunchTargetInfo) -> bool {
    if approved.is_empty() {
        return false;
    }
    let mut keys = Vec::new();
    for value in [app, info.requested.as_str(), info.identity.as_str(), info.launch_file.as_str()] {
        push_key(&mut keys, value);
        push_key(&mut keys, &exe_key(value));
        push_key(&mut keys, &stem_key(value));
    }
    if let Some(name) = &info.product_name {
        push_key(&mut keys, name);
    }
    if let Some(name) = &info.original_filename {
        push_key(&mut keys, name);
        push_key(&mut keys, &exe_key(name));
        push_key(&mut keys, &stem_key(name));
    }
    approved.iter().any(|item| {
        let needle = normalize_key(item);
        !needle.is_empty() && keys.iter().any(|k| normalize_key(k) == needle)
    })
}

fn shell_execute_w_error(code: usize) -> String {
    format!("Windows failed to launch app (ShellExecuteW returned {code})")
}

/// Official exe launch: ShellExecuteW("open"); values < 33 are failures.
fn shell_execute_w(file: &str) -> Result<u32, Error> {
    if !Path::new(file).is_file() || !is_exe_or_lnk(file) {
        return Err(Error::desktop("failed to launch the verified executable"));
    }
    let wide: Vec<u16> = file.encode_utf16().chain(std::iter::once(0)).collect();
    let inst = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = inst.0 as usize;
    if code < 33 {
        return Err(Error::desktop(shell_execute_w_error(code)));
    }
    Ok(0)
}

fn open_appsfolder() -> Result<IShellItem, Error> {
    ensure_com().map_err(Error::desktop)?;
    unsafe {
        SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)
    }
    .map_err(|_| Error::desktop(APPSFOLDER_OPEN))
}

fn decode_shell_name(item: &IShellItem) -> Result<String, Error> {
    let pwstr = unsafe { item.GetDisplayName(SIGDN_NORMALDISPLAY) }
        .map_err(|_| Error::desktop(DECODE_SHELL))?;
    if pwstr.is_null() {
        return Err(Error::desktop(DECODE_SHELL));
    }
    let text = unsafe { pwstr.to_string() }.map_err(|_| Error::desktop(DECODE_SHELL))?;
    unsafe { CoTaskMemFree(Some(pwstr.0 as *const core::ffi::c_void)) };
    if text.is_empty() {
        Err(Error::desktop(DECODE_SHELL))
    } else {
        Ok(text)
    }
}

fn appsfolder_item(parse: &str) -> Result<IShellItem, Error> {
    ensure_com().map_err(Error::desktop)?;
    if parse.trim().is_empty() {
        return Err(Error::desktop(APPSFOLDER_ITEM_ID));
    }
    let wide: Vec<u16> = parse.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>) }
        .map_err(|_| Error::desktop(APPSFOLDER_RESOLVE))
}

/// Official catalog launch: SHGetIDListFromObject + ShellExecuteExW(SEE_MASK_IDLIST).
fn shell_execute_item(item: &IShellItem) -> Result<u32, Error> {
    let unknown: IUnknown = item
        .cast()
        .map_err(|_| Error::desktop(APPSFOLDER_LAUNCH))?;
    let pidl = unsafe { SHGetIDListFromObject(&unknown) }
        .map_err(|_| Error::desktop(APPSFOLDER_LAUNCH))?;
    if pidl.is_null() {
        return Err(Error::desktop(APPSFOLDER_LAUNCH));
    }
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_IDLIST | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS,
        lpIDList: pidl as *mut core::ffi::c_void,
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    let launched = unsafe { ShellExecuteExW(&mut info) };
    unsafe { CoTaskMemFree(Some(pidl as *const core::ffi::c_void)) };
    launched.map_err(|_| Error::desktop(APPSFOLDER_LAUNCH))?;
    if info.hProcess.is_invalid() {
        return Ok(0);
    }
    let pid = unsafe { GetProcessId(info.hProcess) };
    let _ = unsafe { CloseHandle(info.hProcess) };
    Ok(pid)
}

fn verify_packaged_app(aumid: &str, launch_target: &str) -> Result<String, Error> {
    let aumid = aumid.trim();
    if aumid.is_empty() || !verify_aumid_format(aumid) {
        return Err(Error::desktop(PACKAGED_REQUIRED));
    }
    ensure_com().map_err(Error::desktop)?;
    let info = PackagedAppInfo::GetFromAppUserModelId(&HSTRING::from(aumid))
        .map_err(|_| Error::desktop(PACKAGED_REQUIRED))?;
    let registered = info
        .AppUserModelId()
        .map_err(|_| Error::desktop(PACKAGED_REQUIRED))?
        .to_string();
    if registered.trim().is_empty() {
        return Err(Error::desktop(PACKAGED_REQUIRED));
    }
    let family = info
        .PackageFamilyName()
        .ok()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let package = info.Package().map_err(|_| Error::desktop(PACKAGED_REQUIRED))?;
    let status = package
        .Status()
        .map_err(|_| Error::desktop(PACKAGE_INVALID_STATE))?;
    if !status.VerifyIsOK().unwrap_or(false) {
        return Err(Error::desktop(PACKAGE_INVALID_STATE));
    }
    let kind = package
        .SignatureKind()
        .map_err(|_| Error::desktop(PACKAGE_NOT_SIGNED))?;
    if kind == PackageSignatureKind::None {
        return Err(Error::desktop(PACKAGE_NOT_SIGNED));
    }
    if let Ok(pkg_id) = package.Id() {
        if let Ok(pkg_family) = pkg_id.FamilyName() {
            let pkg_family = pkg_family.to_string();
            if !family.is_empty()
                && !pkg_family.is_empty()
                && normalize_key(&family) != normalize_key(&pkg_family)
            {
                return Err(Error::desktop(PACKAGE_IDENTITY_MISMATCH));
            }
        }
    }
    if !registered_matches_launch(&registered, &family, aumid, launch_target) {
        return Err(Error::desktop(PACKAGE_IDENTITY_MISMATCH));
    }
    Ok(registered)
}

fn activate_packaged(aumid: &str, launch_target: &str) -> Result<u32, Error> {
    let first = verify_packaged_app(aumid, launch_target)?;
    let second = verify_packaged_app(aumid, launch_target)?;
    if normalize_key(&first) != normalize_key(&second) {
        return Err(Error::desktop(PACKAGE_IDENTITY_MISMATCH));
    }
    ensure_com().map_err(Error::desktop)?;
    let manager: IApplicationActivationManager = unsafe {
        CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_INPROC_SERVER)
    }
    .map_err(|_| Error::desktop("failed to activate the verified packaged app"))?;
    let wide: Vec<u16> = second.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { manager.ActivateApplication(PCWSTR(wide.as_ptr()), w!(""), AO_NOERRORUI) }
        .map_err(|_| Error::desktop("failed to activate the verified packaged app"))
}

fn same_app_key(value: &str, needles: &[String]) -> bool {
    let value = normalize_key(value);
    if value.is_empty() {
        return false;
    }
    let value_exe = exe_key(&value);
    let value_stem = stem_key(&value);
    needles.iter().any(|needle| {
        needle == &value
            || needle == &value_exe
            || needle == &value_stem
            || exe_key(needle) == value_exe
            || (!value_stem.is_empty() && stem_key(needle) == value_stem)
    })
}

fn window_matches_plan(window: &WindowRef, keys: &[String], pid: u32) -> bool {
    let hwnd = hwnd_from_id(window.id);
    if pid != 0 && window_pid(hwnd) == pid {
        return true;
    }
    let needles: Vec<String> = keys.iter().map(|k| normalize_key(k)).filter(|k| !k.is_empty()).collect();
    if needles.is_empty() {
        return false;
    }
    if same_app_key(&window.app, &needles) {
        return true;
    }
    window_match_keys(window).iter().any(|key| same_app_key(key, &needles))
}

fn restore_matching(keys: &[String], pid: u32) -> Option<HWND> {
    if let Ok(windows) = enum_windows() {
        if let Some(window) = windows.into_iter().find(|w| window_matches_plan(w, keys, pid)) {
            let hwnd = hwnd_from_id(window.id);
            if !crate::enum_windows::is_already_foreground(hwnd) {
                let _ = activate_hwnd(hwnd);
            }
            return Some(hwnd);
        }
    }
    let mut pids = pids_matching_keys(keys);
    if pid != 0 && !pids.contains(&pid) {
        pids.push(pid);
    }
    restore_running_processes(&pids)
}

fn wait_for_targetable(keys: &[String], pid: u32, label: &str) -> Result<(), Error> {
    let deadline = Instant::now() + LAUNCH_WAIT;
    loop {
        interrupt::check()?;
        if let Ok(windows) = enum_windows() {
            if let Some(window) = windows.into_iter().find(|w| window_matches_plan(w, keys, pid)) {
                let hwnd = hwnd_from_id(window.id);
                if !crate::enum_windows::is_already_foreground(hwnd) {
                    let _ = activate_hwnd(hwnd);
                }
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            if restore_matching(keys, pid).is_some() {
                return Ok(());
            }
            return Err(Error::desktop(format!(
                "launched app did not expose a targetable window: {label}"
            )));
        }
        std::thread::sleep(LAUNCH_POLL);
    }
}

fn execute_plan(plan: LaunchPlan) -> Result<(), Error> {
    // Already running: restore the existing HWND (tray / hidden / iconic).
    // Do not ShellExecute again — many apps treat a second launch as a new instance.
    // Keep this path short: the helper is stdio-serial, so a long wait makes
    // health/cancel look like "sidecar timed out".
    if !pids_matching_keys(&plan.keys).is_empty() {
        let _ = restore_matching(&plan.keys, 0);
        let deadline = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < deadline {
            interrupt::check()?;
            if let Ok(windows) = enum_windows() {
                if windows.iter().any(|w| window_matches_plan(w, &plan.keys, 0)) {
                    return Ok(());
                }
            }
            std::thread::sleep(LAUNCH_POLL);
        }
        return Err(Error::desktop(format!(
            "launched app did not expose a targetable window: {}",
            plan.requested
        )));
    }
    let pid = match &plan.kind {
        LaunchKind::Executable(path) => {
            let verified = verify_executable(path)?;
            shell_execute_w(&verified)?
        }
        LaunchKind::Packaged(aumid) => activate_packaged(aumid, &plan.identity)?,
        LaunchKind::AppsFolder(id) => {
            if id.is_empty() {
                return Err(Error::desktop(APPSFOLDER_ITEM_ID));
            }
            let _folder = open_appsfolder()?;
            let parse = format!("shell:AppsFolder\\{id}");
            let item = appsfolder_item(&parse)?;
            let _ = decode_shell_name(&item)?;
            shell_execute_item(&item)?
        }
    };
    wait_for_targetable(&plan.keys, pid, &plan.requested)
}

/// Resolve a catalog/canonical/exe/packaged target, verify identity, launch, then wait for a window.
pub fn launch_app(app: &str) -> Result<(), Error> {
    let first = resolve_plan(app)?;
    let second = resolve_plan(app)?;
    if first.identity != second.identity || first.kind != second.kind {
        return Err(Error::desktop(CATALOG_IDENTITY_CHANGED));
    }
    execute_plan(second)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_pid_identifiers() {
        for id in ["pid-1234", "PID:99", "pid 7"] {
            let err = resolve_launch_target(id).unwrap_err();
            assert_eq!(err.message, PID_LAUNCH_ID);
        }
    }

    #[test]
    fn rejects_empty_identifier() {
        let err = resolve_launch_target("").unwrap_err();
        assert_eq!(err.message, MISSING_LAUNCH_ID);
    }

    #[test]
    fn non_packaged_catalog_without_exe_uses_appsfolder() {
        let shell = ShellApp {
            display_name: "Contoso App".into(),
            identifier: "Contoso.CatalogItem".into(),
            target_path: None,
            process_keys: vec![],
            product_name: String::new(),
        };
        let plan = plan_from_shell("Contoso App", &shell).unwrap();
        assert_eq!(plan.kind, LaunchKind::AppsFolder("Contoso.CatalogItem".into()));
        assert_eq!(plan.launch_file(), r"shell:AppsFolder\Contoso.CatalogItem");
        assert_eq!(RESOLVED_EXE_PATH.len(), 46);
        assert_eq!(DECODE_SHELL, "failed to decode shell string");
        assert_eq!(crate::enum_windows::MISSING_PROCESS_NAME, "process app identifier is missing a process name");
        assert_eq!(APPSFOLDER_OPEN, "failed to open shell:AppsFolder");
        assert_eq!(APPSFOLDER_ENUM, "failed to enumerate shell:AppsFolder");
        assert_eq!(APPSFOLDER_ITEM, "failed to fetch shell:AppsFolder item");
    }

    #[test]
    fn unresolved_exe_target_still_requires_resolved_path() {
        let shell = ShellApp {
            display_name: "Missing".into(),
            identifier: "Missing".into(),
            target_path: Some(r"C:\definitely-not-installed\app.exe".into()),
            process_keys: vec![],
            product_name: String::new(),
        };
        let err = plan_from_shell("Missing", &shell).unwrap_err();
        assert_eq!(err.message, RESOLVED_EXE_PATH);
    }

    #[test]
    fn catalog_target_that_does_not_resolve_requires_resolved_path() {
        let shell = ShellApp {
            display_name: "Missing Target".into(),
            identifier: "MissingTargetApp".into(),
            target_path: Some(r"C:\definitely-not-installed\missing-app.exe".into()),
            process_keys: vec![],
            product_name: String::new(),
        };
        let err = plan_from_shell("Missing Target", &shell).unwrap_err();
        assert_eq!(err.message, RESOLVED_EXE_PATH);
    }

    /// A catalog entry with a canonical id and no resolvable .exe is launched
    /// through the `shell:AppsFolder\<id>` namespace, matching the official
    /// "launchable app catalog item" path. The failure mode for that path is a
    /// ShellExecute failure at launch time, not a planning error.
    #[test]
    fn catalog_canonical_id_without_exe_plans_an_appsfolder_launch() {
        let shell = ShellApp {
            display_name: "Contoso".into(),
            identifier: "ContosoApp".into(),
            target_path: None,
            process_keys: vec![],
            product_name: String::new(),
        };
        let plan = plan_from_shell("Contoso", &shell).expect("appsfolder launch plan");
        assert_eq!(plan.kind, LaunchKind::AppsFolder("ContosoApp".into()));
        assert_eq!(plan.identity, "ContosoApp");
    }

    /// The one catalog shape that genuinely cannot be launched: no canonical id.
    #[test]
    fn catalog_without_canonical_id_is_not_launchable() {
        let shell = ShellApp {
            display_name: "Contoso".into(),
            identifier: String::new(),
            target_path: None,
            process_keys: vec![],
            product_name: String::new(),
        };
        let err = plan_from_shell("Contoso", &shell).unwrap_err();
        assert_eq!(err.message, "app catalog entry has no canonical ID");
    }

    #[test]
    fn packaged_catalog_without_exe_stays_packaged() {
        let shell = ShellApp {
            display_name: "Paint".into(),
            identifier: "Microsoft.Paint_8wekyb3d8bbwe!App".into(),
            target_path: None,
            process_keys: vec![],
            product_name: String::new(),
        };
        let plan = plan_from_shell("mspaint", &shell).expect("aumid catalog");
        assert_eq!(
            plan.kind,
            LaunchKind::Packaged("Microsoft.Paint_8wekyb3d8bbwe!App".into())
        );
    }

    #[test]
    fn shellexecutew_failure_uses_official_prefix() {
        let msg = shell_execute_w_error(2);
        assert!(msg.starts_with("Windows failed to launch app (ShellExecuteW returned "));
        assert_eq!(msg, "Windows failed to launch app (ShellExecuteW returned 2)");
    }

    #[test]
    fn packaged_identity_match_accepts_aumid_and_family() {
        assert!(registered_matches_launch(
            "Microsoft.Paint_8wekyb3d8bbwe!App",
            "Microsoft.Paint_8wekyb3d8bbwe",
            "Microsoft.Paint_8wekyb3d8bbwe!App",
            "Microsoft.Paint_8wekyb3d8bbwe!App",
        ));
        assert!(!registered_matches_launch(
            "Microsoft.Paint_8wekyb3d8bbwe!App",
            "Microsoft.Paint_8wekyb3d8bbwe",
            "Other.App_8wekyb3d8bbwe!App",
            "Other.App_8wekyb3d8bbwe!App",
        ));
    }

    #[test]
    fn invalid_aumid_requires_registered_packaged_app() {
        let err = verify_packaged_app("not-a-valid-aumid!", "not-a-valid-aumid!").unwrap_err();
        assert_eq!(err.message, PACKAGED_REQUIRED);
    }

    #[test]
    fn launch_approval_requires_resolved_target() {
        let info = LaunchTargetInfo {
            requested: "mspaint.exe".into(),
            identity: "Microsoft.Paint_8wekyb3d8bbwe!App".into(),
            launch_file: r"C:\Windows\System32\mspaint.exe".into(),
            product_name: Some("Paint".into()),
            original_filename: Some("mspaint.exe".into()),
        };
        let mut approved = HashSet::new();
        assert!(!launch_target_approved(&approved, "mspaint.exe", &info));
        approved.insert("mspaint.exe".into());
        assert!(launch_target_approved(&approved, "mspaint.exe", &info));
        approved.clear();
        approved.insert("Paint".into());
        assert!(launch_target_approved(&approved, "mspaint.exe", &info));
    }

    #[test]
    fn launch_info_reads_pe_product_name_and_original_filename() {
        let path = r"C:\Windows\System32\notepad.exe";
        if !Path::new(path).is_file() {
            return;
        }
        let info = resolve_launch_info(path).expect("notepad launch identity");
        let product = info.product_name.expect("ProductName");
        assert!(!product.is_empty());
        let original = info.original_filename.expect("OriginalFilename");
        assert!(original.to_ascii_lowercase().contains("notepad"));
    }

    #[test]
    fn launch_display_name_prefers_product_name_then_filename() {
        // A real signed system executable exposes both.
        let info = LaunchTargetInfo {
            requested: "notepad.exe".into(),
            identity: "notepad.exe".into(),
            launch_file: r"C:\Windows\System32\notepad.exe".into(),
            product_name: Some("Notepad".into()),
            original_filename: Some("NOTEPAD.EXE".into()),
        };
        assert_eq!(info.display_name(), "Notepad");

        // Only OriginalFilename available.
        let info = LaunchTargetInfo {
            product_name: None,
            original_filename: Some("mspaint.exe".into()),
            ..info
        };
        assert_eq!(info.display_name(), "mspaint.exe");

        // Neither available: fall back to the file leaf, then the request.
        let info = LaunchTargetInfo {
            product_name: None,
            original_filename: None,
            ..info
        };
        assert_eq!(info.display_name(), "notepad.exe");
        let info = LaunchTargetInfo {
            product_name: None,
            original_filename: None,
            launch_file: String::new(),
            requested: "Contoso".into(),
            identity: "ContosoApp".into(),
        };
        assert_eq!(info.display_name(), "Contoso");

        // Blank metadata is ignored rather than producing an empty prompt.
        let info = LaunchTargetInfo {
            requested: "notepad.exe".into(),
            identity: "notepad.exe".into(),
            launch_file: r"C:\Windows\System32\notepad.exe".into(),
            product_name: Some("   ".into()),
            original_filename: Some("".into()),
        };
        assert_eq!(info.display_name(), "notepad.exe");
    }

    #[test]
    fn real_system_exe_yields_a_friendly_display_name() {
        // Reads real PE version info through the same path launch_app uses.
        let path = r"C:\Windows\System32\notepad.exe";
        if !std::path::Path::new(path).is_file() {
            return;
        }
        let info = LaunchTargetInfo {
            requested: path.into(),
            identity: "notepad.exe".into(),
            launch_file: path.into(),
            product_name: product_name(path),
            original_filename: None,
        };
        let name = info.display_name();
        assert!(!name.is_empty());
        assert!(!name.to_ascii_lowercase().ends_with(".exe") || name.eq_ignore_ascii_case("notepad.exe"));
    }

    #[test]
    fn exe_without_version_info_uses_official_error() {
        let dir = std::env::temp_dir().join("dsh-no-version-identity.exe");
        std::fs::write(&dir, b"not a pe").expect("write stub");
        let err = crate::policy::version_identity(dir.to_str().unwrap()).unwrap_err();
        assert_eq!(err, crate::policy::ERR_NO_VERSION_INFO);
        let _ = std::fs::remove_file(&dir);
    }

    /// CW-5: the accept side understands every official AppIdentifier shape, and the
    /// same prefix list is shared with the emit side in enum_windows.
    #[test]
    fn accepts_every_official_app_identifier_prefix() {
        assert_eq!(strip_known_prefixes(r"process:C:\a\msedge.exe"), r"C:\a\msedge.exe");
        assert_eq!(strip_known_prefixes(r"path:C:\a\msedge.exe"), r"C:\a\msedge.exe");
        assert_eq!(strip_known_prefixes("registry:HKLM\\x"), "HKLM\\x");
        assert_eq!(
            strip_known_prefixes("app-user-model-id:Microsoft.Paint_8wekyb3d8bbwe!App"),
            "Microsoft.Paint_8wekyb3d8bbwe!App"
        );
        assert_eq!(strip_known_prefixes("window-app:msedge.exe"), "msedge.exe");
        assert_eq!(
            strip_known_prefixes(r"shell:AppsFolder\Microsoft.Paint_8wekyb3d8bbwe!App"),
            "Microsoft.Paint_8wekyb3d8bbwe!App"
        );
        // Bare names and full .exe paths pass through unchanged.
        assert_eq!(strip_known_prefixes("msedge.exe"), "msedge.exe");
        assert_eq!(strip_known_prefixes(r"C:\a\msedge.exe"), r"C:\a\msedge.exe");
        // normalize_key collapses the prefixed and bare forms to one key ...
        assert_eq!(normalize_key(r"process:C:\a\msedge.exe"), normalize_key(r"C:\a\msedge.exe"));
        // ... without merging two same-named executables from different directories.
        assert_ne!(normalize_key(r"C:\a\msedge.exe"), normalize_key(r"D:\b\msedge.exe"));
        // window_match_keys keeps the official id and the bare path.
        let window = WindowRef { app: r"process:C:\a\msedge.exe".into(), id: 7, title: "t".into() };
        let keys = window_match_keys(&window);
        assert!(keys.iter().any(|k| k == r"process:C:\a\msedge.exe"));
        assert!(keys.iter().any(|k| k == "msedge.exe"));
    }

}
