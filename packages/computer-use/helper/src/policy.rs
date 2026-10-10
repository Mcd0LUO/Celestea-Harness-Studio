//! Terminal / Codex / AUMID / allow-deny matching Python `computer_use/policy.py`.
//!
//! Launch identity also reads PE `StringFileInfo` `ProductName` + `OriginalFilename`
//! (`src/shell/app_identity/native.rs`) and gates on ProductName with the official
//! `product policy blocks this app` strings. Antivirus / password-manager product
//! tables are intentionally not shipped.
//!
//! Managed policy (official `Computer Use is disabled by policy`) reads env and
//! `$DSH_HOME/computer-use/config.json` / `requirements.json`.

/// BR-14: helper-side browser URL policy (the official `assertBrowserUrlAllowed`).

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HWND};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use crate::enum_windows::window_title;

const TERMINAL: &[&str] = &[
    "alacritty", "bash", "cmd", "cmder", "conemu", "conemu64", "conemu64c", "conemuc", "conhost",
    "fluentterminal", "git-bash", "hyper", "kitty", "mintty", "mobaxterm", "openconsole",
    "powershell", "powershell_ise", "putty", "puttytel", "pwsh", "tabby", "terminal", "terminus",
    "termius", "ttermpro", "warp", "wezterm", "wezterm-gui", "windowsterminal", "wsl", "wt",
];

const CODEX: &[&str] = &[
    "chatgpt", "chatgpt.exe", "codex", "codex.exe", "codex-computer-use", "codex-computer-use.exe",
];

/// AUMID 子串拒识表：不让 helper 驱动「助手自己」。
///
/// 三条都是子串匹配而非精确相等，因为商店应用发布的 AUMID 带包名与哈希后缀
/// （形如 `Publisher.Package_hash!App`）。第三条是**厂商前缀**——只写
/// `chatgpt` / `codex` 匹配不到它，因为那批包的发布者段就是那个厂商的名字。
///
/// 保留原表内容是**行为保持**，不是文案搬运：动了它等于放宽一条安全拒识规则。
const SELF_APP_AUMID_PREFIXES: &[&str] = &["chatgpt", "codex", "openai"];

/// TC-16: the official `guidance.md:243` deny list names `Meta`, `Windows`,
/// `Win`, `WIN+...`, `Cmd`, `Command`, `Super`, `OS`; the helper key table also
/// accepts the `lwin`/`rwin` and `_l`/`_r` qualified spellings, so they must be
/// denied too (otherwise `press_key("lwin")` opens the Start menu).
const WIN_KEY: &[&str] = &[
    "meta",
    "windows",
    "win",
    "cmd",
    "command",
    "super",
    "os",
    "lwin",
    "rwin",
    "win_l",
    "win_r",
    "windows_l",
    "windows_r",
    "meta_l",
    "meta_r",
    "command_l",
    "command_r",
    "cmd_l",
    "cmd_r",
    "super_l",
    "super_r",
    "os_l",
    "os_r",
];

/// Official helper .rdata SA:18062 — antivirus / security-suite detection table
/// (~110 entries, exact run). Feeds the sensitive-app (`riskLevel: high`) class.
const ANTIVIRUS: &[&str] = &[
    "a2start",
    "ad-aware antivirus",
    "adaware",
    "avg antivirus",
    "avg antivirus free",
    "avg internet security",
    "avgui",
    "avgnt",
    "avast antivirus",
    "avast free antivirus",
    "avast one",
    "avast premium security",
    "avastui",
    "avktray",
    "avira",
    "avira antivirus",
    "avira free antivirus",
    "avira.oe.systray",
    "avira.systray",
    "avp",
    "avpui",
    "bdagent",
    "bitdefender",
    "bitdefender agent",
    "bitdefender antivirus free",
    "bitdefender security center",
    "bitdefender total security",
    "ciscistray",
    "clamwin",
    "clamwin antivirus",
    "comodo antivirus",
    "comodo firewall",
    "comodo internet security",
    "crowdstrike falcon sensor",
    "crowdstrike windows sensor",
    "csfalconcontainer",
    "csfalconservicedr",
    "dr.web",
    "dr.web security space",
    "dwservice",
    "egui",
    "emsisoft anti-malware",
    "emsisoft security center",
    "eset",
    "eset gui",
    "eset internet security",
    "eset main gui",
    "eset nod32 antivirus",
    "eset security",
    "f-secure",
    "fs_ui_32",
    "g data antivirus",
    "g data security software",
    "g data securitycenter",
    "g data total protection",
    "gdsc",
    "kaspersky",
    "kaspersky anti-virus",
    "kaspersky free",
    "kaspersky internet security",
    "kaspersky security cloud",
    "kaspersky total security",
    "malwarebytes",
    "malwarebytes anti-malware",
    "mbam",
    "mbamgui",
    "mcafee",
    "mcafee livesafe",
    "mcafee security",
    "mcafee security scan plus",
    "mcafee total protection",
    "mcafee ui container",
    "mcuicnt",
    "microsoft defender",
    "microsoft defender antivirus",
    "norton 360",
    "norton antivirus",
    "norton security",
    "nortonsecurity",
    "panda dome",
    "panda security",
    "pccntmon",
    "psua",
    "console",
    "seccenter",
    "sechealthui",
    "securityhealthsystray",
    "sophos home",
    "sophos ui",
    "trend micro",
    "trend micro internet security",
    "trend micro maximum security",
    "totalav",
    "totalav ultimate antivirus",
    "totalav ultimate antivirus user interface",
    "uiwinmgr",
    "uistub",
    "webroot secureanywhere",
    "windows security",
    "wrsazatray",
    "zlclient",
    "zonealarm",
    "zonealarm security",
];

