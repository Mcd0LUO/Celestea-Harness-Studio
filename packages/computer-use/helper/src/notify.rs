//! Official `src/codex/notify_config.rs` analog under DSH_HOME.
//!
//! NTF-1: the official helper does not merely record a flag. `FUN_140081196` reads the
//! user's existing Codex `notify` command out of `$CODEX_HOME/config.toml`, replaces it
//! with a callback into the helper itself (`<helper> --previous-notify turn-ended`), and
//! keeps the original so the `--previous-notify` startup path can run it and put the file
//! back (`S:18360-18364`). DSH used to write only its own `config.json` with a hard-coded
//! null previous hook, so nothing was ever chained and nothing was ever restored.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::policy;

/// Official payload (`S:18360`): the only accepted `--previous-notify` value.
pub const PREVIOUS_NOTIFY_PAYLOAD: &str = "turn-ended";
pub const MISSING_TURN_ENDED_PAYLOAD: &str = "missing turn-ended payload";
pub const NOTIFY_HOOK_FAILED: &str = "computer-use previous notify hook failed: ";
pub const NOTIFY_HOOK_SKIPPED_MISSING: &str =
    "computer-use previous notify hook skipped: missing command";
pub const NOTIFY_HOOK_SKIPPED_ARGS: &str =
    "computer-use previous notify hook skipped: invalid arguments";
pub const CREATE_CODEX_CONFIG_DIR: &str = "create Codex config directory";
pub const WRITE_CODEX_NOTIFY_CONFIG: &str = "write Codex notify config";
pub const UPDATE_NOTIFY_HOOK_FAILED: &str =
    "failed to update Windows Computer Use Codex notify hook: ";
pub const CONFIG_TOML: &str = "config.toml";
pub const CONFIG_JSON: &str = "config.json";
/// A Codex `config.toml` is a few kilobytes. Anything past this is a damaged file (the
/// 2026-09-14 incident produced 2,147,489,300 bytes) and must never be rewritten.
pub const MAX_NOTIFY_CONFIG_BYTES: usize = 1 << 20;
/// Small files still have to leave room for the helper line replacing a shorter one.
pub const MAX_NOTIFY_GROWTH_FLOOR: usize = 64 * 1024;

