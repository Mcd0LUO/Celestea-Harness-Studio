//! Celestea 桌面 helper 的 stdio 可执行文件。
//!
//! 协议：NDJSON over stdio，一行一个请求 `{id, method, params}`，一行一个响应
//! `{id, ok, value, images}`（截图走独立的 `images` 字段）。握手方法 `ping` 回
//! `{version, platform, features}`，见总规划 §5。
//!
//! 移植自参考仓 `dsh-computer-use_codex-style/helper-rs`；相对参考仓剔除了
//! overlay（零操作垫片）、音频、浏览器 URL 闸门与提示词资源，差异清单见
//! `packages/computer-use/helper/PORTING.md`。

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use celestea_desktop_helper::capture;
use celestea_desktop_helper::desktop;
use celestea_desktop_helper::dpi;
use celestea_desktop_helper::app_catalog;
use celestea_desktop_helper::enum_windows::{
    activate_hwnd, app_identity_matches, enum_windows, exe_name, extra_space_hwnds, foreground_hwnd,
    hwnd_from_id, is_already_foreground,
    id_from_hwnd, lookup_window, space_identity, window_pid, window_rect, WindowRef,
};
use celestea_desktop_helper::images;
use celestea_desktop_helper::input;
use celestea_desktop_helper::interrupt;
use celestea_desktop_helper::notify;
use celestea_desktop_helper::overlay;
use celestea_desktop_helper::pipe;
use celestea_desktop_helper::policy;
use celestea_desktop_helper::protocol::{
    self, capture_timeout_ms, json_f64, json_i64, json_str, official_ok, require_text,
    require_text_allow_empty, Error, Request,
    APPROVED_APP_META_KEY, BUDGET_EXHAUSTED, BUDGET_HEADER,
};
use celestea_desktop_helper::state::{
    require_observable_window, require_usable_app_window, require_window_spec_app,
    screenshot_targets_missing,
    window_bounds_unavailable_message, HelperState, WindowUse, COORDINATE_GEOMETRY_UNAVAILABLE,
    LAST_WINDOW_IDENTITY, WINDOW_BOUNDS_UNAVAILABLE_COORD,
};
use celestea_desktop_helper::tools;
use celestea_desktop_helper::uia::{self, STATE_FLAG_ERROR};
use serde_json::{json, Map, Value};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};

static RUNNING: AtomicBool = AtomicBool::new(true);
static LAST_RPC: Mutex<Option<Instant>> = Mutex::new(None);
static IN_FLIGHT: AtomicU32 = AtomicU32::new(0);

fn main() {
    dpi::enable();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut parent_pid: u32 = 0;
    // CLI 面：手写解析，无 clap、无子命令、无 --help；比较是精确等长，所以
    // "--flag=value" 一律被拒，非法 argv 在进入 serve 循环之前就退出（exit 2）。
    //   --parent-pid <u32>
    //   --previous-notify <payload>
    // 参考仓的 --system-cursor-manager 与合成光标缩放环境变量随 overlay 一并剔除
    // （规划 §2/§9：本期不做 overlay）；ttl / allow-list 等旋钮走 sidecar 配置。
    let mut prev_notify: Option<String> = None;
    let missing = |what: &str| -> ! {
        eprintln!("{what}");
        std::process::exit(2);
    };
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--parent-pid" => match args.get(i + 1) {
                Some(v) => {
                    parent_pid = v.parse().unwrap_or_else(|_| missing("parse parent pid"));
                    i += 1;
                }
                None => missing("missing parent pid"),
            },
            "--previous-notify" => match args.get(i + 1) {
                Some(v) => {
                    prev_notify = Some(v.clone());
                    i += 1;
                }
                None => missing("missing value for --previous-notify"),
            },
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    if let Some(payload) = prev_notify.as_deref() {
        // Official: the notify hook calls back with the previous payload so the
        // helper can restore the user's original notify config on turn end.
        // NTF-2: the official path only accepts the `turn-ended` payload and exits
        // non-zero with `missing turn-ended payload` for anything else.
        if let Err(message) = notify::validate_previous_notify_payload(payload) {
            eprintln!("{message}");
            std::process::exit(2);
        }
        notify::restore_previous_notify();
        return;
    }
    if parent_pid != 0 {
        thread::spawn(move || watch_parent(parent_pid));
    }

    let mut helper = HelperState::new("window2".into());
    // D3/AX-14: official has no time-based observation expiry. Freshness is identity
    // + bounds + human-input based (see state::require_window_use / interrupt); the
    // TTL rejection is deleted in state::require_fresh and ttl_ms now defaults to 0.
    // DSH extension (not part of the official CLI): the sidecar narrows the target
    // set through the environment so the binary keeps the official argument surface.
    helper.allowed_apps = std::env::var("DSH_COMPUTER_USE_ALLOWED_APPS")
        .ok()
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let state = Arc::new(Mutex::new(helper));
    let state_pipe = state.clone();
    let _pipe_name = pipe::spawn(move |req| handle(&state_pipe, req));
    // Official has no idle self-termination: the helper lives until its parent
    // goes away, the turn ends via the notify hook, or `close` arrives. An
    // opt-in watchdog remains for leaks, disabled by default.
    if let Ok(ms) = std::env::var("DSH_COMPUTER_USE_IDLE_EXIT_MS") {
        if let Ok(ms) = ms.trim().parse::<u64>() {
            if ms > 0 {
                thread::spawn(move || idle_exit_watch(ms));
            }
        }
    }
    // Backstop, not part of the official contract: the official helper is per-turn and
    // dies with the turn, while this one is reused across turns so a restart is cheap.
    // A turn that ends without the client's `end_turn`/`cancel` -- a dropped event, a
    // killed client -- would otherwise leave the synthetic cursor on the desktop
    // indefinitely. Hide it after a long quiet period; the next request shows it again.
    // `DSH_CU_OVERLAY_IDLE_HIDE_MS=0` disables the backstop.
    let overlay_idle_ms = std::env::var("DSH_CU_OVERLAY_IDLE_HIDE_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(120_000);
    if overlay_idle_ms > 0 {
        thread::spawn(move || overlay_idle_hide_watch(overlay_idle_ms));
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // FIX-3: an `end_turn` latched the previous turn. Clear per-turn state and
        // re-arm before dispatching anything from the next turn, so one helper
        // process can serve a whole session.
        if interrupt::take_restart() {
            interrupt::reset_turn();
            RUNNING.store(true, Ordering::SeqCst);
            if let Ok(mut st) = state.lock() {
                st.reset_turn_state();
            }
        }
        let reply = match protocol::decode_request(&line) {
            Ok(req) => handle(&state, req),
            Err(err) => json!({"id": null, "ok": false, "error": format!("invalid json: {err}")}),
        };
        if writeln!(stdout, "{reply}").is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

/// 握手响应（规划 §5）：`{version, platform, features}`。
///
/// `version` 来自 Cargo.toml，sidecar 与之比对；不一致按结构化错误处理（规划 §8
/// 「helper/工具版本漂移」）。`platform` 是显式写入的常量而非隐式读
/// `std::env::consts`，与规划 §7 的跨平台抽象口径一致。
fn handshake() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": "win32",
        "features": helper_features(),
    })
}