/// Official helper .rdata SA:18061 — password-manager detection table (exact run).
const PASSWORD_MANAGERS: &[&str] = &[
    "1password",
    "1password-browser",
    "support",
    "bitwarden",
    "dashlane",
    "enpass",
    "enpass password manager",
    "icloud passwords",
    "icloudpasswords",
    "identities",
    "keepass",
    "keepass password safe",
    "keepassxc",
    "keeper password manager",
    "keeper",
    "passwordmanager",
    "lastpass",
    "nordpass",
    "proton pass",
    "protonpass",
    "roboform",
];

/// Official helper .rdata SA:18059 — shell/OS window exclusion stems.
const SHELL_WINDOW_STEMS: &[&str] = &[
    "applicationframehost",
    "backgroundtaskhost",
    "click to do",
    "clicktodo",
    "app",
    "ctfmon",
    "inputapp",
    "lockapp",
    "runtimebroker",
    "searchapp",
    "searchhost",
    "shellexperiencehost",
    "sihost",
    "startmenuexperiencehost",
    "tabtip",
    "textinputhost",
];

/// Official helper .rdata `SA:18058 @0x12E398` — the fifth list: human-readable
/// display names / window titles (it contains spaces, `uninstall`, and the
/// truncated `codex (command prompt`). APS-06.
const DENY_DISPLAY_NAMES: &[&str] = &[
    "codex",
    "codex (command prompt",
    "fluent terminal",
    "git bash",
    "powershell",
    "tera term",
    "uninstall",
    "windows powershell",
    "windows terminal",
];

/// APS-06: match a display name or window title against the official fifth list.
/// The error string is the same official one used by the exe-stem lists.
pub fn deny_display_name(name: &str) -> Result<(), String> {
    let needle = name.to_ascii_lowercase();
    if needle.trim().is_empty() {
        return Ok(());
    }
    if DENY_DISPLAY_NAMES.iter().any(|entry| needle.contains(entry)) {
        return Err(APP_NOT_ALLOWED_BY_POLICY.into());
    }
    Ok(())
}

/// True when the app identifier names an antivirus/security product.
pub fn is_security_product(app: &str) -> bool {
    let needle = app.to_ascii_lowercase();
    let bare = stem(&needle);
    ANTIVIRUS
        .iter()
        .any(|name| needle.contains(name) || (!bare.is_empty() && bare.contains(name)))
}

/// True when the app identifier names a password manager.
pub fn is_password_manager(app: &str) -> bool {
    let needle = app.to_ascii_lowercase();
    let bare = stem(&needle);
    PASSWORD_MANAGERS
        .iter()
        .any(|name| needle.contains(name) || (!bare.is_empty() && bare.contains(name)))
}

/// True for Windows shell/OS windows that are never targetable.
pub fn is_shell_window_class(class_or_app: &str) -> bool {
    let needle = class_or_app.to_ascii_lowercase();
    SHELL_WINDOW_STEMS.iter().any(|stem| needle.contains(stem))
}

/// Official `AppApprovalRequest.riskLevel` is a two-value enum (`low` | `high`).
/// Password managers and antivirus/security products are the sensitive-app classes
/// that raise it (parity plan risk R9: the exact list->risk mapping is inference).
pub fn risk_level(app: &str) -> &'static str {
    risk_level_for(app, None, None)
}

/// APS-11: official `riskLevel` is one sensitive boolean mapped to
/// `low`/`high`. A launch target also carries a PE `ProductName` /
/// `OriginalFilename`, which may name the product even when the exe name does
/// not (for example a randomly named antivirus executable).
pub fn risk_level_for(
    app: &str,
    product_name: Option<&str>,
    original_filename: Option<&str>,
) -> &'static str {
    let inputs = [app, product_name.unwrap_or(""), original_filename.unwrap_or("")];
    if inputs
        .iter()
        .any(|value| !value.is_empty() && (is_password_manager(value) || is_security_product(value)))
    {
        "high"
    } else {
        "low"
    }
}

