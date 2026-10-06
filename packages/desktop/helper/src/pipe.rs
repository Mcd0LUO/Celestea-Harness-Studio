//! Official NativePipeTransport: 4-byte LE length + JSON-RPC 2.0.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;

use serde_json::{json, Map, Value};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_WAIT,
};

use crate::protocol::{Request, APPROVED_APP_META_KEY};

pub const PIPE_ENV: &str = "SKY_CUA_NATIVE_PIPE";
pub const PIPE_ENV_ALT: &str = "COMPUTER_USE_PIPE";
/// Official `.mcp.json` companion to `SKY_CUA_NATIVE_PIPE=1`: the host-owned
/// pipe the helper must connect to as a client.
pub const PIPE_DIRECTORY_ENV: &str = "SKY_CUA_NATIVE_PIPE_DIRECTORY";
const MAX_IN: u32 = 64 * 1024 * 1024;
const MAX_OUT: usize = 8 * 1024 * 1024;
const REVERSE_APPROVAL: &str = "requestComputerUseApproval";

static NAME: Mutex<Option<String>> = Mutex::new(None);
static REVERSE_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn current_name() -> Option<String> {
    NAME.lock().ok().and_then(|g| g.clone())
}

pub fn default_name() -> String {
    if let Ok(raw) = std::env::var(PIPE_ENV).or_else(|_| std::env::var(PIPE_ENV_ALT)) {
        let trimmed = raw.trim();
        if trimmed.starts_with(r"\\.\pipe\") {
            return trimmed.to_string();
        }
    }
    format!(r"\\.\pipe\dsh-computer-use-{}", std::process::id())
}

/// LC-1: the transport the helper should use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PipeMode {
    /// DSH mode: create the pipe named by default_name() and serve it.
    Server(String),
    /// Official mode: a host-owned SKY_CUA_NATIVE_PIPE_DIRECTORY to connect to.
    Client(String),
    /// No pipe: stdio only.
    Stdio,
}

fn is_pipe_path(value: &str) -> bool {
    value.starts_with(r"\\.\pipe\") || value.starts_with(r"\\?\pipe\")
}

/// Official discovery (MCPJSON): SKY_CUA_NATIVE_PIPE=1 together with
/// SKY_CUA_NATIVE_PIPE_DIRECTORY pointing at \\.\pipe\codex-computer-use-<uuid> names
/// a **host-owned** pipe; the helper must connect as a client instead of creating
/// its own. The old code read only SKY_CUA_NATIVE_PIPE and treated it as a full
/// path, so the official variables fell back to a self-hosted
/// \\.\pipe\dsh-computer-use-<pid> that no official host could discover.
///
/// COMPUTER_USE_PIPE_SPAWN=1 (DSH's own Python launcher) sets
/// SKY_CUA_NATIVE_PIPE=1 WITHOUT a directory; that must keep the DSH self-hosted
/// name because the Python client discovers \\.\pipe\*computer-use*.
pub fn resolve_pipe_mode(env: &dyn Fn(&str) -> Option<String>, pid: u32) -> PipeMode {
    let flag = env(PIPE_ENV).map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let directory = env(PIPE_DIRECTORY_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if flag.as_deref() == Some("1") {
        if let Some(directory) = directory {
            return if is_pipe_path(&directory) { PipeMode::Client(directory) } else { PipeMode::Stdio };
        }
        return PipeMode::Server(format!(r"\\.\pipe\dsh-computer-use-{pid}"));
    }
    for key in [PIPE_ENV, PIPE_ENV_ALT] {
        if let Some(raw) = env(key) {
            let trimmed = raw.trim();
            if is_pipe_path(trimmed) {
                return PipeMode::Server(trimmed.to_string());
            }
        }
    }
    PipeMode::Server(format!(r"\\.\pipe\dsh-computer-use-{pid}"))
}

pub fn spawn<F>(mut dispatch: F) -> Option<String>
where
    F: FnMut(Request) -> Value + Send + 'static,
{
    match resolve_pipe_mode(&|name| std::env::var(name).ok(), std::process::id()) {
        PipeMode::Stdio => None,
        PipeMode::Server(name) => {
            if let Ok(mut slot) = NAME.lock() {
                *slot = Some(name.clone());
            }
            let name_thread = name.clone();
            thread::Builder::new()
                .name("cu-pipe".into())
                .spawn(move || run_pipe(&name_thread, &mut dispatch))
                .ok()?;
            Some(name)
        }
        PipeMode::Client(name) => {
            if let Ok(mut slot) = NAME.lock() {
                *slot = Some(name.clone());
            }
            let name_thread = name.clone();
            thread::Builder::new()
                .name("cu-pipe-client".into())
                .spawn(move || run_client(&name_thread, &mut dispatch))
                .ok()?;
            Some(name)
        }
    }
}

/// Official client transport: connect to the host-owned pipe and serve frames on
/// that handle (the 4-byte length framing is identical to the server side).
fn run_client<F>(name: &str, dispatch: &mut F)
where
    F: FnMut(Request) -> Value,
{
    loop {
        let Some(handle) = connect_client(name) else { return };
        serve_client(handle, dispatch);
        let _ = unsafe { CloseHandle(handle) };
    }
}

fn connect_client(name: &str) -> Option<HANDLE> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    for _ in 0..50 {
        let opened = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        if let Ok(handle) = opened {
            return Some(handle);
        }
        thread::sleep(std::time::Duration::from_millis(200));
    }
    None
}

fn run_pipe<F>(name: &str, dispatch: &mut F)
where
    F: FnMut(Request) -> Value,
{
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    loop {
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                MAX_OUT as u32,
                MAX_IN,
                0,
                None,
            )
        };
        if handle.is_invalid() {
            return;
        }
        if unsafe { ConnectNamedPipe(handle, None) }.is_err() {
            let _ = unsafe { CloseHandle(handle) };
            continue;
        }
        serve_client(handle, dispatch);
        let _ = unsafe { DisconnectNamedPipe(handle) };
        let _ = unsafe { CloseHandle(handle) };
    }
}