/// helper 真实具备的能力位 = 跨平台开关（规划 §7）。sidecar 拿它决定本平台的工具面。
///
/// 这里列的是**实际存在**的能力，不是愿望清单：overlay 与音频本期不移植，所以不出现在
/// 列表里（sidecar 若按列表挂 overlay 相关工具就会挂出空壳）。
fn helper_features() -> Vec<&'static str> {
    let mut features = vec![
        "capture-gdi-fallback",
        "input-sendinput",
        "uia",
        "enum-windows",
        "app-catalog",
        "assist-userassist",
        "lease-input-monitor",
    ];
    if cfg!(feature = "wgc") {
        features.insert(0, "wgc");
    }
    features
}

fn watch_parent(pid: u32) {
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(handle, INFINITE);
            RUNNING.store(false, Ordering::SeqCst);
        }
    }
}

fn ingest_meta(state: &Mutex<HelperState>, meta: &Map<String, Value>) {
    let mut scope: Option<(String, String)> = None;
    if let Ok(mut st) = state.lock() {
        if let Some(app) = json_str(meta, APPROVED_APP_META_KEY) {
            st.approved.insert(app.to_lowercase());
        }
        if let Some(conv) = json_str(meta, "conversationId")
            .or_else(|| json_str(meta, "conversation_id"))
            .or_else(|| json_str(meta, "sessionId"))
            .or_else(|| json_str(meta, "session_id"))
        {
            st.session_id = conv;
        }
        if let Some(turn) = json_str(meta, "turnId")
            .or_else(|| json_str(meta, "turn_id"))
            .or_else(|| json_str(meta, "callId"))
        {
            st.turn_id = turn;
        }
        st.ingest_approval_grants(&Value::Object(meta.clone()));
        scope = Some((st.session_id.clone(), st.turn_id.clone()));
    }
    // The Esc hook thread writes <home>/cache/computer-use/interrupts/<session>/<turn>,
    // so it needs the current scope without locking the whole helper state.
    if let Some((session, turn)) = scope {
        interrupt::set_session_scope(&session, &turn);
    }
}

fn request_budget_ms(req: &Request, params: &Map<String, Value>) -> i64 {
    let mut budget = req.budget_ms();
    if let Some(Value::Object(meta)) = params.get("meta") {
        if let Some(n) = protocol::meta_i64(&Value::Object(meta.clone()), BUDGET_HEADER) {
            budget = n;
        }
    }
    budget
}

fn budget_check(started: Instant, budget_ms: i64) -> Result<(), Error> {
    if budget_ms <= 0 {
        return Ok(());
    }
    if started.elapsed().as_millis() as i64 >= budget_ms {
        return Err(Error::desktop(BUDGET_EXHAUSTED));
    }
    Ok(())
}

fn touch_rpc() {
    if let Ok(mut slot) = LAST_RPC.lock() {
        *slot = Some(Instant::now());
    }
}

/// Hide a synthetic cursor that outlived its turn. The client is expected to send
/// `end_turn`/`cancel` at `turn/end`; this only bounds the damage when that signal is
/// lost, so the operator is never left with a fake pointer on the desktop.
fn overlay_idle_hide_watch(idle_ms: u64) {
    loop {
        thread::sleep(Duration::from_secs(2));
        if !overlay::visible() || IN_FLIGHT.load(Ordering::SeqCst) > 0 {
            continue;
        }
        let last = LAST_RPC.lock().ok().and_then(|g| *g);
        let Some(last) = last else { continue };
        if last.elapsed() >= Duration::from_millis(idle_ms) {
            overlay::hide();
        }
    }
}

fn idle_exit_watch(idle_ms: u64) {
    let idle = Duration::from_millis(idle_ms);
    loop {
        thread::sleep(Duration::from_secs(2));
        if overlay::visible() || IN_FLIGHT.load(Ordering::SeqCst) > 0 {
            continue;
        }
        let last = LAST_RPC.lock().ok().and_then(|g| *g);
        let Some(last) = last else { continue };
        if last.elapsed() >= idle {
            overlay::hide();
            overlay::stop_system_cursor_manager();
            RUNNING.store(false, Ordering::SeqCst);
            std::process::exit(0);
        }
    }
}