/// Official rdata from `src/shell/app_identity/native.rs` / product policy.
pub const ERR_NO_PRODUCT_NAME: &str = "executable has no ProductName";
pub const ERR_CONFLICTING_IDENTITY: &str = "executable has conflicting version identities";
pub const ERR_INCOMPLETE_IDENTITY: &str = "executable has an incomplete version identity";
pub const ERR_NO_VERSION_INFO: &str = "executable has no version information";
pub const ERR_NO_TRANSLATIONS: &str = "executable has no valid version translations";
pub const ERR_INVALID_VERSION_STRING: &str = "invalid executable version string";
pub const ERR_UNTERMINATED_VERSION_STRING: &str = "unterminated executable version string";
pub const PRODUCT_POLICY_PREFIX: &str = "product policy blocks this app: ";
pub const PRODUCT_POLICY_OPERATE_PREFIX: &str = "Computer Use cannot operate on ";
pub const PRODUCT_POLICY_OPERATE_SUFFIX: &str = " ; product policy blocks this app";
pub const DISABLED_BY_POLICY: &str = "Computer Use is disabled by policy";
pub const APP_NOT_ALLOWED_BY_POLICY: &str = "Computer Use is not allowed on this app by policy";
pub const POLICY_CACHE_POISONED: &str = "policy cache mutex poisoned";
pub const REQUIREMENTS_READ_FAILED: &str = "Requirements/read did not return requirements";
pub const CONFIG_READ_FAILED: &str = "config/read did not return config";

/// Official fallback LANG/codepage pairs after `\\VarFileInfo\\Translation`
/// (`0x0409/0x04b0`, `0x0409/0x04e4`, `0x0409/0x0000`).
const FALLBACK_TRANSLATIONS: &[(u16, u16)] = &[(0x0409, 0x04b0), (0x0409, 0x04e4), (0x0409, 0x0000)];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionIdentity {
    pub product_name: String,
    pub original_filename: Option<String>,
}

fn identities_equal(a: &VersionIdentity, b: &VersionIdentity) -> bool {
    if a.product_name != b.product_name {
        return false;
    }
    match (&a.original_filename, &b.original_filename) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum VersionString {
    Missing,
    Value(String),
}

/// Decode one null-terminated UTF-16 value that lives inside `data` at `offset`.
///
/// `VerQueryValueW` fills `puLen` with the *character* count for a `\StringFileInfo` value but
/// with a *byte* count for the root block, and reading it as bytes truncated every name we
/// asked for: Paint's `ProductName` `Paint` came back as `Pai`, notepad's
/// `Microsoft® Windows® Operating System` as `Microsoft® Windows` (both were visible in the
/// approval prompt the user reads). The value is null-terminated by contract, so scan to the
/// terminator bounded by the version block we already own, and ignore the reported length.
fn utf16_value_at(data: &[u8], offset: usize) -> Result<VersionString, String> {
    let available = data.len().saturating_sub(offset) / 2;
    if available == 0 {
        return Err(ERR_INVALID_VERSION_STRING.into());
    }
    let ptr = unsafe { data.as_ptr().add(offset) } as *const u16;
    let slice = unsafe { std::slice::from_raw_parts(ptr, available) };
    let Some(end) = slice.iter().position(|c| *c == 0) else {
        return Err(ERR_INVALID_VERSION_STRING.into());
    };
    if end == 0 {
        return Ok(VersionString::Missing);
    }
    let trimmed = String::from_utf16_lossy(&slice[..end]).trim().to_string();
    if trimmed.is_empty() {
        return Ok(VersionString::Missing);
    }
    Ok(VersionString::Value(trimmed))
}

fn query_version_string(data: &[u8], key: &str) -> Result<VersionString, String> {
    let key_w: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len = 0u32;
    let ok = unsafe { VerQueryValueW(data.as_ptr().cast(), PCWSTR(key_w.as_ptr()), &mut ptr, &mut len) };
    if !ok.as_bool() || len < 2 {
        return Ok(VersionString::Missing);
    }
    if ptr.is_null() {
        return Err(ERR_INVALID_VERSION_STRING.into());
    }
    let offset = (ptr as usize).saturating_sub(data.as_ptr() as usize);
    utf16_value_at(data, offset)
}

/// Official launch identity: every `StringFileInfo` translation must agree on
/// `ProductName` + `OriginalFilename` (memcmp equality).
pub fn version_identity(path: &str) -> Result<VersionIdentity, String> {
    if path.is_empty() {
        return Err(ERR_NO_VERSION_INFO.into());
    }
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return Err(ERR_NO_VERSION_INFO.into());
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, data.as_mut_ptr().cast())
            .map_err(|_| ERR_NO_VERSION_INFO.to_string())?;
        let mut trans_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut trans_len = 0u32;
        let ok = VerQueryValueW(
            data.as_ptr().cast(),
            w!("\\VarFileInfo\\Translation"),
            &mut trans_ptr,
            &mut trans_len,
        );
        if !ok.as_bool() || trans_ptr.is_null() || trans_len < 4 || (trans_len & 3) != 0 {
            return Err(ERR_NO_TRANSLATIONS.into());
        }
        let count = (trans_len as usize) / 4;
        let words = std::slice::from_raw_parts(trans_ptr as *const u16, count * 2);
        let mut translations = Vec::with_capacity(count + FALLBACK_TRANSLATIONS.len());
        for i in 0..count {
            translations.push((words[i * 2], words[i * 2 + 1]));
        }
        translations.extend_from_slice(FALLBACK_TRANSLATIONS);

        let mut found: Option<VersionIdentity> = None;
        for (lang, code) in translations {
            let prefix = format!("\\StringFileInfo\\{lang:04x}{code:04x}");
            let product = query_version_string(&data, &format!("{prefix}\\ProductName"))?;
            let original = query_version_string(&data, &format!("{prefix}\\OriginalFilename"))?;
            let identity = match (product, original) {
                (VersionString::Missing, VersionString::Missing) => continue,
                (VersionString::Missing, VersionString::Value(_)) => {
                    return Err(ERR_INCOMPLETE_IDENTITY.into());
                }
                (VersionString::Value(product_name), original) => VersionIdentity {
                    product_name,
                    original_filename: match original {
                        VersionString::Value(name) => Some(name),
                        VersionString::Missing => None,
                    },
                },
            };
            match &found {
                None => found = Some(identity),
                Some(prev) if identities_equal(prev, &identity) => {}
                Some(_) => return Err(ERR_CONFLICTING_IDENTITY.into()),
            }
        }
        found.ok_or_else(|| ERR_NO_PRODUCT_NAME.to_string())
    }
}