fn serve_client<F>(handle: HANDLE, dispatch: &mut F)
where
    F: FnMut(Request) -> Value,
{
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 65536];
    loop {
        let mut read = 0u32;
        let ok = unsafe { ReadFile(handle, Some(chunk.as_mut_slice()), Some(&mut read), None) };
        if ok.is_err() || read == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..read as usize]);
        loop {
            let Some((payload, rest)) = take_frame(&buf) else { break };
            buf = rest;
            let reply = handle_payload(payload, dispatch, handle, &mut buf, &mut chunk);
            if write_frame(handle, &reply).is_err() {
                return;
            }
        }
    }
}

fn take_frame(buf: &[u8]) -> Option<(Value, Vec<u8>)> {
    if buf.len() < 4 {
        return None;
    }
    let len = u32::from_le_bytes(buf[..4].try_into().ok()?) as usize;
    if len > MAX_IN as usize {
        return None;
    }
    if buf.len() < 4 + len {
        return None;
    }
    let payload = serde_json::from_slice(&buf[4..4 + len]).ok()?;
    Some((payload, buf[4 + len..].to_vec()))
}

fn write_frame(handle: HANDLE, value: &Value) -> Result<(), ()> {
    let blob = serde_json::to_vec(value).map_err(|_| ())?;
    if blob.len() > MAX_OUT {
        return Err(());
    }
    let mut frame = Vec::with_capacity(4 + blob.len());
    frame.extend_from_slice(&(blob.len() as u32).to_le_bytes());
    frame.extend_from_slice(&blob);
    let mut written = 0u32;
    unsafe { WriteFile(handle, Some(&frame), Some(&mut written), None) }.map_err(|_| ())?;
    Ok(())
}

fn handle_payload<F>(payload: Value, dispatch: &mut F, pipe: HANDLE, buf: &mut Vec<u8>, chunk: &mut [u8]) -> Value
where
    F: FnMut(Request) -> Value,
{
    let req = request_from_payload(&payload);
    let reply = dispatch(req.clone());
    if let Some(approval) = extract_approval(&reply) {
        if let Some(retried) = reverse_approval(pipe, buf, chunk, &approval, &req, dispatch) {
            return retried;
        }
    }
    reply
}

fn request_from_payload(payload: &Value) -> Request {
    let obj = payload.as_object().cloned().unwrap_or_default();
    let id = obj.get("id").cloned().unwrap_or(Value::Null);
    let method = obj.get("method").and_then(Value::as_str).unwrap_or("");
    let params = match obj.get("params") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let (inner_method, inner_params, meta) = if method == "request" {
        let inner = params.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let inner_params = match params.get("params") {
            Some(Value::Object(map)) => Value::Object(map.clone()),
            _ => json!({}),
        };
        let meta = params.get("codexTurnMetadata").cloned().unwrap_or(Value::Null);
        (inner, inner_params, meta)
    } else {
        (method.to_string(), Value::Object(params), obj.get("meta").cloned().unwrap_or(Value::Null))
    };
    Request {
        jsonrpc: Some("2.0".into()),
        id,
        method: Some(inner_method),
        params: inner_params,
        meta,
    }
}

fn extract_approval(reply: &Value) -> Option<Value> {
    if let Some(req) = reply.get("approvalRequest") {
        return Some(req.clone());
    }
    reply
        .get("error")
        .and_then(|err| err.get("data"))
        .and_then(|data| data.get("approvalRequest"))
        .cloned()
}