struct InflightGuard;
impl Drop for InflightGuard {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Requests slow enough that the transport's own budget is at risk.
///
/// The transport kills the helper when a request exceeds its budget, so the process's own
/// diagnostics are gone by the time anyone can ask what was slow: the model sees only
/// "computer-use request timed out". This appends one JSON line per slow request to
/// `%LOCALAPPDATA%\computer-use-app-catalog\slow-requests.log` (bounded, local only,
/// never sent anywhere) with the method, the duration and the catalog timing, so a
/// sporadic timeout is diagnosable after the fact instead of unreproducible.
///
/// `DSH_CU_SLOW_REQUEST_MS` overrides the threshold (default 1000 ms; 0 logs every
/// request, which is the supported way to record a baseline).
fn note_slow_request(label: &str, elapsed_ms: u64) {
    let threshold = std::env::var("DSH_CU_SLOW_REQUEST_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(1000);
    if elapsed_ms < threshold {
        return;
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let dir = std::path::PathBuf::from(local).join("computer-use-app-catalog");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("slow-requests.log");
    // Bounded: drop the oldest lines once the file passes 128 KB.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 128 * 1024 {
            if let Ok(text) = std::fs::read_to_string(&path) {
                let rows: Vec<&str> = text.lines().rev().take(200).collect();
                let kept: Vec<&str> = rows.into_iter().rev().collect();
                let _ = std::fs::write(&path, kept.join("\n") + "\n");
            }
        }
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = json!({
        "at": at,
        "label": label,
        "elapsedMs": elapsed_ms,
        "processId": std::process::id(),
        "appCatalog": app_catalog::catalog_diagnostics(),
    });
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
}

fn handle(state: &Mutex<HelperState>, req: Request) -> Value {
    IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    let _inflight = InflightGuard;
    touch_rpc();
    let id = req.id.clone();
    let official = req.is_official();
    let jsonrpc = req.is_jsonrpc_v2();
    let method = req.method_name().to_string();
    let params = req.params_object();
    let started = Instant::now();
    let budget_ms = request_budget_ms(&req, &params);
    ingest_meta(state, &req.meta_object());
    if method == "call" {
        if let Some(Value::Object(meta)) = params.get("meta") {
            ingest_meta(state, meta);
        }
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let arguments = match params.get("arguments") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        let label = format!("call {name}");
        let value = match gate_and_dispatch(state, name, &arguments, started, budget_ms) {
            Ok(value) => {
                let (value, images) = images::detach_images(value);
                let value = if tools::is_void(name) { Value::Null } else { value };
                let wrapped = protocol::call_result(name, value, images);
                if jsonrpc {
                    protocol::jsonrpc_ok(id, wrapped)
                } else {
                    official_ok(id, wrapped)
                }
            }
            Err(err) => err.to_response(id, jsonrpc),
        };
        note_slow_request(&label, started.elapsed().as_millis() as u64);
        return value;
    }
    let result = if method == "close" {
        dispatch(state, "shutdown", &params)
    } else if method == "ping" {
        // 握手（规划 §5）必须绕开 turn 中断检查 / 桌面锁 / 托管策略检查：sidecar 正是
        // 靠这一发判断 helper 能不能用，被闸门拒掉会把「未授权」误报成「未启动」。
        Ok(handshake())
    } else {
        gate_and_dispatch(state, &method, &params, started, budget_ms)
    };
    let response = match result {
        Ok(value) if official => official_ok(id, value),
        Err(err) => err.to_response(id, jsonrpc),
        Ok(value) if jsonrpc => protocol::jsonrpc_ok(id, value),
        Ok(value) => official_ok(id, value),
    };
    note_slow_request(&method, started.elapsed().as_millis() as u64);
    response
}

fn target_app(method: &str, params: &Map<String, Value>) -> String {
    if method == "launch_app" {
        return json_str(params, "app").unwrap_or_default();
    }
    if let Some(Value::Object(window)) = params.get("window") {
        if let Some(app) = json_str(window, "app") {
            return app;
        }
    }
    json_str(params, "app").unwrap_or_default()
}

fn gate_and_dispatch(
    state: &Mutex<HelperState>,
    method: &str,
    params: &Map<String, Value>,
    started: Instant,
    budget_ms: i64,
) -> Result<Value, Error> {
    budget_check(started, budget_ms)?;
    // The turn-lifecycle method must stay reachable while the turn is stopped: `end_turn` is
    // the only path that clears the STOPPED latch and deletes the interrupt marker, so routing
    // it through those very checks made the cleanup unreachable exactly when it was needed
    // (measured: `end_turn` answered with the physical-Escape message while a marker existed).
    let lifecycle = matches!(method, "end_turn");
    if !lifecycle {
        interrupt::check()?;
    }
    if !desktop::skip_lock_check(method) {
        desktop::require_unlocked()?;
    }
    if !policy::skip_managed_policy_check(method) {
        policy::require_computer_use_enabled().map_err(Error::desktop)?;
    }
    let marker = {
        let st = state.lock().map_err(|_| Error::other("state lock"))?;
        notify::interrupt_flag_path(&st.session_id, &st.turn_id)
    };
    // A live marker refuses the call; a marker left over from an earlier turn is removed and
    // ignored (`interrupt::marker_blocks`). Existence alone used to mean "refused forever".
    if !lifecycle && interrupt::marker_blocks(&marker) {
        return Err(Error::interrupt());
    }
    // 目标应用批准闸门。`launch_app` 先解析 catalog/exe 身份再走自己的错误路径，
    // 其余方法按 `target_app` 解析出的应用查会话批准表。
    if method != "launch_app" && !tools::skip_approval(method) {
        // launch_app resolves catalog/exe identity first, then uses
        // `launch_app has no approved target` instead of the generic approval prompt.
        let app = target_app(method, params);
        if !app.is_empty() {
            let approved = {
                let st = state.lock().map_err(|_| Error::other("state lock"))?;
                st.approved.contains(&app.to_lowercase())
            };
            if !approved {
                return Err(Error::approval(&app));
            }
        }
    }
    let value = dispatch(state, method, params)?;
    budget_check(started, budget_ms)?;
    Ok(value)
}

fn dispatch(state: &Mutex<HelperState>, method: &str, params: &Map<String, Value>) -> Result<Value, Error> {
    let method = match method {
        "observe" => "get_window_state",
        "type" => "type_text",
        "keypress" => "press_key",
        "window" => "get_window",
        other => other,
    };
    match method {
        "health" => {
            let st = state.lock().map_err(|_| Error::other("state lock"))?;
            Ok(json!({
                "ok": true,
                "overlay": "dsh",
                "helper": "dsh-computer-use",
                "native": true,
                "surface": st.surface,
                "backend": st.backend,
                "ttlMs": st.ttl_ms,
                "closed": st.closed,
                "allowedApps": st.allowed_apps,
                "observation": st.lease_snapshot(),
                "pipe": pipe::current_name(),
                "computerUseEnabled": policy::computer_use_enabled(),
                "capture": {"wgcFramePool": capture::wgc_available(), "jpeg": true, "cachedSessionCount": capture::cached_session_count()},
                "dpi": {"aware": true, "scale": dpi::dpi_scale(dpi::window_dpi(hwnd_from_id(0)))},
            }))
        }
        "tools" => {
            let surface = json_str(params, "surface").unwrap_or_else(|| {
                state
                    .lock()
                    .ok()
                    .map(|st| st.surface.clone())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| "computer".into())
            });
            Ok(tools::tools_for_surface(&surface))
        }
        "interrupt" => {
            interrupt::trip();
            overlay::hide();
            Ok(json!({"stopped": true}))
        }
        "cancel" => {
            interrupt::cancel_work();
            Ok(json!({"cancelled": true}))
        }
        "end_turn" => {
            let (session_id, turn_id) = {
                let st = state.lock().map_err(|_| Error::other("state lock"))?;
                (
                    json_str(params, "session_id").unwrap_or_else(|| st.session_id.clone()),
                    json_str(params, "turn_id").unwrap_or_else(|| st.turn_id.clone()),
                )
            };
            interrupt::set_session_scope(&session_id, &turn_id);
            interrupt::end_turn();
            interrupt::signal_turn_ended(&session_id, &turn_id);
            let _ = notify::write_notify_config(&session_id, &turn_id);
            if let Ok(mut st) = state.lock() {
                st.reset_turn_state();
            }
            overlay::hide();
            Ok(json!({
                "ended": true,
                "session_id": session_id,
                "turn_id": turn_id,
                "notify": true,
            }))
        }
        "shutdown" => {
            capture::invalidate_cached_sessions("exit");
            RUNNING.store(false, Ordering::SeqCst);
            if let Ok(mut st) = state.lock() {
                st.closed = true;
            }
            Ok(json!({"closed": true}))
        }
        "list_windows" => Ok(Value::Array(
            enum_windows()?.into_iter().map(|w| w.to_json()).collect(),
        )),
        "list_apps" => {
            let windows = enum_windows()?;
            Ok(Value::Array(
                app_catalog::list_apps(&windows)
                    .into_iter()
                    .map(|a| a.to_json())
                    .collect(),
            ))
        }
        "get_window" | "window" => {
            let window = resolve_window(state, params)?;
            require_usable_app_window(hwnd_from_id(window.id))?;
            Ok(window.to_json())
        }
        "activate_window" => {
            let window = resolve_window(state, params)?;
            activate_hwnd(hwnd_from_id(window.id))?;
            state.lock().map_err(|_| Error::other("state lock"))?.remember_window(window);
            Ok(json!({}))
        }
        "launch_app" => {
            let app = require_text(params, "app")?;
            let info = app_catalog::resolve_launch_info(&app)?;
            let (allowed, approved) = {
                let st = state.lock().map_err(|_| Error::other("state lock"))?;
                (st.allowed_apps.clone(), st.approved.clone())
            };
            policy::deny_allowed_apps(&app, &allowed).map_err(Error::desktop)?;
            policy::deny_app(&app).map_err(Error::desktop)?;
            policy::deny_app(&info.launch_file).map_err(Error::desktop)?;
            if !info.identity.is_empty() {
                policy::deny_app(&info.identity).map_err(Error::desktop)?;
            }
            if let Some(name) = info.product_name.as_deref() {
                policy::deny_product_identity(name, info.original_filename.as_deref())
                    .map_err(Error::desktop)?;
            }
            if !app_catalog::launch_target_approved(&approved, &app, &info) {
                // APS-11: derive the risk level from the PE identity, so a renamed
                // antivirus binary is still reported as high risk.
                return Err(Error::launch_unapproved_identity(
                    &app,
                    &info.display_name(),
                    info.product_name.as_deref(),
                    info.original_filename.as_deref(),
                ));
            }
            app_catalog::launch_app(&app)?;
            Ok(json!({}))
        }
        "batch_actions" => batch_actions(state, params),
        "session_note" => {
            let mut st = state.lock().map_err(|_| Error::other("state lock"))?;
            if let Some(text) = json_str(params, "text") {
                let cleaned = text.trim().to_string();
                if !cleaned.is_empty() {
                    st.reasoning.push(cleaned.clone());
                    let n = st.reasoning.len();
                    st.notes.insert(format!("note-{n}"), cleaned);
                }
            } else {
                let key = json_str(params, "key").unwrap_or_else(|| "note".into());
                let value = json_str(params, "value").unwrap_or_default();
                st.notes.insert(key, value);
            }
            Ok(json!({"ok": true, "reasoning": st.reasoning, "notes": st.notes}))
        }
        "session_state" => {
            let st = state.lock().map_err(|_| Error::other("state lock"))?;
            Ok(json!({
                "notes": st.notes,
                "reasoning": st.reasoning,
                "window": st.last_window.as_ref().map(|w| w.to_json()),
                "screenshot_ids": st.shots.keys().cloned().collect::<Vec<_>>(),
            }))
        }
        "get_window_state" => get_window_state(state, params),
        "set_value" => {
            state.lock().map_err(|_| Error::other("state lock"))?.require_fresh()?;
            set_value(state, params)
        }
        "perform_secondary_action" => {
            state.lock().map_err(|_| Error::other("state lock"))?.require_fresh()?;
            secondary(state, params)
        }
        "click" | "click_element" => {
            state.lock().map_err(|_| Error::other("state lock"))?.require_fresh()?;
            click(state, params, method)
        }
        "scroll" | "scroll_element" => {
            state.lock().map_err(|_| Error::other("state lock"))?.require_fresh()?;
            scroll(state, params, method)
        }
        "type_text" => {
            let window = resolve_window(state, params)?;
            prepare_input(state, &window, WindowUse::Captured)?;
            overlay::show();
            // Official `type_text` accepts an empty string: the schema requires the
            // key to be present, not to be non-empty (TC-11).
            input::paste_text(&require_text_allow_empty(params, "text")?)?;
            Ok(json!({}))
        }
        "press_key" => {
            let window = resolve_window(state, params)?;
            let key = require_text(params, "key")?;
            policy::deny_press_key(&key).map_err(Error::desktop)?;
            prepare_input(state, &window, WindowUse::Captured)?;
            overlay::show();
            input::press_key(&key)?;
            Ok(json!({}))
        }
        "drag" => {
            state.lock().map_err(|_| Error::other("state lock"))?.require_fresh()?;
            drag(state, params)
        }
        "diagnostic_state" => diagnostic_state(state),
        other => Err(Error::unknown_method(other)),
    }
}

fn prepare_input(state: &Mutex<HelperState>, window: &WindowRef, use_: WindowUse) -> Result<(), Error> {
    let hwnd = hwnd_from_id(window.id);
    {
        let st = state.lock().map_err(|_| Error::other("state lock"))?;
        st.require_fresh()?;
        st.require_window_use(window.id, use_)?;
        policy::deny_target(&window.app, hwnd, &st.allowed_apps).map_err(Error::desktop)?;
    }
    if !is_already_foreground(hwnd) {
        activate_hwnd(hwnd)?;
    }
    Ok(())
}

fn flag(params: &Map<String, Value>, key: &str, default: bool) -> bool {
    match params.get(key) {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64() != Some(0),
        None => default,
        _ => default,
    }
}

/// Lenient reader for the DSH-only diff opt-out spellings (`disableDiffing` / `disable_diffing`
/// / `disableDiff`).
///
/// CORRECTION (report 03 / TC-03 / AX-04): this is **not** an official contract. The official
/// window2 surface has no diffing at all -- `diff`/`iff`/`ferent` are absent from its string
/// table and a second observation returns the full tree (`parity/golden-ax/official-diff.txt`),
/// and `disableDiffing` appears in neither `docs/guidance.md` nor `docs/api.md`. The flag stays
/// because the DSH plugin opts into a line diff; it must not be described as official.
fn flag_any(params: &Map<String, Value>, keys: &[&str], default: bool) -> bool {
    for key in keys {
        if params.contains_key(*key) {
            return flag(params, key, default);
        }
    }
    default
}

fn get_window_state(state: &Mutex<HelperState>, params: &Map<String, Value>) -> Result<Value, Error> {
    let include_shot = flag(params, "include_screenshot", true);
    let include_text = flag(params, "include_text", false);
    if !include_shot && !include_text {
        return Err(Error::type_err(STATE_FLAG_ERROR));
    }
    // Official diffing is on by default; disableDiffing forces a full tree, and a
    // previous screenshot-only observation also forces a full tree.
    let disable_diffing = flag_any(params, &["disableDiffing", "disable_diffing", "disableDiff"], false);
    let window = resolve_window(state, params)?;
    let hwnd = hwnd_from_id(window.id);
    require_observable_window(hwnd)?;
    overlay::exclude_overlay_from_capture();
    for h in overlay::hwnds() {
        capture::register_overlay_hwnd(h);
    }
    let timeout_ms = capture_timeout_ms(params)?;
    let extra_timeout_ms = timeout_ms.min(400);
    let pending_shot = {
        let st = state.lock().map_err(|_| Error::other("state lock"))?;
        format!("screenshot-{}", st.next_shot)
    };
    let frame = if include_shot {
        match capture::capture_hwnd_timeout(window.id as isize, timeout_ms) {
            Ok(frame) => frame,
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("GetWindowRect")
                    || msg.contains("invalid bounds")
                    || msg.contains("window bounds unavailable")
                {
                    return Err(Error::desktop(window_bounds_unavailable_message(&window)));
                }
                if msg.contains("no screenshot targets found for") || msg.contains("no monitor") {
                    return Err(Error::desktop(screenshot_targets_missing(&pending_shot, &window)));
                }
                return Err(Error::desktop(msg));
            }
        }
    } else {
        let (ox, oy, w, h) = match celestea_desktop_helper::enum_windows::window_rect(hwnd) {
            Ok(rect) if rect.2 > 0 && rect.3 > 0 => rect,
            _ => return Err(Error::desktop(WINDOW_BOUNDS_UNAVAILABLE_COORD)),
        };
        let dpi = dpi::window_dpi(hwnd);
        let (lw, lh) = dpi::scaled_size(w, h, dpi);
        celestea_desktop_helper::capture::CaptureFrame {
            jpeg_bytes: Vec::new(),
            origin_x: ox,
            origin_y: oy,
            phys_w: w,
            phys_h: h,
            logical_w: lw,
            logical_h: lh,
            dpi,
        }
    };
    let origin = (frame.origin_x as f64, frame.origin_y as f64);
    let scale = dpi::dpi_scale(frame.dpi);
    let mut accessibility = Value::Null;
    let mut nodes = Vec::new();
    let mut full_tree = String::new();
    if include_text {
        let dumped = uia::global()
            .dump(window.id as isize, &window.title, origin, scale)
            .map_err(Error::desktop)?;
        full_tree = uia::format_accessibility(&dumped, &window.title, &window.app);
        nodes = dumped.nodes.clone();
        // TC-03/AX-04: the official `accessibility.tree` always carries the FULL
        // formatted tree, and `WindowState.d.ts` has no `diff` field. DSH used to
        // substitute an accessibility diff for the tree and emit a non-official `diff`
        // boolean, which made the field mean something other than the official schema.
        //
        // AX-05/AX-07: `uia::AccessibilityDump::to_json` applies the official
        // serialisation rules (absent optional fields are omitted, and the official
        // `meta` keys appear only when the tree was actually truncated).
        let _ = disable_diffing;
        accessibility = dumped.to_json(&full_tree);
    }
    let mut screenshots = Vec::new();
    let mut st = state.lock().map_err(|_| Error::other("state lock"))?;
    st.remember_observed(window.clone(), hwnd);
    st.last_nodes = nodes;
    // Remember the FULL tree (never the diff) so the next observation can diff
    // against it, and remember whether this observation carried text at all.
    if include_text {
        st.last_tree_text = Some(full_tree);
        st.last_observation_full_tree = true;
    } else {
        st.last_observation_full_tree = false;
    }
    let shot_id = st.remember_capture(
        frame.origin_x,
        frame.origin_y,
        frame.logical_w,
        frame.logical_h,
        frame.dpi,
    );
    if include_shot {
        let mut record = space_identity(hwnd, "window", &shot_id, &window.app);
        record["id"] = json!(shot_id);
        record["zIndex"] = json!(0);
        record["url"] = json!(frame.data_url());
        record["originX"] = json!(frame.origin_x);
        record["originY"] = json!(frame.origin_y);
        record["width"] = json!(frame.logical_w);
        record["height"] = json!(frame.logical_h);
        record["nativeWidth"] = json!(frame.phys_w);
        record["nativeHeight"] = json!(frame.phys_h);
        record["space"] = json!("window");
        record["displayName"] = json!(if window.title.is_empty() { window.app.clone() } else { window.title.clone() });
        record["snapshot"] = json!(shot_id);
        screenshots.push(record);
        let overlay = overlay::hwnds();
        let extras = extra_space_hwnds(hwnd, &overlay);
        let n = extras.len();
        for (i, (extra_id, kind)) in extras.into_iter().enumerate() {
            if let Ok(extra) = capture::capture_hwnd_timeout(extra_id, extra_timeout_ms) {
                let eid = st.remember_extra_capture(
                    extra.origin_x,
                    extra.origin_y,
                    extra.logical_w,
                    extra.logical_h,
                    extra.dpi,
                );
                let extra_hwnd = hwnd_from_id(extra_id as u64);
                let mut record = space_identity(extra_hwnd, &kind, &eid, &window.app);
                record["id"] = json!(eid);
                record["zIndex"] = json!(n - i);
                record["url"] = json!(extra.data_url());
                record["originX"] = json!(extra.origin_x);
                record["originY"] = json!(extra.origin_y);
                record["width"] = json!(extra.logical_w);
                record["height"] = json!(extra.logical_h);
                record["nativeWidth"] = json!(extra.phys_w);
                record["nativeHeight"] = json!(extra.phys_h);
                record["space"] = json!(kind);
                record["snapshot"] = json!(eid);
                screenshots.push(record);
                st.remember_extra_space(extra.origin_x, extra.origin_y, extra.phys_w, extra.phys_h);
            }
        }
    }
    let spaces: Vec<Value> = screenshots.iter().map(|s| json!({
        "id": s.get("id"),
        "zIndex": s.get("zIndex"),
        "space": s.get("space"),
        "windowID": s.get("windowID"),
        "displayName": s.get("displayName"),
        "processKey": s.get("processKey"),
        "app": s.get("app"),
        "snapshot": s.get("snapshot"),
        "originX": s.get("originX"),
        "originY": s.get("originY"),
        "width": s.get("width"),
        "height": s.get("height"),
        "nativeWidth": s.get("nativeWidth"),
        "nativeHeight": s.get("nativeHeight"),
    })).collect();
    // AX-15/TC-09: the official top level is exactly
    // {accessibility,cacheDiagnostics,screenshots,window} and every Screenshot has
    // exactly {height,id,originX,originY,url,width,zIndex}. The DSH space identity
    // rows are kept for the diagnostic_state extension method, never in the
    // model-visible payload.
    st.last_spaces = spaces;
    let official_screenshots: Vec<Value> = screenshots.iter().map(official_screenshot).collect();
    let full_diagnostics = overlay_cache_diagnostics(uia::global().diagnostics(), Some(&st), Some(&window));
    let cache_diagnostics = official_cache_diagnostics(&full_diagnostics);
    Ok(json!({
        "window": window.to_json(),
        "screenshots": official_screenshots,
        "accessibility": accessibility,
        "cacheDiagnostics": cache_diagnostics,
    }))
}