/// PE `ProductName` when the version identity is complete enough to read one.
pub fn product_name(path: &str) -> Option<String> {
    version_identity(path).ok().map(|id| id.product_name)
}

pub fn process_image_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return None;
        };
        let mut buf = vec![0u16; 32768];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        if ok.is_err() || size == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    }
}

pub fn deny_product_identity(product_name: &str, original_filename: Option<&str>) -> Result<(), String> {
    let mut blocked = false;
    if !product_name.is_empty() && deny_app_access(product_name, None).is_err() {
        blocked = true;
    }
    if let Some(original) = original_filename {
        if !original.is_empty() && deny_app_access(original, None).is_err() {
            blocked = true;
        }
    }
    if blocked {
        Err(format!("{PRODUCT_POLICY_PREFIX}{product_name}"))
    } else {
        Ok(())
    }
}

pub fn deny_product_operate(product_name: &str, original_filename: Option<&str>) -> Result<(), String> {
    deny_product_identity(product_name, original_filename).map_err(|_| {
        format!("{PRODUCT_POLICY_OPERATE_PREFIX}{product_name}{PRODUCT_POLICY_OPERATE_SUFFIX}")
    })
}

pub fn normalize_app_id(app: &str) -> String {
    let cleaned = app.trim().to_ascii_lowercase().replace('\\', "/");
    let name = cleaned.rsplit('/').next().unwrap_or(&cleaned);
    name.to_string()
}

pub fn stem(app: &str) -> String {
    let key = normalize_app_id(app);
    key.strip_suffix(".exe").unwrap_or(&key).to_string()
}

#[derive(Clone, Debug, Default)]
struct ManagedPolicy {
    disabled: bool,
    deny: Vec<String>,
    allow: Vec<String>,
}

static POLICY_CACHE: Mutex<Option<ManagedPolicy>> = Mutex::new(None);

fn env_truthy(name: &str) -> Option<bool> {
    let raw = std::env::var(name).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn policy_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["DSH_HOME", "CODEX_HOME"] {
        if let Ok(raw) = std::env::var(key) {
            if !raw.trim().is_empty() {
                roots.push(PathBuf::from(raw));
            }
        }
    }
    if roots.is_empty() {
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            roots.push(PathBuf::from(home).join(".dsh"));
        }
    }
    roots
}

fn json_flag(value: &Value, keys: &[&str]) -> Option<bool> {
    let mut cur = value;
    for key in keys {
        cur = cur.get(*key)?;
    }
    cur.as_bool()
}

