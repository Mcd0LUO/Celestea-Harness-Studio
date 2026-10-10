//! Official input-desktop lock gate (`OpenInputDesktop` / Winlogon).

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::protocol::Error;

pub const OPEN_INPUT_DESKTOP_FAILED: &str = "OpenInputDesktop failed";
pub const GET_DESKTOP_NAME_FAILED: &str = "GetUserObjectInformationW failed";
pub const GET_DESKTOP_NAME_LENGTH: &str = "GetUserObjectInformationW did not report desktop name length";
pub const LOCKED_PREFIX: &str = "Windows desktop is locked (input desktop is ";
pub const LOCKED_SUFFIX: &str = "); unlock before using computer-use";
pub const FOREGROUND_NO_PID: &str = "foreground window did not report a process id";

/// Methods that never inject input, so the locked-desktop gate does not apply.
/// Discovery must keep working while the desktop is locked — the official prompt
/// tells the model to stop and ask for an unlock, which it can only do if it can
/// still tell what is on screen. (The gate that matters for input is
/// `require_unlocked`, which also demands a resolved foreground process.)
pub fn skip_lock_check(method: &str) -> bool {
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
            // read-only discovery
            | "list_windows"
            | "list_apps"
            | "get_window"
            | "window"
    )
}

pub fn input_desktop_name() -> Result<String, Error> {
    let desk = unsafe { OpenInputDesktop(Default::default(), false, DESKTOP_READOBJECTS) }
        .map_err(|_| Error::desktop(OPEN_INPUT_DESKTOP_FAILED))?;
    let mut needed = 0u32;
    let probe = unsafe {
        GetUserObjectInformationW(HANDLE(desk.0), UOI_NAME, None, 0, Some(&mut needed))
    };
    if probe.is_err() && needed == 0 {
        let _ = unsafe { CloseDesktop(desk) };
        return Err(Error::desktop(GET_DESKTOP_NAME_LENGTH));
    }
    let mut buf = vec![0u16; (needed as usize / 2).max(8)];
    let bytes = (buf.len() * 2) as u32;
    if unsafe {
        GetUserObjectInformationW(
            HANDLE(desk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr().cast()),
            bytes,
            Some(&mut needed),
        )
    }
    .is_err()
    {
        let _ = unsafe { CloseDesktop(desk) };
        return Err(Error::desktop(GET_DESKTOP_NAME_FAILED));
    }
    let _ = unsafe { CloseDesktop(desk) };
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Ok(String::from_utf16_lossy(&buf[..end]))
}

pub fn locked_message(name: &str) -> String {
    format!("{LOCKED_PREFIX}{name}{LOCKED_SUFFIX}")
}

fn name_is_lock_desktop(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower.contains("winlogon")
        || lower.contains("screensaver")
        || lower == "lock"
        || lower.contains("lock screen")
        || lower.contains("windows default")
}

pub fn foreground_pid() -> u32 {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return 0;
    }
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

pub fn require_foreground_pid() -> Result<u32, Error> {
    let pid = foreground_pid();
    if pid == 0 {
        return Err(Error::desktop(FOREGROUND_NO_PID));
    }
    Ok(pid)
}

/// Official `LockApp.exe` is the modern Windows lock screen. It takes the
/// foreground while the input desktop is still the normal `Default` desktop, so
/// the desktop *name* check alone misses it — which is exactly the state the
/// session is in after the screen locks: `GetForegroundWindow()` reports the
/// `Windows.UI.Core.CoreWindow` owned by `LockApp.exe`, and outside that window
/// it can transiently report `NULL`.
pub const LOCK_APP_CLASS: &str = "Windows.UI.Core.CoreWindow";
pub const LOCK_APP_EXE: &str = "lockapp.exe";

/// True when the foreground window belongs to the lock screen app.
fn foreground_is_lock_app(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    crate::enum_windows::exe_name(pid)
        .map(|name| name.eq_ignore_ascii_case(LOCK_APP_EXE))
        .unwrap_or(false)
}

/// Official `inspect active input desktop`: lock-screen name, then the modern
/// `LockApp.exe` foreground, then a resolved foreground process id.
pub fn require_unlocked() -> Result<(), Error> {
    let name = input_desktop_name()?;
    if name_is_lock_desktop(&name) {
        return Err(Error::desktop(locked_message(&name)));
    }
    let pid = foreground_pid();
    if foreground_is_lock_app(pid) {
        return Err(Error::desktop(locked_message("LockApp")));
    }
    if pid == 0 {
        return Err(Error::desktop(FOREGROUND_NO_PID));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_app_is_recognised_as_the_lock_screen() {
        // The modern lock screen keeps the input desktop named "Default", so the
        // name check cannot see it; the foreground process is the signal.
        assert_eq!(LOCK_APP_EXE, "lockapp.exe");
        assert_eq!(LOCK_APP_CLASS, "Windows.UI.Core.CoreWindow");
        assert!(!name_is_lock_desktop("Default"));
        assert_eq!(
            locked_message("LockApp"),
            "Windows desktop is locked (input desktop is LockApp); unlock before using computer-use"
        );
    }

    #[test]
    fn official_lock_strings() {
        assert_eq!(OPEN_INPUT_DESKTOP_FAILED, "OpenInputDesktop failed");
        assert_eq!(GET_DESKTOP_NAME_FAILED, "GetUserObjectInformationW failed");
        assert_eq!(
            locked_message("Winlogon"),
            "Windows desktop is locked (input desktop is Winlogon); unlock before using computer-use"
        );
        assert!(name_is_lock_desktop("Winlogon"));
        assert!(name_is_lock_desktop("Windows Default Lock Screen"));
        assert!(!name_is_lock_desktop("Default"));
        assert_eq!(FOREGROUND_NO_PID, "foreground window did not report a process id");
    }
}