/// AX-15/TC-09: the official Screenshot element keys (out/types/Screenshot.d.ts).
const OFFICIAL_SCREENSHOT_KEYS: [&str; 7] =
    ["height", "id", "originX", "originY", "url", "width", "zIndex"];

fn official_screenshot(record: &Value) -> Value {
    let mut out = Map::new();
    for key in OFFICIAL_SCREENSHOT_KEYS {
        if let Some(value) = record.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

/// AX-15: the official cacheDiagnostics payload is exactly three keys (M-C live
/// sample). The full diagnostic payload stays on the diagnostic_state extension.
const OFFICIAL_CACHE_DIAGNOSTIC_KEYS: [&str; 3] =
    ["accessibilityRevision", "accessibilitySnapshotCount", "captureCachedSessionCount"];

fn official_cache_diagnostics(full: &Value) -> Value {
    let mut out = Map::new();
    for key in OFFICIAL_CACHE_DIAGNOSTIC_KEYS {
        let value = full.get(key).cloned().unwrap_or_else(|| json!(0));
        out.insert(key.into(), value);
    }
    Value::Object(out)
}

fn overlay_cache_diagnostics(mut body: Value, st: Option<&HelperState>, window: Option<&WindowRef>) -> Value {
    let app_id = window
        .map(|w| w.app.as_str())
        .or_else(|| st.and_then(|s| s.last_window.as_ref().map(|w| w.app.as_str())))
        .or_else(|| st.and_then(|s| s.last_window_identity.as_ref().map(|i| i.app_id.as_str())))
        .unwrap_or("");
    body["appId"] = json!(app_id);
    if let Some(window) = window {
        body["rootHwnd"] = json!(window.id);
    } else if let Some(w) = st.and_then(|s| s.last_window.as_ref()) {
        body["rootHwnd"] = json!(w.id);
    } else if body.get("rootHwnd").is_none() {
        body["rootHwnd"] = json!(0);
    }
    body["inputHwnd"] = json!(id_from_hwnd(foreground_hwnd()));
    body["captureCachedSessionCount"] = json!(capture::cached_session_count());
    let capture_reason = capture::last_capture_invalidation();
    if !capture_reason.is_empty() {
        body["lastCaptureInvalidationReason"] = json!(capture_reason);
    } else if body.get("lastCaptureInvalidationReason").is_none() {
        body["lastCaptureInvalidationReason"] = json!("");
    }
    if body.get("accessibilityRevision").is_none() {
        body["accessibilityRevision"] = json!(0);
    }
    body
}

fn diagnostic_state(state: &Mutex<HelperState>) -> Result<Value, Error> {
    let mut body = uia::global().diagnostics();
    // Foreground probe: raw GetForegroundWindow + GetWindowThreadProcessId so a
    // "foreground window did not report a process id" failure is diagnosable
    // without a debugger.
    {
        let fg = foreground_hwnd();
        let mut pid = 0u32;
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(fg, Some(&mut pid));
        }
        body["foreground"] = json!({
            "inputHwnd": id_from_hwnd(fg),
            "pid": pid,
            "exe": exe_name(pid).unwrap_or_default(),
        });
    }
    if let Ok(st) = state.lock() {
        body = overlay_cache_diagnostics(body, Some(&st), st.last_window.as_ref());
        body["ttlMs"] = json!(st.ttl_ms);
        body["backend"] = json!(st.backend);
        body["approvedApps"] = json!(st.approved.iter().cloned().collect::<Vec<_>>());
        body["overlay"] = json!(overlay::visible());
        body["lease"] = st.lease_snapshot();
        // AX-15: the DSH space identity rows removed from the model-visible
        // get_window_state payload stay reachable through this extension method.
        body["spaces"] = json!(st.last_spaces);
        body["screenshotSpaces"] = json!(st.last_spaces);
        body["rootScreenshotID"] = json!(st.last_shot_id);
        body["feature_status"] = notify::feature_status();
        body["notify"] = json!(true);
        body[LAST_WINDOW_IDENTITY] = st.identity_json();
        let hwnd = st.last_window.as_ref().map(|w| w.id).unwrap_or(0);
        let pid = if hwnd != 0 {
            window_pid(hwnd_from_id(hwnd))
        } else {
            0
        };
        if body.get("processId").and_then(Value::as_u64).unwrap_or(0) == 0 && pid != 0 {
            body["processId"] = json!(pid);
        }
        body["aumid"] = json!(policy::process_aumid(pid));
        if hwnd != 0 {
            if let Ok((x, y, width, height)) = window_rect(hwnd_from_id(hwnd)) {
                body["bounds"] = json!({ "x": x, "y": y, "width": width, "height": height });
            }
        }
        if body.get("processName").and_then(Value::as_str).unwrap_or("").is_empty() && pid != 0 {
            body["processName"] = json!(exe_name(pid).unwrap_or_default());
        }
        body["inputMonitor"] = interrupt::snapshot();
        body["appsFolderError"] = json!(app_catalog::last_appsfolder_error());
        // Catalog timing: the one Computer Use method that can run for seconds on a cold
        // machine, and the one the transport's 10 s budget turns into a helper restart.
        body["appCatalog"] = app_catalog::catalog_diagnostics();
        body["computerUseEnabled"] = json!(policy::computer_use_enabled());
        body["overlayState"] = overlay::diagnostics();
        body["captureState"] = capture::capture_diagnostics();
    } else {
        body = overlay_cache_diagnostics(body, None, None);
        body["appCatalog"] = app_catalog::catalog_diagnostics();
        body["aumid"] = json!("");
        body["inputMonitor"] = interrupt::snapshot();
        body["overlayState"] = overlay::diagnostics();
        body["captureState"] = capture::capture_diagnostics();
    }
    Ok(body)
}

fn batch_actions(state: &Mutex<HelperState>, params: &Map<String, Value>) -> Result<Value, Error> {
    let Some(Value::Array(actions)) = params.get("actions") else {
        return Err(Error::type_err("actions array required"));
    };
    let mut results = Vec::new();
    for action in actions {
        let name = action.get("name").and_then(Value::as_str).unwrap_or("");
        let arguments = match action.get("arguments") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        match dispatch(state, name, &arguments) {
            Ok(v) => results.push(json!({"ok": true, "name": name, "value": v})),
            Err(e) => results.push(json!({"ok": false, "name": name, "error": e.message})),
        }
    }
    Ok(json!({"results": results}))
}

fn set_value(state: &Mutex<HelperState>, params: &Map<String, Value>) -> Result<Value, Error> {
    let window = resolve_window(state, params)?;
    prepare_input(state, &window, WindowUse::Captured)?;
    let index = json_i64(params, "element_index")?.ok_or_else(|| Error::type_err("element_index is required"))? as i32;
    // Official `set_value` accepts an empty string (TC-11); `app`/`key` keep the
    // non-empty requirement.
    let value = require_text_allow_empty(params, "value")?;
    match uia::global().set_value(window.id as isize, index, &value) {
        Ok(()) => Ok(json!({})),
        Err(e) if e.contains("not settable") => Err(Error::type_err(e)),
        Err(e) if e.contains("no longer matches") || e.contains("no longer belongs") => Err(Error::desktop(e)),
        Err(_) => {
            let (px, py) = {
                let st = state.lock().map_err(|_| Error::other("state lock"))?;
                let node = st
                    .last_nodes
                    .iter()
                    .find(|n| n.index == index)
                    .ok_or_else(|| Error::key(format!("element {index} has no cached bounds")))?;
                let vp = st.last_viewport.clone().ok_or_else(|| Error::desktop(COORDINATE_GEOMETRY_UNAVAILABLE))?;
                let (lx, ly) = node.bounds.center();
                vp.to_physical(lx, ly)
            };
            require_coord_hit(state, &window, px, py)?;
            overlay::show();
            let _ = overlay::position_for("set_value", px as f32, py as f32, true);
            input::move_click(px, py, "left", 1)?;
            input::paste_text(&value)?;
            Ok(json!({}))
        }
    }
}

fn secondary(state: &Mutex<HelperState>, params: &Map<String, Value>) -> Result<Value, Error> {
    let window = resolve_window(state, params)?;
    prepare_input(state, &window, WindowUse::Captured)?;
    let index = json_i64(params, "element_index")?.ok_or_else(|| Error::type_err("element_index is required"))? as i32;
    let action = require_text(params, "action")?;
    uia::global()
        .secondary(window.id as isize, index, &action)
        .map_err(|e| {
            if e.contains("has no cached") || e.contains("unsupported secondary") {
                Error::key(e)
            } else {
                Error::desktop(e)
            }
        })?;
    Ok(json!({}))
}

fn click(state: &Mutex<HelperState>, params: &Map<String, Value>, action: &str) -> Result<Value, Error> {
    let window = resolve_window(state, params)?;
    let indexed = json_i64(params, "element_index")?.is_some();
    prepare_input(state, &window, if indexed { WindowUse::Captured } else { WindowUse::Coordinate })?;
    let (px, py) = click_point(state, params)?;
    require_coord_hit(state, &window, px, py)?;
    let button = json_str(params, "mouse_button").unwrap_or_else(|| "left".into());
    let count = json_i64(params, "click_count")?.unwrap_or(1);
    overlay::show();
    let _ = overlay::position_for(action, px as f32, py as f32, true);
    input::move_click(px, py, &button, count)?;
    Ok(json!({}))
}

fn scroll_pages(params: &Map<String, Value>) -> Result<f64, Error> {
    let Some(raw) = params.get("pages") else {
        return Ok(1.0);
    };
    if raw.is_null() {
        return Ok(1.0);
    }
    let number = match raw {
        Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| Error::type_err("pages must be a finite number > 0"))?,
        Value::String(s) => s
            .parse::<f64>()
            .map_err(|_| Error::type_err("pages must be a finite number > 0"))?,
        _ => return Err(Error::type_err("pages must be a finite number > 0")),
    };
    if !number.is_finite() || number <= 0.0 {
        return Err(Error::type_err("pages must be a finite number > 0"));
    }
    Ok(number)
}