pub fn config_home() -> PathBuf {
    for key in ["DSH_HOME", "CODEX_HOME"] {
        if let Ok(raw) = std::env::var(key) {
            if !raw.trim().is_empty() {
                return PathBuf::from(raw);
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        return PathBuf::from(home).join(".dsh");
    }
    PathBuf::from(".dsh")
}

pub fn feature_status() -> Value {
    let access = policy::default_app_access();
    let enabled = policy::computer_use_enabled();
    json!({
        "allowBrowserAndComputerUse": enabled,
        "allow_browser_and_computer_use": enabled,
        "featureRequirements": {"computerUse": enabled},
        "features": {"computerUse": enabled, "computer_use": enabled},
        "allow_persistent_approval": true,
        "allowPersistentApproval": true,
        "defaultAppAccess": access,
        "default_app_access": access,
    })
}

pub fn notify_approval(app: &str, display_name: &str) -> Value {
    json!({
        "AppApprovalRequest": true,
        "riskLevel": "low",
        "allowPersistentApproval": true,
        "notify": true,
        "app": app,
        "displayName": display_name,
    })
}

/// 用户原有的 notify 钩子命令，按字节原样留存，恢复时才能逐字节写回。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotifyHook {
    /// The exact top-level TOML line, e.g. `notify = ["C:\\notify.exe", "--turn"]`.
    pub raw: String,
    /// The command parsed out of [`raw`]; empty when the value was not a string/array.
    pub command: Vec<String>,
}

impl NotifyHook {
    pub fn to_json(&self) -> Value {
        json!({"raw": self.raw, "command": self.command})
    }

    pub fn from_json(value: &Value) -> Option<Self> {
        let raw = value.get("raw")?.as_str()?.to_string();
        let command = value
            .get("command")?
            .as_array()?
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect();
        Some(Self { raw, command })
    }
}

fn line_body(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

fn line_ending(line: &str) -> &'static str {
    if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

fn is_notify_key(body: &str) -> bool {
    body.trim()
        .strip_prefix("notify")
        .map(|rest| rest.trim_start().starts_with('='))
        .unwrap_or(false)
}

/// Decode the escapes of a TOML *basic* string (`"..."`). Literal strings (`'...'`) keep
/// 它们的原始字节，必须原样落盘，不能走这条解析路径。
fn unescape_basic(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(marker @ ('u' | 'U')) => {
                let count = if marker == 'u' { 4 } else { 8 };
                let mut hex = String::new();
                for _ in 0..count {
                    match chars.next() {
                        Some(d) => hex.push(d),
                        None => break,
                    }
                }
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(decoded) => out.push(decoded),
                    None => {
                        out.push(marker);
                        out.push_str(&hex);
                    }
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Parse `notify = ["prog", "arg"]` (or a bare string) into its command.
///
/// TOML 的两种字符串形式差别就在这里：双引号 basic 字符串里的反斜杠转义必须解出来；
/// 单引号 literal 字符串的内容就是它本身，不需要、也不能再解转义。旧实现把两种都
/// 当 basic 处理，于是磁盘上的单引号字面量每次读回都会多一层反斜杠，下一次写回又
/// 再转义一次，逐轮翻倍，直到把用户的 config.toml 撑到 2 GB（2026-09-14 实测
/// 2,147,489,300 字节）。只解 basic 形式，写-解析-写就变成幂等的了。
pub fn parse_notify_command(value: &str) -> Vec<String> {
    let value = value.trim();
    let inner = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(value);
    let chars: Vec<char> = inner.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let basic = match chars[i] {
            '"' => true,
            '\'' => false,
            _ => {
                i += 1;
                continue;
            }
        };
        let delim = if basic { '"' } else { '\'' };
        i += 1;
        let mut raw = String::new();
        while i < chars.len() {
            let c = chars[i];
            // In a basic string a backslash escapes the next character, so `\"` must not be
            // mistaken for the closing delimiter (`C:\a"b\c.exe`).
            if basic && c == '\\' && i + 1 < chars.len() {
                raw.push(c);
                raw.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == delim {
                i += 1;
                break;
            }
            raw.push(c);
            i += 1;
        }
        out.push(if basic { unescape_basic(&raw) } else { raw });
    }
    out
}

/// Find the *top-level* `notify` key. Keys inside a table (`[computer-use] notify =`) are
/// ignored -- that is DSH's own marker, not the user's Codex hook.
pub fn parse_notify_hook(text: &str) -> Option<NotifyHook> {
    for line in text.lines() {
        let body = line_body(line);
        if body.trim_start().starts_with('[') {
            break;
        }
        if is_notify_key(body) {
            let value = body
                .trim()
                .strip_prefix("notify")
                .map(|rest| rest.trim_start().trim_start_matches('=').trim())
                .unwrap_or_default();
            return Some(NotifyHook {
                raw: body.trim().to_string(),
                command: parse_notify_command(value),
            });
        }
    }
    None
}

/// Replace the top-level `notify` key with `raw` (inserting it when absent), leaving every
/// other byte of the file alone.
pub fn set_notify_hook(text: &str, raw: &str) -> String {
    let mut out = String::new();
    let mut replaced = false;
    let mut in_table = false;
    for line in text.split_inclusive('\n') {
        let body = line_body(line);
        if body.trim_start().starts_with('[') {
            in_table = true;
        }
        if !replaced && !in_table && is_notify_key(body) {
            out.push_str(raw);
            out.push_str(line_ending(line));
            replaced = true;
            continue;
        }
        out.push_str(line);
    }
    if !replaced {
        let mut head = String::from(raw);
        head.push('\n');
        head.push_str(&out);
        return head;
    }
    out
}

/// Drop the top-level `notify` key (the `previous-notify` was null).
pub fn remove_notify_hook(text: &str) -> String {
    let mut out = String::new();
    let mut in_table = false;
    for line in text.split_inclusive('\n') {
        let body = line_body(line);
        if body.trim_start().starts_with('[') {
            in_table = true;
        }
        if !in_table && is_notify_key(body) {
            continue;
        }
        out.push_str(line);
    }
    out
}

fn toml_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Official `S:18178/18363`: the hook command is the helper itself with the turn-ended
/// payload. DSH resolves its own executable the same way (`resolve Windows Computer Use
/// executable path`).
pub fn helper_notify_command() -> Vec<String> {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| "dsh-computer-use.exe".to_string());
    vec![
        exe,
        "--previous-notify".to_string(),
        PREVIOUS_NOTIFY_PAYLOAD.to_string(),
    ]
}

pub fn helper_notify_line() -> String {
    let args: Vec<String> = helper_notify_command()
        .iter()
        .map(|arg| format!("\"{}\"", toml_quote(arg)))
        .collect();
    format!("notify = [{}]", args.join(", "))
}

pub fn is_helper_hook(command: &[String]) -> bool {
    command.iter().any(|arg| arg == "--previous-notify")
}

/// NTF-2: the official rejects any payload other than `turn-ended` (`S:18360`).
pub fn validate_previous_notify_payload(payload: &str) -> Result<(), &'static str> {
    if payload == PREVIOUS_NOTIFY_PAYLOAD {
        Ok(())
    } else {
        Err(MISSING_TURN_ENDED_PAYLOAD)
    }
}

/// NTF-1: run the user's original notify hook, the "chain" half of the official
/// behaviour. The error/skip sentences are the official ones (`S:18360-18362`).
pub fn run_previous_notify_hook(command: &[String]) -> Result<(), String> {
    let Some((program, args)) = command.split_first() else {
        eprintln!("{NOTIFY_HOOK_SKIPPED_MISSING}");
        return Err(NOTIFY_HOOK_SKIPPED_MISSING.to_string());
    };
    if program.trim().is_empty() || program.contains('\0') {
        eprintln!("{NOTIFY_HOOK_SKIPPED_ARGS}");
        return Err(NOTIFY_HOOK_SKIPPED_ARGS.to_string());
    }
    match std::process::Command::new(program).args(args).spawn() {
        Ok(_) => Ok(()),
        Err(error) => {
            let message = format!("{NOTIFY_HOOK_FAILED}{error}");
            eprintln!("{message}");
            Err(message)
        }
    }
}

fn stored_previous(root: &Path) -> Option<NotifyHook> {
    let raw = fs::read_to_string(root.join(CONFIG_JSON)).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed.get("previous-notify").and_then(NotifyHook::from_json)
}

pub fn write_notify_config(session_id: &str, turn_id: &str) -> Result<PathBuf, String> {
    write_notify_config_at(&config_home(), session_id, turn_id)
}

/// NTF-1: record the turn end, chain the user's previous hook and point `config.toml` at
/// this helper so the `--previous-notify turn-ended` callback can restore it.
pub fn write_notify_config_at(
    root: &Path,
    session_id: &str,
    turn_id: &str,
) -> Result<PathBuf, String> {
    let dir = root.join("computer-use");
    fs::create_dir_all(&dir)
        .map_err(|_| format!("{UPDATE_NOTIFY_HOOK_FAILED}{CREATE_CODEX_CONFIG_DIR}"))?;
    let toml_path = root.join(CONFIG_TOML);
    let existing = fs::read_to_string(&toml_path).unwrap_or_default();
    // A notify rewrite replaces one line. Refuse anything else: the 2026-09-14 incident left a
    // user's config.toml at 2,147,489,300 bytes of doubled backslashes, and a guard here means
    // no future escaping bug can eat a user's config again. The file is left untouched so the
    // user (or Codex) still has it.
    if existing.len() > MAX_NOTIFY_CONFIG_BYTES {
        return Err(format!(
            "{UPDATE_NOTIFY_HOOK_FAILED}{WRITE_CODEX_NOTIFY_CONFIG}: {CONFIG_TOML} is {} bytes (limit {MAX_NOTIFY_CONFIG_BYTES})",
            existing.len()
        ));
    }
    // The user's hook is whatever `config.toml` says now, or -- when a previous end_turn
    // already rewrote the file -- what we stored last time. A config that already points
    // back at us carries no user command to preserve.
    let hook = parse_notify_hook(&existing)
        .or_else(|| stored_previous(&dir))
        .filter(|hook| !is_helper_hook(&hook.command));
    let payload = json!({
        "notify": true,
        "notify=": true,
        "feature_status": feature_status(),
        "turn-ended": {"session_id": session_id, "turn_id": turn_id, "conversation": session_id},
        "previous-notify": hook.as_ref().map(NotifyHook::to_json).unwrap_or(Value::Null),
    });
    let path = dir.join(CONFIG_JSON);
    fs::write(&path, serde_json::to_vec_pretty(&payload).unwrap_or_default())
        .map_err(|_| format!("{UPDATE_NOTIFY_HOOK_FAILED}{WRITE_CODEX_NOTIFY_CONFIG}"))?;
    if hook.is_some() {
        let rewritten = set_notify_hook(&existing, &helper_notify_line());
        // Replacing one line may not grow the file. If it ever does, the escaping round trip has
        // regressed and writing would damage the user's config.
        if rewritten.len() > existing.len().max(MAX_NOTIFY_GROWTH_FLOOR) {
            return Err(format!(
                "{UPDATE_NOTIFY_HOOK_FAILED}{WRITE_CODEX_NOTIFY_CONFIG}: rewrite would grow {CONFIG_TOML} from {} to {} bytes",
                existing.len(),
                rewritten.len()
            ));
        }
        fs::write(&toml_path, rewritten)
            .map_err(|_| format!("{UPDATE_NOTIFY_HOOK_FAILED}{WRITE_CODEX_NOTIFY_CONFIG}"))?;
    } else if !toml_path.exists() {
        let _ = fs::write(&toml_path, "[computer-use]\nnotify = true\n");
    }
    Ok(path)
}

/// Official `src/codex/notify_config.rs`: the helper rewrites the Codex notify hook,
/// passing the previous hook payload on the command line so that on turn end it can be
/// restored. DSH keeps the same contract with its own config file.
pub fn restore_previous_notify() {
    let root = config_home();
    if let Some(command) = restore_previous_notify_at(&root) {
        // The official callback runs the user's original hook before/while restoring
        // (`computer-use previous notify hook failed:`).
        let _ = run_previous_notify_hook(&command);
    }
}

/// Restore `config.toml` from the stored previous hook and delete the record. Returns the
/// command that was chained, so the caller can run it.
pub fn restore_previous_notify_at(root: &Path) -> Option<Vec<String>> {
    let path = root.join("computer-use").join(CONFIG_JSON);
    let parsed: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())?;
    let previous = parsed.get("previous-notify").and_then(NotifyHook::from_json);
    let toml_path = root.join(CONFIG_TOML);
    if let Ok(existing) = fs::read_to_string(&toml_path) {
        let restored = match &previous {
            Some(hook) => set_notify_hook(&existing, &hook.raw),
            None => remove_notify_hook(&existing),
        };
        let _ = fs::write(&toml_path, restored);
    }
    let _ = fs::remove_file(&path);
    previous.map(|hook| hook.command)
}

pub fn interrupt_flag_path(session_id: &str, turn_id: &str) -> PathBuf {
    fn safe(value: &str) -> String {
        value
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '_' })
            .collect()
    }
    config_home()
        .join("cache")
        .join("computer-use")
        .join("interrupts")
        .join(safe(session_id))
        .join(safe(turn_id))
}