fn reverse_approval<F>(
    pipe: HANDLE,
    buf: &mut Vec<u8>,
    chunk: &mut [u8],
    approval: &Value,
    original: &Request,
    dispatch: &mut F,
) -> Option<Value>
where
    F: FnMut(Request) -> Value,
{
    let seq = REVERSE_SEQ.fetch_add(1, Ordering::SeqCst);
    let reverse_id = format!("cua-approval-{seq}");
    let frame = json!({
        "id": reverse_id,
        "jsonrpc": "2.0",
        "method": REVERSE_APPROVAL,
        "params": approval,
    });
    write_frame(pipe, &frame).ok()?;
    let answer = wait_jsonrpc_reply(pipe, buf, chunk, &reverse_id)?;
    if !approval_accepted(&answer) {
        return None;
    }
    let app = approval.get("app").and_then(Value::as_str).unwrap_or("").to_string();
    let mut retry = original.clone();
    let mut meta = match retry.meta {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if !app.is_empty() {
        meta.insert(APPROVED_APP_META_KEY.to_string(), json!(app));
    }
    retry.meta = Value::Object(meta);
    Some(dispatch(retry))
}

fn wait_jsonrpc_reply(pipe: HANDLE, buf: &mut Vec<u8>, chunk: &mut [u8], id: &str) -> Option<Value> {
    loop {
        if let Some((payload, rest)) = take_frame(buf) {
            *buf = rest;
            let got = payload.get("id").and_then(|v| {
                v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string()))
            });
            if got.as_deref() == Some(id) {
                return Some(payload);
            }
            continue;
        }
        let mut read = 0u32;
        let ok = unsafe { ReadFile(pipe, Some(&mut chunk[..]), Some(&mut read), None) };
        if ok.is_err() || read == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..read as usize]);
    }
}

fn approval_accepted(reply: &Value) -> bool {
    if reply.get("error").is_some() {
        return false;
    }
    match reply.get("result") {
        None => false,
        Some(Value::Null) => true,
        Some(Value::Bool(ok)) => *ok,
        Some(Value::String(s)) => matches!(
            s.to_ascii_lowercase().as_str(),
            "accept" | "always" | "session" | "allow"
        ),
        Some(Value::Object(map)) => {
            if map.get("approved").and_then(Value::as_bool) == Some(true) {
                return true;
            }
            let action = map
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            matches!(action.as_str(), "accept" | "always" | "session" | "allow" | "")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_jsonrpc_approval_request() {
        let reply = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {"code": -32001, "message": "need approval", "data": {"approvalRequest": {"app": "notepad.exe"}}}
        });
        assert_eq!(extract_approval(&reply).unwrap()["app"], "notepad.exe");
    }

    #[test]
    fn accepts_elicitation_action() {
        assert!(approval_accepted(&json!({"jsonrpc":"2.0","id":"x","result":{"action":"accept"}})));
        assert!(!approval_accepted(&json!({"jsonrpc":"2.0","id":"x","error":{"code":-32000,"message":"no"}})));
    }
    #[test]
    fn official_pipe_directory_selects_client_mode() {
        let env = |key: &str| match key {
            PIPE_ENV => Some("1".to_string()),
            PIPE_DIRECTORY_ENV => Some(r"\\.\pipe\codex-computer-use-2f424681".to_string()),
            _ => None,
        };
        assert_eq!(
            resolve_pipe_mode(&env, 99),
            PipeMode::Client(r"\\.\pipe\codex-computer-use-2f424681".into())
        );
    }

    #[test]
    fn dsh_pipe_flag_without_directory_keeps_self_hosting() {
        // COMPUTER_USE_PIPE_SPAWN=1 produces SKY_CUA_NATIVE_PIPE=1 with no directory;
        // the Python client discovers \\.\pipe\*computer-use*, so the DSH default
        // name must survive.
        let env = |key: &str| (key == PIPE_ENV).then(|| "1".to_string());
        assert_eq!(
            resolve_pipe_mode(&env, 4321),
            PipeMode::Server(r"\\.\pipe\dsh-computer-use-4321".into())
        );
    }

    #[test]
    fn explicit_legacy_pipe_paths_still_self_host() {
        let env = |key: &str| match key {
            PIPE_ENV_ALT => Some(r"\\.\pipe\custom-computer-use".to_string()),
            _ => None,
        };
        assert_eq!(
            resolve_pipe_mode(&env, 1),
            PipeMode::Server(r"\\.\pipe\custom-computer-use".into())
        );
        let none = |_key: &str| None;
        assert_eq!(resolve_pipe_mode(&none, 7), PipeMode::Server(r"\\.\pipe\dsh-computer-use-7".into()));
    }
}