/// TC-12: the official `ScrollParams` has `scrollX`/`scrollY` as non-Option fields, so
/// a missing delta is a wiring error, not "scroll by zero".
fn required_delta(params: &Map<String, Value>, key: &str) -> Result<f64, Error> {
    json_f64(params, key)?.ok_or_else(|| Error::type_err(format!("{key} is required")))
}

fn scroll(state: &Mutex<HelperState>, params: &Map<String, Value>, action: &str) -> Result<Value, Error> {
    let window = resolve_window(state, params)?;
    let indexed = json_i64(params, "element_index")?.is_some();
    prepare_input(state, &window, if indexed { WindowUse::Captured } else { WindowUse::Coordinate })?;
    if indexed {
        let index = json_i64(params, "element_index")?.unwrap() as i32;
        let direction = json_str(params, "direction").unwrap_or_else(|| "down".into());
        let pages = scroll_pages(params)?;
        if uia::global()
            .scroll(window.id as isize, index, &direction, pages as i32)
            .is_ok()
        {
            return Ok(json!({}));
        }
        let (px, py) = click_point(state, params)?;
        require_coord_hit(state, &window, px, py)?;
        overlay::show();
        let _ = overlay::position_for(action, px as f32, py as f32, false);
        let delta = 600.0 * pages;
        let (sx, sy) = match direction.as_str() {
            "up" => (0.0, -delta),
            "down" => (0.0, delta),
            "left" => (-delta, 0.0),
            _ => (delta, 0.0),
        };
        input::scroll_at(px, py, sx, sy)?;
        return Ok(json!({}));
    }
    let (px, py) = click_point(state, params)?;
    require_coord_hit(state, &window, px, py)?;
    let sx = required_delta(params, "scrollX")?;
    let sy = required_delta(params, "scrollY")?;
    overlay::show();
    let _ = overlay::position_for(action, px as f32, py as f32, false);
    input::scroll_at(px, py, sx, sy)?;
    Ok(json!({}))
}