fn json_string_list(value: &Value, keys: &[&str]) -> Vec<String> {
    let mut cur = value;
    for key in keys {
        cur = match cur.get(*key) {
            Some(next) => next,
            None => return Vec::new(),
        };
    }
    match cur {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect(),
        Value::String(s) => s
            .split(',')
            .map(|part| part.trim().to_ascii_lowercase())
            .filter(|part| !part.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn load_json_file(path: &PathBuf) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|_| CONFIG_READ_FAILED.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| CONFIG_READ_FAILED.to_string())
}

fn apply_json(policy: &mut ManagedPolicy, value: &Value, requirements: bool) -> Result<(), String> {
    if requirements {
        if !value.is_object() {
            return Err(REQUIREMENTS_READ_FAILED.into());
        }
        if json_flag(value, &["computerUse"]) == Some(false)
            || json_flag(value, &["computer_use"]) == Some(false)
        {
            policy.disabled = true;
        }
    }
    if json_flag(value, &["disabled"]) == Some(true)
        || json_flag(value, &["enabled"]) == Some(false)
        || json_flag(value, &["computerUse"]) == Some(false)
        || json_flag(value, &["computer_use"]) == Some(false)
        || json_flag(value, &["features", "computerUse"]) == Some(false)
        || json_flag(value, &["features", "computer_use"]) == Some(false)
        || json_flag(value, &["featureRequirements", "computerUse"]) == Some(false)
        || json_flag(value, &["allowBrowserAndComputerUse"]) == Some(false)
        || json_flag(value, &["allow_browser_and_computer_use"]) == Some(false)
    {
        policy.disabled = true;
    }
    policy.deny.extend(json_string_list(value, &["deniedApps"]));
    policy.deny.extend(json_string_list(value, &["denied_apps"]));
    policy.deny.extend(json_string_list(value, &["deny", "exes"]));
    policy.allow.extend(json_string_list(value, &["allowedApps"]));
    policy.allow.extend(json_string_list(value, &["allowed_apps"]));
    policy.allow.extend(json_string_list(value, &["allow", "exes"]));
    Ok(())
}

fn load_managed_policy() -> Result<ManagedPolicy, String> {
    let mut policy = ManagedPolicy::default();
    if env_truthy("COMPUTER_USE_DISABLED") == Some(true) || env_truthy("COMPUTER_USE_ENABLED") == Some(false)
    {
        policy.disabled = true;
    }
    policy.deny.extend(split_env("COMPUTER_USE_POLICY_DENY_APPS"));
    policy.allow.extend(split_env("COMPUTER_USE_POLICY_ALLOW_APPS"));
    for root in policy_roots() {
        let config = root.join("computer-use").join("config.json");
        if config.is_file() {
            let value = load_json_file(&config)?;
            apply_json(&mut policy, &value, false)?;
        }
        let nested = root.join("config.json");
        if nested.is_file() {
            let value = load_json_file(&nested).map_err(|_| CONFIG_READ_FAILED.to_string())?;
            if let Some(section) = value.get("computer-use").or_else(|| value.get("computerUse")) {
                apply_json(&mut policy, section, false)?;
            } else {
                apply_json(&mut policy, &value, false)?;
            }
        }
        let requirements = root.join("computer-use").join("requirements.json");
        if requirements.is_file() {
            let value = fs::read(&requirements)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .ok_or_else(|| REQUIREMENTS_READ_FAILED.to_string())?;
            apply_json(&mut policy, &value, true)?;
        }
    }
    policy.deny.sort();
    policy.deny.dedup();
    policy.allow.sort();
    policy.allow.dedup();
    Ok(policy)
}

fn managed_policy() -> Result<ManagedPolicy, String> {
    let mut guard = POLICY_CACHE
        .lock()
        .map_err(|_| POLICY_CACHE_POISONED.to_string())?;
    if let Some(cached) = guard.as_ref() {
        return Ok(cached.clone());
    }
    let loaded = load_managed_policy()?;
    *guard = Some(loaded.clone());
    Ok(loaded)
}

pub fn skip_managed_policy_check(method: &str) -> bool {
    matches!(
        method,
        "health"
            | "tools"
            | "prompt"
            | "interrupt"
            | "cancel"
            | "shutdown"
            | "close"
            | "end_turn"
            | "session_note"
            | "session_state"
            | "diagnostic_state"
    )
}

pub fn require_computer_use_enabled() -> Result<(), String> {
    if managed_policy()?.disabled {
        return Err(DISABLED_BY_POLICY.into());
    }
    Ok(())
}

pub fn computer_use_enabled() -> bool {
    require_computer_use_enabled().is_ok()
}

fn app_matches_policy_list(app: &str, aumid: Option<&str>, list: &[String]) -> bool {
    let key = normalize_app_id(app);
    let s = stem(app);
    let needle = aumid.unwrap_or("").to_ascii_lowercase();
    list.iter().any(|item| {
        item == &key
            || item == &s
            || key.ends_with(item)
            || (!needle.is_empty() && needle.contains(item.as_str()))
    })
}

pub fn deny_managed_app(app: &str, aumid: Option<&str>) -> Result<(), String> {
    require_computer_use_enabled()?;
    let policy = managed_policy()?;
    if app_matches_policy_list(app, aumid, &policy.deny) {
        return Err(APP_NOT_ALLOWED_BY_POLICY.into());
    }
    if !policy.allow.is_empty() && !app_matches_policy_list(app, aumid, &policy.allow) {
        return Err(APP_NOT_ALLOWED_BY_POLICY.into());
    }
    Ok(())
}

#[cfg(test)]
pub fn reset_managed_policy_cache() {
    if let Ok(mut guard) = POLICY_CACHE.lock() {
        *guard = None;
    }
}

fn split_env(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn default_app_access() -> serde_json::Value {
    serde_json::json!({
        "allow": {"exes": split_env("COMPUTER_USE_ALLOW_EXES"), "aumids": split_env("COMPUTER_USE_ALLOW_AUMIDS")},
        "deny": {"exes": split_env("COMPUTER_USE_DENY_EXES"), "aumids": split_env("COMPUTER_USE_DENY_AUMIDS")},
    })
}

pub fn process_aumid(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut len = 256u32;
        let mut buf = vec![0u16; 256];
        let err = GetApplicationUserModelId(handle, &mut len, Some(PWSTR(buf.as_mut_ptr())));
        let _ = CloseHandle(handle);
        if err != ERROR_SUCCESS || len == 0 {
            return String::new();
        }
        let n = (len as usize).saturating_sub(1).min(buf.len());
        String::from_utf16_lossy(&buf[..n])
    }
}

pub fn hwnd_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

pub fn deny_press_key(key: &str) -> Result<(), String> {
    let parts: Vec<String> = key
        .replace('-', "+")
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    for part in parts {
        if windows_key_token(&part) {
            return Err("Do not use the Windows key or shortcuts involving the Windows key.".into());
        }
    }
    Ok(())
}

/// TC-16: normalise a `+`-separated token before testing it against
/// `WIN_KEY`. The old code only took the first `_` segment and tested
/// `part.starts_with("win+")`, a branch that could never fire because the input
/// was already split on `+`; `lwin`/`rwin` therefore slipped through.
fn windows_key_token(part: &str) -> bool {
    let head = part.split('_').next().unwrap_or(part);
    let tail = part.rsplit('_').next().unwrap_or(part);
    let candidates = [
        part,
        head,
        tail,
        head.strip_prefix('l').unwrap_or(head),
        head.strip_prefix('r').unwrap_or(head),
        head.strip_prefix("left").unwrap_or(head),
        head.strip_prefix("right").unwrap_or(head),
    ];
    WIN_KEY.iter().any(|name| candidates.iter().any(|candidate| candidate == name))
}

pub fn deny_app(app: &str) -> Result<(), String> {
    deny_app_access(app, None)
}

pub fn deny_app_access(app: &str, aumid: Option<&str>) -> Result<(), String> {
    deny_managed_app(app, aumid)?;
    // APS-06: the official fifth list is display-name/title shaped, so an app id
    // (or a path) that names one of those products is denied here too.
    deny_display_name(app)?;
    let key = normalize_app_id(app);
    let s = stem(app);
    if TERMINAL.iter().any(|t| *t == s) {
        return Err("Do not automate terminal applications.".into());
    }
    if CODEX.iter().any(|t| stem(t) == s) || s.contains("chatgpt") || s.contains("codex") {
        return Err("Do not automate the ChatGPT desktop app UI or Codex CLI.".into());
    }
    let needle = aumid.unwrap_or("").to_ascii_lowercase();
    if !needle.is_empty() && SELF_APP_AUMID_PREFIXES.iter().any(|t| needle.contains(t)) {
        return Err("Do not automate the ChatGPT desktop app UI or Codex CLI.".into());
    }
    let deny_exes = split_env("COMPUTER_USE_DENY_EXES");
    for denied in &deny_exes {
        if denied == &key || denied == &s || key.ends_with(denied) {
            return Err(format!("Computer Use default_app_access denied exe {app}."));
        }
    }
    let deny_aumids = split_env("COMPUTER_USE_DENY_AUMIDS");
    for denied in &deny_aumids {
        if !needle.is_empty() && needle.contains(denied) {
            return Err(format!("Computer Use default_app_access denied aumid {needle}."));
        }
    }
    let allow_exes = split_env("COMPUTER_USE_ALLOW_EXES");
    let allow_aumids = split_env("COMPUTER_USE_ALLOW_AUMIDS");
    if !allow_exes.is_empty() || !allow_aumids.is_empty() {
        let exe_ok = allow_exes.iter().any(|item| item == &key || item == &s || key.ends_with(item));
        let aumid_ok = !needle.is_empty() && allow_aumids.iter().any(|item| needle.contains(item));
        if !exe_ok && !aumid_ok {
            return Err(format!("Computer Use default_app_access blocked {app}."));
        }
    }
    Ok(())
}

pub fn deny_allowed_apps(app: &str, allowed: &[String]) -> Result<(), String> {
    if allowed.is_empty() {
        return Ok(());
    }
    let key = normalize_app_id(app);
    if key.is_empty() {
        return Err("Computer Use allowedApps blocked an empty app id.".into());
    }
    for item in allowed {
        let needle = normalize_app_id(item);
        if needle.is_empty() {
            continue;
        }
        if key == needle || key.ends_with(&needle) || needle.contains(&key) || key.contains(&needle) {
            return Ok(());
        }
    }
    Err(format!(
        "Computer Use allowedApps blocked {app}. Allowed: {}",
        allowed.join(", ")
    ))
}

pub fn deny_target(app: &str, hwnd: HWND, allowed: &[String]) -> Result<(), String> {
    deny_allowed_apps(app, allowed)?;
    let pid = hwnd_pid(hwnd);
    let aumid = process_aumid(pid);
    deny_app_access(app, if aumid.is_empty() { None } else { Some(&aumid) })?;
    // APS-06: the fifth official list matches the human-readable window title.
    deny_display_name(&window_title(hwnd))?;
    if let Some(path) = process_image_path(pid) {
        if let Ok(id) = version_identity(&path) {
            deny_product_operate(&id.product_name, id.original_filename.as_deref())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_identity_and_policy_strings() {
        assert_eq!(ERR_NO_PRODUCT_NAME, "executable has no ProductName");
        assert_eq!(ERR_CONFLICTING_IDENTITY, "executable has conflicting version identities");
        assert_eq!(ERR_INCOMPLETE_IDENTITY, "executable has an incomplete version identity");
        assert_eq!(ERR_UNTERMINATED_VERSION_STRING, "unterminated executable version string");
        assert_eq!(ERR_NO_VERSION_INFO, "executable has no version information");
        assert_eq!(ERR_NO_TRANSLATIONS, "executable has no valid version translations");
        assert_eq!(PRODUCT_POLICY_PREFIX, "product policy blocks this app: ");
        assert_eq!(PRODUCT_POLICY_OPERATE_SUFFIX, " ; product policy blocks this app");
        assert_eq!(DISABLED_BY_POLICY, "Computer Use is disabled by policy");
        assert_eq!(APP_NOT_ALLOWED_BY_POLICY, "Computer Use is not allowed on this app by policy");
        assert_eq!(POLICY_CACHE_POISONED, "policy cache mutex poisoned");
        assert_eq!(REQUIREMENTS_READ_FAILED, "Requirements/read did not return requirements");
        assert_eq!(CONFIG_READ_FAILED, "config/read did not return config");
    }

    #[test]
    fn managed_deny_list_uses_official_app_policy_string() {
        reset_managed_policy_cache();
        let previous = std::env::var("COMPUTER_USE_POLICY_DENY_APPS").ok();
        std::env::set_var("COMPUTER_USE_POLICY_DENY_APPS", "blockedapp.exe");
        reset_managed_policy_cache();
        let err = deny_managed_app("blockedapp.exe", None).unwrap_err();
        assert_eq!(err, APP_NOT_ALLOWED_BY_POLICY);
        match previous {
            Some(value) => std::env::set_var("COMPUTER_USE_POLICY_DENY_APPS", value),
            None => std::env::remove_var("COMPUTER_USE_POLICY_DENY_APPS"),
        }
        reset_managed_policy_cache();
    }

    #[test]
    fn identities_match_only_when_both_fields_agree() {
        let named = VersionIdentity {
            product_name: "Notepad".into(),
            original_filename: Some("NOTEPAD.EXE".into()),
        };
        let named_again = named.clone();
        let product_only = VersionIdentity {
            product_name: "Notepad".into(),
            original_filename: None,
        };
        let other_product = VersionIdentity {
            product_name: "Paint".into(),
            original_filename: Some("NOTEPAD.EXE".into()),
        };
        assert!(identities_equal(&named, &named_again));
        assert!(!identities_equal(&named, &product_only));
        assert!(!identities_equal(&named, &other_product));
        assert!(identities_equal(&product_only, &product_only));
    }

    #[test]
    fn product_policy_blocks_codex_product_name() {
        assert_eq!(
            deny_product_identity("codex", None).unwrap_err(),
            "product policy blocks this app: codex"
        );
        assert_eq!(
            deny_product_operate("ChatGPT", Some("ChatGPT.exe")).unwrap_err(),
            "Computer Use cannot operate on ChatGPT ; product policy blocks this app"
        );
        assert!(deny_product_identity("Notepad", Some("NOTEPAD.EXE")).is_ok());
    }

    #[test]
    fn system_exe_exposes_product_name_and_original_filename() {
        let path = r"C:\Windows\System32\notepad.exe";
        if !std::path::Path::new(path).is_file() {
            return;
        }
        let id = version_identity(path).expect("notepad version identity");
        assert!(!id.product_name.is_empty());
        let original = id.original_filename.expect("OriginalFilename");
        assert!(original.to_ascii_lowercase().contains("notepad"));
        assert_eq!(product_name(path).as_deref(), Some(id.product_name.as_str()));
        // Windows reports `Microsoft® Windows® Operating System` for this binary. Reading the
        // reported length as bytes cut it at `Microsoft® Windows`, and the same bug turned
        // Paint's `Paint` into `Pai` in the approval prompt the user has to read, so assert the
        // part that the truncation removed rather than only that the field is non-empty.
        assert!(
            id.product_name.contains("Operating System"),
            "ProductName was truncated: {:?}",
            id.product_name
        );
    }

    /// The regression behind the approval prompt reading `Allow Computer Use to use Pai?`:
    /// a value must be decoded up to its own terminator, regardless of how short a length the
    /// version API reported for it, and never past the block that holds it.
    #[test]
    fn a_version_value_is_decoded_to_its_terminator() {
        fn block(values: &[&str]) -> Vec<u8> {
            let mut data = Vec::new();
            for value in values {
                for unit in value.encode_utf16().chain(std::iter::once(0)) {
                    data.extend_from_slice(&unit.to_le_bytes());
                }
            }
            data
        }
        let data = block(&["Paint", "mspaint.exe", "Microsoft® Windows® Operating System"]);
        assert_eq!(utf16_value_at(&data, 0), Ok(VersionString::Value("Paint".into())));
        let third = 2 * (data.len() / 2 - "Microsoft® Windows® Operating System".encode_utf16().count() - 1);
        assert_eq!(
            utf16_value_at(&data, third),
            Ok(VersionString::Value("Microsoft® Windows® Operating System".into()))
        );
        // An empty first unit is the API's "value absent", not an error.
        assert_eq!(utf16_value_at(&block(&[""]), 0), Ok(VersionString::Missing));
        // A value with no terminator inside the block is an error, not a truncated name.
        let mut unterminated = Vec::new();
        for unit in "NoTerminator".encode_utf16() {
            unterminated.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(utf16_value_at(&unterminated, 0).is_err());
        // Bounds: an offset at or past the end of the block yields an error, never a read.
        assert!(utf16_value_at(&data, data.len()).is_err());
        assert!(utf16_value_at(&data, data.len() + 8).is_err());
    }

    #[test]
    fn every_windows_key_alias_is_denied() {
        // TC-16: guidance.md:243 names Meta/Windows/Win/WIN+/Cmd/Command/Super/OS.
        // The helper key table also accepts lwin/rwin and _l/_r forms, and the old
        // guard (first `_` segment + a dead starts_with("win+")) let them through.
        for alias in [
            "lwin", "rwin", "LWin", "Win_L", "win_r", "meta_l", "cmd", "os", "super_r",
            "left_win", "right_os", "lmeta", "ros", "win", "windows", "command",
            "Ctrl+Win", "Alt-Win_R",
        ] {
            assert!(deny_press_key(alias).is_err(), "{alias} must be denied");
        }
        for allowed in ["a", "Control_L+c", "F4", "KP_0", "lshift", "option", "menu", "Escape"] {
            assert!(deny_press_key(allowed).is_ok(), "{allowed} must be allowed");
        }
    }

    #[test]
    fn official_display_name_denylist_blocks_titles() {
        // APS-06: the official fifth list (`0x12E398`) is display-name/title shaped.
        for denied in [
            "Windows Terminal",
            "Uninstall",
            "Fluent Terminal",
            "Git Bash",
            "Tera Term",
            "Windows PowerShell",
            "Codex (Command Prompt: cmd.exe)",
        ] {
            assert_eq!(deny_display_name(denied).unwrap_err(), APP_NOT_ALLOWED_BY_POLICY, "{denied}");
        }
        for allowed in ["Notepad", "Paint", "", "   ", "Calculator"] {
            assert!(deny_display_name(allowed).is_ok(), "{allowed} must be allowed");
        }
    }

    #[test]
    fn risk_level_uses_product_and_file_identity() {
        // APS-11: the sensitive flag may live in ProductName/OriginalFilename even
        // when the exe name does not name the product.
        assert_eq!(risk_level_for("foo.exe", Some("Kaspersky Internet Security"), None), "high");
        assert_eq!(risk_level_for("foo.exe", None, Some("avastui.exe")), "high");
        assert_eq!(risk_level_for("1Password.exe", None, None), "high");
        assert_eq!(risk_level_for("foo.exe", Some("Notepad"), Some("notepad.exe")), "low");
        assert_eq!(risk_level_for("notepad.exe", None, None), "low");
    }
}