pub fn write_interrupt_flag(path: &Path, contents: &[u8]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, contents);
}

pub fn interrupt_flag_exists(path: &Path) -> bool {
    path.exists()
}

/// The marker is per-turn state, so it must be removable (see
/// `interrupt::marker_blocks` / `interrupt::end_turn`). DSH used to only ever write it.
pub fn remove_interrupt_flag(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Last-modified time of the marker, used to tell a live interrupt from a leftover file
/// written by a turn that ended (or a process that died) without cleaning up.
pub fn interrupt_flag_modified(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path).ok().and_then(|meta| meta.modified().ok())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-notify-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const USER_TOML: &str = "# user config\nmodel = \"gpt\"\nnotify = [\"C:/tools/n.exe\", \"--turn\"]\n\n[computer-use]\nnotify = true\n";

    #[test]
    fn parse_reads_the_top_level_notify_and_skips_our_table_marker() {
        assert!(parse_notify_hook("[computer-use]\nnotify = true\n").is_none());
        assert!(parse_notify_hook("notify_something = 1\n").is_none());
        let hook = parse_notify_hook(USER_TOML).unwrap();
        assert_eq!(hook.raw, "notify = [\"C:/tools/n.exe\", \"--turn\"]");
        assert_eq!(hook.command, vec!["C:/tools/n.exe".to_string(), "--turn".to_string()]);
        let single = parse_notify_hook("notify = \"C:/tools/n.exe\"\n").unwrap();
        assert_eq!(single.command, vec!["C:/tools/n.exe".to_string()]);
    }

    #[test]
    fn write_chains_the_previous_hook_and_restore_puts_it_back() {
        let root = temp_root("chain");
        fs::write(root.join(CONFIG_TOML), USER_TOML).unwrap();
        write_notify_config_at(&root, "s1", "t1").unwrap();
        let rewritten = fs::read_to_string(root.join(CONFIG_TOML)).unwrap();
        assert!(rewritten.contains("--previous-notify"), "{rewritten}");
        assert!(rewritten.contains("turn-ended"), "{rewritten}");
        assert!(rewritten.contains("[computer-use]"), "{rewritten}");
        assert!(!rewritten.contains("C:/tools/n.exe"), "{rewritten}");
        let stored: Value = serde_json::from_str(
            &fs::read_to_string(root.join("computer-use").join(CONFIG_JSON)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            stored["previous-notify"]["raw"],
            serde_json::json!("notify = [\"C:/tools/n.exe\", \"--turn\"]")
        );
        let chained = restore_previous_notify_at(&root).unwrap();
        assert_eq!(chained, vec!["C:/tools/n.exe".to_string(), "--turn".to_string()]);
        assert_eq!(fs::read_to_string(root.join(CONFIG_TOML)).unwrap(), USER_TOML);
        assert!(!root.join("computer-use").join(CONFIG_JSON).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_leaves_config_toml_untouched_without_a_previous_hook() {
        let root = temp_root("plain");
        let marker = "[computer-use]\nnotify = true\n";
        fs::write(root.join(CONFIG_TOML), marker).unwrap();
        write_notify_config_at(&root, "s1", "t1").unwrap();
        assert_eq!(fs::read_to_string(root.join(CONFIG_TOML)).unwrap(), marker);
        assert!(restore_previous_notify_at(&root).is_none());
        assert_eq!(fs::read_to_string(root.join(CONFIG_TOML)).unwrap(), marker);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_and_remove_only_touch_the_top_level_notify_line() {
        let text = "a = 1\nnotify = [\"x\"]\n[table]\nnotify = true\n";
        let replaced = set_notify_hook(text, "notify = [\"y\"]");
        assert!(replaced.contains("notify = [\"y\"]"));
        assert!(replaced.contains("[table]\nnotify = true"));
        let removed = remove_notify_hook(text);
        assert_eq!(removed, "a = 1\n[table]\nnotify = true\n");
    }

    #[test]
    fn payload_validation_and_official_strings() {
        assert!(validate_previous_notify_payload("turn-ended").is_ok());
        assert_eq!(validate_previous_notify_payload("bogus"), Err(MISSING_TURN_ENDED_PAYLOAD));
        assert_eq!(MISSING_TURN_ENDED_PAYLOAD, "missing turn-ended payload");
        assert_eq!(NOTIFY_HOOK_FAILED, "computer-use previous notify hook failed: ");
        assert_eq!(
            NOTIFY_HOOK_SKIPPED_MISSING,
            "computer-use previous notify hook skipped: missing command"
        );
        assert_eq!(
            NOTIFY_HOOK_SKIPPED_ARGS,
            "computer-use previous notify hook skipped: invalid arguments"
        );
        assert_eq!(
            UPDATE_NOTIFY_HOOK_FAILED,
            "failed to update Windows Computer Use Codex notify hook: "
        );
        assert!(is_helper_hook(&helper_notify_command()));
        assert!(!is_helper_hook(&["C:/tools/n.exe".to_string()]));
    }
}
#[cfg(test)]
mod notify_round_trip_tests {
    use super::*;

    /// 2 GB 事故的由来：单引号是 TOML literal 字符串（内容即字节），双引号是 basic
    /// 字符串（要解转义）。两者必须解析出同一条命令，否则每重写一轮就多一层反斜杠。
    #[test]
    fn literal_and_basic_strings_decode_to_the_same_command() {
        let literal = parse_notify_command("'D:\\工作\\codex-computer-use.sky.exe'");
        let basic = parse_notify_command("\"D:\\\\工作\\\\codex-computer-use.sky.exe\"");
        assert_eq!(literal, vec!["D:\\工作\\codex-computer-use.sky.exe".to_string()]);
        assert_eq!(basic, literal);
    }

    #[test]
    fn quote_and_unescape_are_inverses() {
        for raw in ["C:\\Program Files\\x.exe", "C:\\a\"b\\c.exe", "plain"] {
            let quoted = format!("\"{}\"", toml_quote(raw));
            assert_eq!(parse_notify_command(&quoted), vec![raw.to_string()], "{quoted}");
        }
    }

    /// Writing the helper hook and restoring the stored raw line must be byte-stable, no
    /// matter how many turns run.
    #[test]
    fn turn_loop_does_not_grow_the_config() {
        let original = "model = \"x\"\nnotify = ['D:\\工作\\codex-computer-use.sky.exe', \"turn-ended\"]\n[desktop]\nfoo = 1\n";
        let hook = parse_notify_hook(original).expect("hook");
        let mut current = original.to_string();
        for _ in 0..40 {
            current = set_notify_hook(&current, &helper_notify_line());
            current = set_notify_hook(&current, &hook.raw);
        }
        assert_eq!(current, original, "write/restore must be idempotent");
        assert!(current.len() < 4096);
    }

    /// A damaged config must be refused, not grown further.
    #[test]
    fn a_pathological_config_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("dsh-notify-guard-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let toml_path = dir.join(CONFIG_TOML);
        let huge = format!("notify = [\"x\", \"{}\"]\n", "\\".repeat(MAX_NOTIFY_CONFIG_BYTES + 1));
        let _ = fs::write(&toml_path, &huge);
        let err = write_notify_config_at(&dir, "s", "t").expect_err("must refuse");
        assert!(err.contains("is") && err.contains("limit"), "{err}");
        assert_eq!(fs::read_to_string(&toml_path).unwrap().len(), huge.len());
        let _ = fs::remove_dir_all(&dir);
    }
}