fn drag(state: &Mutex<HelperState>, params: &Map<String, Value>) -> Result<Value, Error> {
    let window = resolve_window(state, params)?;
    prepare_input(state, &window, WindowUse::Coordinate)?;
    let from_x = json_f64(params, "from_x")?.ok_or_else(|| Error::type_err("drag requires from_x"))?;
    let from_y = json_f64(params, "from_y")?.ok_or_else(|| Error::type_err("drag requires from_y"))?;
    let to_x = json_f64(params, "to_x")?.ok_or_else(|| Error::type_err("drag requires to_x"))?;
    let to_y = json_f64(params, "to_y")?.ok_or_else(|| Error::type_err("drag requires to_y"))?;
    let st = state.lock().map_err(|_| Error::other("state lock"))?;
    let (x1, y1, _) = st.logical_click_to_physical(from_x, from_y, json_str(params, "screenshotId").as_deref())?;
    let (x2, y2, _) = st.logical_click_to_physical(to_x, to_y, json_str(params, "screenshotId").as_deref())?;
    drop(st);
    require_coord_hit(state, &window, x1, y1)?;
    require_coord_hit(state, &window, x2, y2)?;
    overlay::show();
    let _ = overlay::position_for("drag", x1 as f32, y1 as f32, false);
    input::drag_points(x1, y1, x2, y2)?;
    let _ = overlay::position_for("drag", x2 as f32, y2 as f32, true);
    Ok(json!({}))
}

