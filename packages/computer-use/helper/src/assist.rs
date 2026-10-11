//! UserAssist usage counts recovered from helper app_catalog.rs.

use std::collections::HashMap;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
};

const USERASSIST: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist";

#[derive(Clone, Debug, Default)]
pub struct Usage {
    pub use_count: i64,
    pub last_used: Option<String>,
}

fn rot13(text: &str) -> String {
    text.chars()
        .map(|ch| {
            let code = ch as u32;
            if (65..=90).contains(&code) {
                char::from_u32((code - 65 + 13) % 26 + 65).unwrap_or(ch)
            } else if (97..=122).contains(&code) {
                char::from_u32((code - 97 + 13) % 26 + 97).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect()
}

fn exe_key(path: &str) -> String {
    path.replace('/', "\\")
        .rsplit('\\')
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase()
}

fn parse_blob(blob: &[u8]) -> Usage {
    let mut usage = Usage::default();
    if blob.len() >= 8 {
        usage.use_count = i32::from_le_bytes(blob[4..8].try_into().unwrap_or([0; 4])) as i64;
    }
    if blob.len() >= 72 {
        let filetime = u64::from_le_bytes(blob[60..68].try_into().unwrap_or([0; 8]));
        if filetime > 0 {
            let unix = (filetime / 10_000_000).saturating_sub(11_644_473_600);
            usage.last_used = Some(
                chrono_like(unix).unwrap_or_else(|| format!("{unix}")),
            );
        }
    }
    usage
}

fn chrono_like(unix: u64) -> Option<String> {
    // ISO-8601 UTC without extra crate: 1970-based approximation via time crate is overkill.
    let days = unix / 86400;
    let rem = unix % 86400;
    let (y, m, d) = civil_from_days(days as i64)?;
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    Some(format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z"))
}

fn civil_from_days(z: i64) -> Option<(i32, u32, u32)> {
    // Howard Hinnant civil_from_days (days since 1970-01-01).
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    Some((y as i32, m, d))
}

pub fn read_user_assist() -> HashMap<String, Usage> {
    let mut found = HashMap::new();
    let mut root = HKEY::default();
    let path: Vec<u16> = USERASSIST.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), Some(0), KEY_READ, &mut root) != ERROR_SUCCESS {
            return found;
        }
        let mut index = 0u32;
        loop {
            let mut name = [0u16; 256];
            let mut name_len = name.len() as u32;
            if RegEnumKeyExW(root, index, Some(PWSTR(name.as_mut_ptr())), &mut name_len, None, None, None, None) != ERROR_SUCCESS {
                break;
            }
            index += 1;
            let guid = String::from_utf16_lossy(&name[..name_len as usize]);
            let sub_path: Vec<u16> = format!("{guid}\\Count").encode_utf16().chain(std::iter::once(0)).collect();
            let mut count_key = HKEY::default();
            if RegOpenKeyExW(root, PCWSTR(sub_path.as_ptr()), Some(0), KEY_READ, &mut count_key) != ERROR_SUCCESS {
                continue;
            }
            let mut vi = 0u32;
            loop {
                let mut vname = [0u16; 1024];
                let mut vname_len = vname.len() as u32;
                let mut kind = 0u32;
                let mut data = [0u8; 256];
                let mut data_len = data.len() as u32;
                if RegEnumValueW(
                    count_key,
                    vi,
                    Some(PWSTR(vname.as_mut_ptr())),
                    &mut vname_len,
                    None,
                    Some(&mut kind),
                    Some(data.as_mut_ptr()),
                    Some(&mut data_len),
                ) != ERROR_SUCCESS
                {
                    break;
                }
                vi += 1;
                let raw = String::from_utf16_lossy(&vname[..vname_len as usize]);
                let decoded = rot13(&raw);
                if decoded.to_ascii_lowercase().starts_with("ueme_") {
                    continue;
                }
                let usage = parse_blob(&data[..data_len as usize]);
                let key = exe_key(&decoded);
                if key.ends_with(".exe") || decoded.contains('\\') || decoded.contains('!') {
                    found.insert(key, usage.clone());
                    found.insert(decoded.to_ascii_lowercase(), usage);
                }
            }
            let _ = RegCloseKey(count_key);
        }
        let _ = RegCloseKey(root);
    }
    found
}

pub fn merge_usage(id: &str, usage: &HashMap<String, Usage>) -> (Option<i64>, Option<String>) {
    merge_usage_keys(std::iter::once(id), usage)
}

pub fn merge_usage_keys<'a, I>(ids: I, usage: &HashMap<String, Usage>) -> (Option<i64>, Option<String>)
where
    I: IntoIterator<Item = &'a str>,
{
    let mut best: Option<&Usage> = None;
    for id in ids {
        if id.is_empty() {
            continue;
        }
        let key = exe_key(id);
        let hit = usage
            .get(&key)
            .or_else(|| usage.get(&id.to_ascii_lowercase()));
        match (best, hit) {
            (_, None) => {}
            (None, Some(found)) => best = Some(found),
            (Some(cur), Some(found)) if found.use_count > cur.use_count => best = Some(found),
            _ => {}
        }
    }
    match best {
        Some(hit) => (Some(hit.use_count), hit.last_used.clone()),
        None => (None, None),
    }
}