fn require_coord_hit(state: &Mutex<HelperState>, window: &WindowRef, x: f64, y: f64) -> Result<(), Error> {
    let hwnd = hwnd_from_id(window.id);
    let (pid, extras) = {
        let st = state.lock().map_err(|_| Error::other("state lock"))?;
        let pid = st
            .last_window_identity
            .as_ref()
            .map(|id| id.process_id)
            .filter(|pid| *pid != 0)
            .unwrap_or_else(|| window_pid(hwnd));
        (pid, st.extra_rects.clone())
    };
    input::require_point_on_target(x, y, hwnd, &overlay::hwnds(), pid, &extras)
}

fn click_point(state: &Mutex<HelperState>, params: &Map<String, Value>) -> Result<(f64, f64), Error> {
    let st = state.lock().map_err(|_| Error::other("state lock"))?;
    if let Some(index) = json_i64(params, "element_index")? {
        let node = st
            .last_nodes
            .iter()
            .find(|n| n.index == index as i32)
            .ok_or_else(|| Error::key(format!("element {index} has no cached bounds")))?;
        if node.bounds.width <= 0.0 && node.bounds.height <= 0.0 {
            return Err(Error::key(format!("element {index} has no cached bounds")));
        }
        let vp = st.last_viewport.clone().ok_or_else(|| Error::desktop(COORDINATE_GEOMETRY_UNAVAILABLE))?;
        let (lx, ly) = node.bounds.center();
        return Ok(vp.to_physical(lx, ly));
    }
    let x = json_f64(params, "x")?.ok_or_else(|| Error::type_err("click requires x"))?;
    let y = json_f64(params, "y")?.ok_or_else(|| Error::type_err("click requires y"))?;
    let shot = json_str(params, "screenshotId");
    let (px, py, _) = st.logical_click_to_physical(x, y, shot.as_deref())?;
    Ok((px, py))
}

fn resolve_window(state: &Mutex<HelperState>, params: &Map<String, Value>) -> Result<WindowRef, Error> {
    // Official `window.app is required` (TC-05): the identity has to be present
    // before any id-only or remembered-window fallback is considered.
    require_window_spec_app(params)?;
    let spec = match params.get("window") {
        Some(Value::Object(map)) => map,
        _ => params,
    };
    let id = spec
        .get("id")
        .and_then(protocol::json_u64)
        .or_else(|| params.get("id").and_then(protocol::json_u64))
        .unwrap_or(0);
    if id != 0 {
        let app = json_str(spec, "app").or_else(|| json_str(params, "app"));
        return lookup_window(id, app.as_deref());
    }
    if let Some(app) = json_str(spec, "app") {
        let windows = enum_windows()?;
        // `app` is now the official identity form (`process:<full path>`, `path:...`, a
        // bare exe name, ...), so comparing it with `eq_ignore_ascii_case` never matched.
        // `app_identity_matches` accepts every official form plus the bare name.
        if let Some(found) = windows.iter().find(|w| {
            app_identity_matches(&w.app, &app)
                || w.title.to_lowercase().contains(&app.to_lowercase())
        }) {
            return Ok(found.clone());
        }
    }
    if let Ok(st) = state.lock() {
        if let Some(window) = st.last_window.clone() {
            return Ok(window);
        }
    }
    enum_windows()?
        .into_iter()
        .next()
        .ok_or_else(|| Error::desktop("no targetable windows"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // AX-15: the live M-C sample shows the official cacheDiagnostics object is exactly
    // {accessibilityRevision,accessibilitySnapshotCount,captureCachedSessionCount}.
    // Before this fix get_window_state returned the whole uia::diagnostics() payload
    // (16 keys), so this assertion is red on the pre-fix behaviour.
    #[test]
    fn official_cache_diagnostics_keeps_exactly_the_official_three_keys() {
        let full = json!({
            "appId": "mspaint.exe",
            "processId": 42,
            "rootHwnd": 7,
            "inputHwnd": 7,
            "processName": "mspaint.exe",
            "bounds": {"x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0},
            "snapshotRevision": 3,
            "accessibilityRevision": 5,
            "accessibilitySnapshotCount": 6,
            "captureCachedSessionCount": 0,
            "lastCaptureInvalidationReason": "",
            "cachedElements": 12,
            "eventMonitor": true,
            "windowOpenedReady": true,
            "windowOpenedError": "",
            "elementIdSpace": 1,
            "invalidateGeneration": 9,
        });
        let projected = official_cache_diagnostics(&full);
        let mut keys: Vec<&str> = projected.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, OFFICIAL_CACHE_DIAGNOSTIC_KEYS.to_vec());
        assert_eq!(projected["accessibilityRevision"], 5);
        assert_eq!(projected["accessibilitySnapshotCount"], 6);
        assert_eq!(projected["captureCachedSessionCount"], 0);
    }

    #[test]
    fn official_cache_diagnostics_defaults_missing_counts_to_zero() {
        let projected = official_cache_diagnostics(&json!({"accessibilityRevision": 2}));
        assert_eq!(projected["accessibilityRevision"], 2);
        assert_eq!(projected["accessibilitySnapshotCount"], 0);
        assert_eq!(projected["captureCachedSessionCount"], 0);
    }

    // AX-15/TC-09: a Screenshot carries exactly the seven official keys; the DSH
    // identity extras (space/windowID/processKey/nativeWidth/...) must be dropped
    // from the model-visible payload, not just renamed.
    #[test]
    fn official_screenshot_keeps_exactly_the_official_seven_keys() {
        let record = json!({
            "id": "screenshot-0",
            "zIndex": 0,
            "url": "data:image/jpeg;base64,AAAA",
            "originX": 1,
            "originY": 2,
            "width": 640,
            "height": 480,
            "nativeWidth": 1280,
            "nativeHeight": 960,
            "space": "window",
            "windowID": 7,
            "displayName": "Paint",
            "processKey": "exe:mspaint.exe:42",
            "app": "mspaint.exe",
            "snapshot": "screenshot-0",
        });
        let projected = official_screenshot(&record);
        let mut keys: Vec<&str> = projected.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = OFFICIAL_SCREENSHOT_KEYS.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(projected["nativeWidth"], Value::Null);
        assert_eq!(projected["width"], 640);
    }

    // TC-12: the official ScrollParams marks scrollX/scrollY required.
    #[test]
    fn scroll_deltas_are_required() {
        let empty = Map::new();
        assert_eq!(
            required_delta(&empty, "scrollX").unwrap_err().message,
            "scrollX is required"
        );
        assert_eq!(
            required_delta(&empty, "scrollY").unwrap_err().message,
            "scrollY is required"
        );
        let params = json!({"scrollX": 0, "scrollY": -120});
        let map = params.as_object().unwrap();
        assert_eq!(required_delta(map, "scrollX").unwrap(), 0.0);
        assert_eq!(required_delta(map, "scrollY").unwrap(), -120.0);
    }

    // 握手信封（规划 §5）：字段名与类型被 sidecar 的懒启动路径直接依赖，改这里等于改协议。
    #[test]
    fn handshake_reports_version_platform_and_real_features() {
        let value = handshake();
        assert_eq!(value["platform"], "win32");
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        let listed: Vec<&str> = value["features"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        for expected in ["uia", "input-sendinput", "enum-windows", "app-catalog"] {
            assert!(listed.contains(&expected), "features missing {}", expected);
        }
        assert!(!listed.contains(&"overlay"), "overlay is out of scope, must not be advertised");
        assert!(!listed.contains(&"audio"), "audio is out of scope, must not be advertised");
        assert_eq!(listed.contains(&"wgc"), cfg!(feature = "wgc"));
    }
}

