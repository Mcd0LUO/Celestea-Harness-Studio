//! In-process IUIAutomation — official `src/accessibility.rs` + `accessibility/monitor.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use windows::core::{Interface, Ref, BSTR, Result as WinResult};
use windows_core::implement;
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, RECT, RPC_E_CHANGED_MODE,
};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    SAFEARRAY,
};
use windows::Win32::System::Ole::{
    SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
    SafeArrayUnaccessData,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    AutomationElementMode_Full, CUIAutomation, ExpandCollapseState, ExpandCollapseState_Collapsed,
    ExpandCollapseState_Expanded, ExpandCollapseState_PartiallyExpanded, IUIAutomation,
    IUIAutomationCacheRequest, IUIAutomationElement, IUIAutomationEventHandler,
    IUIAutomationEventHandler_Impl, IUIAutomationExpandCollapsePattern,
    IUIAutomationFocusChangedEventHandler, IUIAutomationFocusChangedEventHandler_Impl,
    IUIAutomationInvokePattern, IUIAutomationRangeValuePattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationStructureChangedEventHandler,
    IUIAutomationStructureChangedEventHandler_Impl, IUIAutomationTextPattern,
    IUIAutomationTogglePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
    ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
    SetWinEventHook, StructureChangeType, ToggleState_Indeterminate, ToggleState_Off,
    ToggleState_On, TreeScope_Element, TreeScope_Subtree, UIA_EVENT_ID, HWINEVENTHOOK,
    UIA_MenuClosedEventId, UIA_MenuOpenedEventId, UIA_Text_TextChangedEventId,
    UIA_Text_TextSelectionChangedEventId, UIA_Window_WindowClosedEventId,
    UIA_Window_WindowOpenedEventId,
    UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId, UIA_ClassNamePropertyId,
    UIA_ControlTypePropertyId, UIA_ExpandCollapsePatternId, UIA_HasKeyboardFocusPropertyId,
    UIA_HelpTextPropertyId, UIA_InvokePatternId, UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId,
    UIA_LegacyIAccessiblePatternId, UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId,
    UIA_NativeWindowHandlePropertyId, UIA_PATTERN_ID, UIA_ProcessIdPropertyId,
    UIA_RangeValuePatternId, UIA_RuntimeIdPropertyId, UIA_ScrollItemPatternId, UIA_ScrollPatternId,
    UIA_SelectionItemPatternId, UIA_SelectionPatternId, UIA_TextPatternId, UIA_TogglePatternId,
    UIA_ValuePatternId, UIA_WindowPatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetAncestor, GetForegroundWindow, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsChild, IsWindowVisible, PeekMessageW,
    TranslateMessage, EVENT_OBJECT_FOCUS, EVENT_SYSTEM_FOREGROUND, GA_ROOT, MSG, PM_REMOVE,
    WINEVENT_OUTOFCONTEXT,
};

pub const ID_SPACE_EXHAUSTED: &str = "accessibility element ID space exhausted";
pub const WINDOW_OPENED_NOT_READY: &str = "accessibility window-opened handler did not become ready";
pub const WINDOW_OPENED_LOCK: &str = "accessibility window-opened lock poisoned";
pub const WINDOW_OPENED_READY_LOCK: &str = "accessibility window-opened readiness lock poisoned";
const ELEMENT_ID_MAX: u32 = i32::MAX as u32;
const WINDOW_OPENED_READY_WAIT: Duration = Duration::from_secs(2);

pub const CREATE_UIA: &str = "create UIAutomation";
pub const CREATE_UIA_CACHE: &str = "create UIA cache request";
pub const CREATE_UIA_EVENT_CACHE: &str = "create UIA event cache request";
pub const INIT_COM_UIA: &str = "initialize COM for UI Automation";
pub const MONITOR_DID_NOT_START: &str = "accessibility monitor did not start";
pub const GET_UIA_ROOT: &str = "get UIA root element";
pub const GET_APP_UIA: &str = "get app UIA element";
pub const NO_VISIBLE_TOP_LEVEL: &str = "no visible top-level windows found for ";
pub const FOCUS_BEFORE_SET_VALUE: &str = "focus element before setting value";
pub const REFRESH_TARGET_WINDOW: &str = "refresh UIA element target window";
pub const REFRESH_TARGET_SNAPSHOT: &str = "refresh UIA element target snapshot";
pub const TARGETED_REFRESH_FAILED: &str = "computer-use accessibility targeted refresh failed: ";
// AX-12: the official fragments carry literal punctuation between the element index and
// the sentence -- `element {n}(`, `element {n}(`, `element {n}/` (S:18336/18338/18340).
pub const RUNTIME_ID_MISMATCH: &str = "( no longer matches the cached runtime ID";
pub const PROCESS_MISMATCH: &str = "/ no longer belongs to the cached target process";
pub const CACHED_TARGET_MISMATCH: &str = "( no longer matches the cached target in";
pub const NO_CACHED_BOUNDS: &str = "has no cached bounds";
pub const NO_CACHED_APP_STATE: &str = "no cached app state is available for ";
pub const NO_CACHED_SECONDARY: &str = "has no cached secondary actions for";
pub const NOT_SETTABLE: &str = "Cannot set a value for an element that is not settable";
pub const SCROLL_GONE: &str = "element no longer exposes ScrollPattern";
pub const EXPAND_GONE: &str = "element no longer exposes ExpandCollapsePattern";
pub const SECONDARY_EXPECTED: &str = "unsupported secondary action: {action}; expected Raise, Scroll Up, Scroll Down, Scroll Left, Scroll Right, Expand, or Collapse";
pub const INTEGRITY_MESSAGE: &str = "Accessibility is limited because the target window has higher Windows integrity than the Computer Use helper.";
pub const STATE_FLAG_ERROR: &str = "get_window_state must request include_text, include_screenshot, or both";

pub const SECONDARY_ACTIONS: &[&str] = &[
    "Raise",
    "Scroll Up",
    "Scroll Down",
    "Scroll Left",
    "Scroll Right",
    "Expand",
    "Collapse",
];

const SKIP_TITLES: &[&str] = &[
    "Backstop Window",
    "Default IME",
    "Input Occlusion Window",
    "MSCTFIME UI",
    "Program Manager",
    "Taskbar",
];

// DSH's rich profile keeps a belt around the walk, but the belt has to sit *above* every tree
// the official actually produces, otherwise the model sees less than the official's model
// would: the official's Word tree is 414 elements, Explorer 205 and VS Code 186, and DSH used
// to stop at 250 with `(truncated: 250, omitted 2 children)` on the root (measured).
// `DSH_CU_AX_MAX_NODES` / `_CHILD_LIMIT` / `_DOCUMENT_CHILD_LIMIT` / `_MAX_DEPTH` still
// override all four, and the truncation marker still reports honestly if the belt is hit.
const UIA_MAX_NODES: usize = 1_000;
const DOCUMENT_FIND_MAX: usize = 400;
const MAX_DEPTH: usize = 32;
const CHILD_LIMIT: usize = 200;
/// AX-23: the official walk is not bounded by DSH's 250-node belt. Its Word tree is 414
/// lines with no `(truncated: ` marker and no `accessibility.meta`, while DSH's `official`
/// profile stopped at 253 lines and blamed `(truncated: 48, omitted 2 children)` on the
/// root. The official's own budget is unmeasured (no sample ever truncated), so `official`
/// mode only keeps a bound that stops a pathological provider from running away.
const OFFICIAL_MAX_NODES: usize = 4_000;
const OFFICIAL_CHILD_LIMIT: usize = 1_000;
const OFFICIAL_MAX_DEPTH: usize = 48;
const TRUNCATED_PREFIX: &str = "(truncated: ";
const FOCUSED_PREFIX: &str = "The focused UI element is";
const SELECTED_PREFIX: &str = "Selected text:";
const DOCUMENT_PREFIX: &str = "Document text:";
const SELECTED_LIST_PREFIX: &str = "Selected:";
const SELECTED_NOTE: &str = "Note: Pay special attention to the content selected by the user. If the user asks a question or refers to the content they are looking at on-screen, they might be referring to the selected content (but they might be referring to something else that's visible, too).";

const DUMP_CACHE_PROPERTIES: &[windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_RuntimeIdPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_ProcessIdPropertyId,
    UIA_ControlTypePropertyId,
    UIA_LocalizedControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_AutomationIdPropertyId,
    UIA_HelpTextPropertyId,
    UIA_NativeWindowHandlePropertyId,
    UIA_ClassNamePropertyId,
    UIA_IsOffscreenPropertyId,
];

const DUMP_CACHE_PATTERNS: &[UIA_PATTERN_ID] = &[
    UIA_SelectionPatternId,
    UIA_ValuePatternId,
    UIA_RangeValuePatternId,
    UIA_ScrollPatternId,
    UIA_ExpandCollapsePatternId,
    UIA_WindowPatternId,
    UIA_SelectionItemPatternId,
    UIA_TextPatternId,
    UIA_TogglePatternId,
    UIA_InvokePatternId,
    UIA_ScrollItemPatternId,
    UIA_LegacyIAccessiblePatternId,
];

const EVENT_CACHE_PROPERTIES: &[windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_NativeWindowHandlePropertyId,
    UIA_ProcessIdPropertyId,
];

const AUTOMATION_EVENTS: &[UIA_EVENT_ID] = &[
    UIA_Window_WindowOpenedEventId,
    UIA_MenuOpenedEventId,
    UIA_Text_TextSelectionChangedEventId,
    UIA_Text_TextChangedEventId,
    UIA_MenuClosedEventId,
    UIA_Window_WindowClosedEventId,
];

/// Official `src/accessibility.rs` snapshot cache request: 11 properties + 9 patterns,
/// recovered from the immediate arrays the official binary passes to `AddProperty` /
/// `AddPattern` (`G:18703-18719`).
///
/// The official never calls `put_TreeScope`, so its cache request keeps the default
/// `TreeScope_Element`. Observable consequences in
/// `parity/golden-ax/official.tree.txt`: only the root element carries cached patterns
/// (`Secondary Actions: Raise`), and the official's own `set_value` fails with
/// `所需属性不在 CacheRequest 中 (0x80070057)` (`official-diff.txt:1`).
pub const OFFICIAL_DUMP_PROPERTIES: &[windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_RuntimeIdPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_ProcessIdPropertyId,
    UIA_ControlTypePropertyId,
    UIA_LocalizedControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_AutomationIdPropertyId,
    UIA_HelpTextPropertyId,
    UIA_NativeWindowHandlePropertyId,
];

pub const OFFICIAL_DUMP_PATTERNS: &[UIA_PATTERN_ID] = &[
    UIA_SelectionPatternId,
    UIA_ValuePatternId,
    UIA_RangeValuePatternId,
    UIA_ScrollPatternId,
    UIA_ExpandCollapsePatternId,
    UIA_WindowPatternId,
    UIA_SelectionItemPatternId,
    UIA_TextPatternId,
    UIA_TogglePatternId,
];

/// Official automation-event registration (`G:18892/18895/18898`): exactly three.
/// The DSH `rich` profile additionally registers menu open/close and window-closed,
/// which made the cache be dropped on every menu interaction (AX-11).
pub const OFFICIAL_AUTOMATION_EVENTS: &[UIA_EVENT_ID] = &[
    UIA_Text_TextSelectionChangedEventId,
    UIA_Text_TextChangedEventId,
    UIA_Window_WindowOpenedEventId,
];

/// Everything the DSH `rich` profile adds on top of the official sets. Keeping the
/// differences as named constants is what the cache-set audit test pins.
pub const RICH_ONLY_PROPERTIES: &[windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] =
    &[UIA_ClassNamePropertyId, UIA_IsOffscreenPropertyId];
pub const RICH_ONLY_PATTERNS: &[UIA_PATTERN_ID] =
    &[UIA_InvokePatternId, UIA_ScrollItemPatternId, UIA_LegacyIAccessiblePatternId];
pub const RICH_ONLY_EVENTS: &[UIA_EVENT_ID] =
    &[UIA_MenuOpenedEventId, UIA_MenuClosedEventId, UIA_Window_WindowClosedEventId];

/// AX-03: which cache/annotation profile the engine uses.
///
/// * `Rich` (default) keeps the DSH superset: a `Subtree` cache, so every node carries
///   `Value:`, state parentheses and `Secondary Actions:`, and `set_value` works.
/// * `Official` reproduces the official request: the official 11/9 sets, no
///   `put_TreeScope` / `put_TreeFilter`, a plain (non-cached) descendant walk and
///   cached-only pattern reads. That is what the byte-for-byte golden comparison runs.
///
/// Selected by the `DSH_CU_AX_ANNOTATIONS` environment variable (`official` |
/// `rich`, default `rich`), so the model-facing parameter surface is unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnnotationsMode {
    Rich,
    Official,
}

impl AnnotationsMode {
    pub const ENV: &'static str = "DSH_CU_AX_ANNOTATIONS";

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "rich" => Some(Self::Rich),
            "official" => Some(Self::Official),
            _ => None,
        }
    }

    pub fn from_env() -> Self {
        std::env::var(Self::ENV)
            .ok()
            .and_then(|raw| Self::parse(&raw))
            .unwrap_or(Self::Rich)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Rich => "rich",
            Self::Official => "official",
        }
    }
}

static ANNOTATIONS_MODE: OnceLock<AnnotationsMode> = OnceLock::new();

pub fn set_annotations_mode(mode: AnnotationsMode) {
    let _ = ANNOTATIONS_MODE.set(mode);
}

pub fn annotations_mode() -> AnnotationsMode {
    *ANNOTATIONS_MODE.get_or_init(AnnotationsMode::from_env)
}

pub fn official_annotations() -> bool {
    annotations_mode() == AnnotationsMode::Official
}

pub fn dump_cache_properties_for(
    mode: AnnotationsMode,
) -> &'static [windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] {
    match mode {
        AnnotationsMode::Rich => DUMP_CACHE_PROPERTIES,
        AnnotationsMode::Official => OFFICIAL_DUMP_PROPERTIES,
    }
}

pub fn dump_cache_patterns_for(mode: AnnotationsMode) -> &'static [UIA_PATTERN_ID] {
    match mode {
        AnnotationsMode::Rich => DUMP_CACHE_PATTERNS,
        AnnotationsMode::Official => OFFICIAL_DUMP_PATTERNS,
    }
}

pub fn automation_events_for(mode: AnnotationsMode) -> &'static [UIA_EVENT_ID] {
    match mode {
        AnnotationsMode::Rich => AUTOMATION_EVENTS,
        AnnotationsMode::Official => OFFICIAL_AUTOMATION_EVENTS,
    }
}

pub fn dump_cache_properties() -> &'static [windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] {
    dump_cache_properties_for(annotations_mode())
}

pub fn dump_cache_patterns() -> &'static [UIA_PATTERN_ID] {
    dump_cache_patterns_for(annotations_mode())
}

pub fn automation_events() -> &'static [UIA_EVENT_ID] {
    automation_events_for(annotations_mode())
}

/// AX-10: the walk budgets are named (`cycle` / `child_limit` / `max_depth` in the
/// official string table, `S:18204 @0x132a83`) and can be overridden through the
/// environment so a gate or a large window can tune them without a rebuild. The
/// effective values are reported in `accessibility.meta` when the walk truncated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WalkLimits {
    pub max_nodes: usize,
    pub child_limit: usize,
    pub document_child_limit: usize,
    pub max_depth: usize,
}

impl Default for WalkLimits {
    fn default() -> Self {
        Self::for_mode(annotations_mode())
    }
}

impl WalkLimits {
    /// AX-23: the budgets are mode-dependent. `rich` keeps DSH's documented belt; `official`
    /// mirrors the official's effectively unbounded walk over the same cache request.
    pub fn for_mode(mode: AnnotationsMode) -> Self {
        match mode {
            AnnotationsMode::Rich => Self {
                max_nodes: UIA_MAX_NODES,
                child_limit: CHILD_LIMIT,
                document_child_limit: DOCUMENT_FIND_MAX,
                max_depth: MAX_DEPTH,
            },
            AnnotationsMode::Official => Self {
                max_nodes: OFFICIAL_MAX_NODES,
                child_limit: OFFICIAL_CHILD_LIMIT,
                document_child_limit: OFFICIAL_CHILD_LIMIT,
                max_depth: OFFICIAL_MAX_DEPTH,
            },
        }
    }

    pub const ENV_MAX_NODES: &'static str = "DSH_CU_AX_MAX_NODES";
    pub const ENV_CHILD_LIMIT: &'static str = "DSH_CU_AX_CHILD_LIMIT";
    pub const ENV_DOCUMENT_CHILD_LIMIT: &'static str = "DSH_CU_AX_DOCUMENT_CHILD_LIMIT";
    pub const ENV_MAX_DEPTH: &'static str = "DSH_CU_AX_MAX_DEPTH";

    fn env_usize(key: &str, fallback: usize) -> usize {
        std::env::var(key)
            .ok()
            .and_then(|raw| raw.trim().parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(fallback)
    }

    pub fn from_env() -> Self {
        let default = Self::default();
        Self {
            max_nodes: Self::env_usize(Self::ENV_MAX_NODES, default.max_nodes),
            child_limit: Self::env_usize(Self::ENV_CHILD_LIMIT, default.child_limit),
            document_child_limit: Self::env_usize(
                Self::ENV_DOCUMENT_CHILD_LIMIT,
                default.document_child_limit,
            ),
            max_depth: Self::env_usize(Self::ENV_MAX_DEPTH, default.max_depth),
        }
    }

    /// The document check by control type id (localisation-proof).
    pub fn child_cap_for_id(&self, control_type: i32) -> usize {
        if control_type == UIA_DOCUMENT_CONTROL_TYPE {
            self.document_child_limit
        } else {
            self.child_limit
        }
    }

    pub fn child_cap_for(&self, role: &str) -> usize {
        // 官方模式下角色名由提供方原样给出，所以 document 判定不能写成精确小写匹配（AX-21）。
        if role.eq_ignore_ascii_case("document") {
            self.document_child_limit
        } else {
            self.child_limit
        }
    }
}

static WALK_LIMITS: OnceLock<WalkLimits> = OnceLock::new();

pub fn set_walk_limits(limits: WalkLimits) {
    let _ = WALK_LIMITS.set(limits);
}

pub fn walk_limits() -> WalkLimits {
    *WALK_LIMITS.get_or_init(WalkLimits::from_env)
}

/// AX-09: the official truncation marker is a two-argument template appended to a
/// line (`(truncated: ` / `, omitted ` / ` children)`, `S:18346-18348`), not a
/// synthetic tree element. `limit` is the budget that was hit, `omitted` the number
/// of children that were not walked.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Truncation {
    pub reason: String,
    pub limit: usize,
    pub omitted: usize,
}

static INVALIDATE_GEN: AtomicU64 = AtomicU64::new(0);
static WINDOW_OPENED_READY: AtomicBool = AtomicBool::new(false);
static EVENT_MONITOR: AtomicBool = AtomicBool::new(false);
static INVALIDATE_REASON: Mutex<String> = Mutex::new(String::new());
static SETUP_STATE: Mutex<Option<Result<(), String>>> = Mutex::new(None);
static SETUP_CV: Condvar = Condvar::new();
static OPENED_HWNDS: Mutex<Vec<(bool, isize)>> = Mutex::new(Vec::new());
const OPENED_HWND_QUEUE_CAP: usize = 0x40;

fn invalidate(reason: &str) {
    INVALIDATE_GEN.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut slot) = INVALIDATE_REASON.lock() {
        *slot = reason.to_string();
    }
}

fn mark_monitor_setup(result: Result<(), String>) {
    match &result {
        Ok(()) => {
            WINDOW_OPENED_READY.store(true, Ordering::SeqCst);
            EVENT_MONITOR.store(true, Ordering::SeqCst);
        }
        Err(_) => {
            WINDOW_OPENED_READY.store(false, Ordering::SeqCst);
            EVENT_MONITOR.store(false, Ordering::SeqCst);
        }
    }
    let mut slot = SETUP_STATE
        .lock()
        .expect(WINDOW_OPENED_READY_LOCK);
    if slot.is_none() {
        *slot = Some(result);
    }
    SETUP_CV.notify_all();
}

fn setup_window_opened() -> (bool, String) {
    if WINDOW_OPENED_READY.load(Ordering::SeqCst) {
        return (true, String::new());
    }
    match SETUP_STATE.lock() {
        Ok(slot) => match slot.as_ref() {
            Some(Ok(())) => (true, String::new()),
            Some(Err(err)) => (false, err.clone()),
            None => (false, WINDOW_OPENED_NOT_READY.to_string()),
        },
        Err(_) => (false, WINDOW_OPENED_LOCK.to_string()),
    }
}

fn dump_setup_error(err: &str) -> bool {
    err == WINDOW_OPENED_NOT_READY || err == CREATE_UIA_EVENT_CACHE
}

fn enqueue_opened_window(ok: bool, hwnd: isize) {
    let Ok(mut q) = OPENED_HWNDS.lock() else {
        return;
    };
    if q.len() >= OPENED_HWND_QUEUE_CAP {
        q.remove(0);
    }
    q.push((ok, hwnd));
}

fn hwnd_in_dump(dump_hwnd: isize, opened: isize) -> bool {
    if dump_hwnd == 0 || opened == 0 {
        return false;
    }
    if dump_hwnd == opened {
        return true;
    }
    unsafe {
        let dump = as_hwnd(dump_hwnd);
        let opened_h = as_hwnd(opened);
        hwnd_val(GetAncestor(opened_h, GA_ROOT)) == dump_hwnd || IsChild(dump, opened_h).as_bool()
    }
}

fn take_targeted_hwnd(dump_hwnd: isize) -> bool {
    let Ok(mut q) = OPENED_HWNDS.lock() else {
        return false;
    };
    let mut targeted = false;
    q.retain(|(ok, hwnd)| {
        if *ok && hwnd_in_dump(dump_hwnd, *hwnd) {
            targeted = true;
            false
        } else {
            true
        }
    });
    targeted
}

fn native_hwnd_from_sender(sender: Ref<'_, IUIAutomationElement>) -> (bool, isize) {
    let Ok(el) = sender.ok() else {
        return (false, 0);
    };
    unsafe {
        let handle = el
            .CachedNativeWindowHandle()
            .ok()
            .or_else(|| el.CurrentNativeWindowHandle().ok());
        match handle {
            Some(h) => {
                let hwnd = hwnd_val(h);
                ((hwnd as i32) >= 0, hwnd)
            }
            None => (false, 0),
        }
    }
}

/// Official `accessibility.rs` waits on window-opened readiness before dump/mutations.
fn wait_window_opened_ready() -> UiaResult<()> {
    if WINDOW_OPENED_READY.load(Ordering::SeqCst) {
        return Ok(());
    }
    let guard = SETUP_STATE.lock().expect(WINDOW_OPENED_LOCK);
    let guard = if guard.is_none() {
        let (guard, timed) = SETUP_CV
            .wait_timeout(guard, WINDOW_OPENED_READY_WAIT)
            .expect(WINDOW_OPENED_READY_LOCK);
        if timed.timed_out() && guard.is_none() {
            return Err(WINDOW_OPENED_NOT_READY.to_string());
        }
        guard
    } else {
        guard
    };
    match guard.as_ref() {
        Some(Ok(())) => Ok(()),
        Some(Err(err)) if dump_setup_error(err) => Err(err.clone()),
        Some(Err(_)) => Ok(()),
        None => Err(WINDOW_OPENED_NOT_READY.to_string()),
    }
}

#[implement(IUIAutomationFocusChangedEventHandler)]
struct FocusSink;

impl IUIAutomationFocusChangedEventHandler_Impl for FocusSink_Impl {
    fn HandleFocusChangedEvent(&self, _sender: Ref<'_, IUIAutomationElement>) -> WinResult<()> {
        invalidate("focus");
        Ok(())
    }
}

#[implement(IUIAutomationStructureChangedEventHandler)]
struct StructureSink;

impl IUIAutomationStructureChangedEventHandler_Impl for StructureSink_Impl {
    fn HandleStructureChangedEvent(
        &self,
        _sender: Ref<'_, IUIAutomationElement>,
        _changetype: StructureChangeType,
        _runtimeid: *const SAFEARRAY,
    ) -> WinResult<()> {
        invalidate("structure");
        Ok(())
    }
}

#[implement(IUIAutomationEventHandler)]
struct EventSink;

impl IUIAutomationEventHandler_Impl for EventSink_Impl {
    fn HandleAutomationEvent(
        &self,
        sender: Ref<'_, IUIAutomationElement>,
        eventid: UIA_EVENT_ID,
    ) -> WinResult<()> {
        if eventid == UIA_Window_WindowOpenedEventId {
            let (ok, hwnd) = native_hwnd_from_sender(sender);
            enqueue_opened_window(ok, hwnd);
        }
        let reason = if eventid == UIA_Window_WindowOpenedEventId {
            "window-opened"
        } else if eventid == UIA_Window_WindowClosedEventId {
            "window-closed"
        } else if eventid == UIA_MenuOpenedEventId {
            "menu-opened"
        } else if eventid == UIA_MenuClosedEventId {
            "menu-closed"
        } else if eventid == UIA_Text_TextChangedEventId {
            "text"
        } else if eventid == UIA_Text_TextSelectionChangedEventId {
            "text-selection"
        } else {
            "event"
        };
        invalidate(reason);
        Ok(())
    }
}

unsafe extern "system" fn on_uia_winevent(
    _hook: HWINEVENTHOOK,
    event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _timestamp: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        invalidate("foreground");
    } else {
        invalidate("winevent");
    }
}

#[derive(Clone, Debug)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

#[derive(Clone, Debug)]
pub struct UiNode {
    pub index: i32,
    pub role: String,
    pub name: String,
    pub bounds: Bounds,
    pub value: String,
    pub depth: usize,
    pub actions: Vec<String>,
    pub automation_id: String,
    pub description: String,
    pub states: Vec<String>,
    pub focused: bool,
    pub runtime_id: Vec<i32>,
    /// AX-09: set on the element whose children were cut off. The marker is rendered as
    /// a suffix on this element's own line, exactly like `Secondary Actions:`; it is
    /// never a synthetic tree node (the model used to be able to "click" that node).
    pub truncated: Option<Truncation>,
}

#[derive(Clone, Debug, Default)]
pub struct AccessibilityDump {
    pub nodes: Vec<UiNode>,
    pub focused: String,
    pub selected_text: String,
    pub document_text: String,
    pub selected_elements: Vec<String>,
    pub process_id: i32,
    pub process_name: String,
    pub snapshot_revision: u64,
    pub truncation: String,
    /// AX-07/AX-10: effective walk budgets plus whatever the walk had to omit, ready to
    /// be serialized as the official `accessibility.meta` object.
    pub limits: WalkLimits,
    pub truncation_omitted: usize,
    pub truncation_limit: usize,
}

impl AccessibilityDump {
    /// AX-07: the official `AccessibilityState` has a `meta` field (`S:18075`); DSH
    /// omitted it entirely. It is only produced when the walk truncated, matching the
    /// official `skip_serializing_if` shape.
    pub fn truncation_meta(&self) -> Option<serde_json::Value> {
        if self.truncation.is_empty() && self.truncation_omitted == 0 {
            return None;
        }
        Some(serde_json::json!({
            "cycle": self.limits.max_nodes,
            "child_limit": self.limits.child_limit,
            "max_depth": self.limits.max_depth,
            "reason": self.truncation,
            "omitted_children": self.truncation_omitted,
        }))
    }

    /// AX-05: official serializes `AccessibilityState` with the optional fields absent
    /// when empty. This is the shape `get_window_state` must return; `tree` carries
    /// whatever the caller decided to report (the full tree, never a DSH diff unless the
    /// caller opts in).
    pub fn to_json(&self, tree: &str) -> serde_json::Value {
        let mut object = serde_json::Map::new();
        object.insert("tree".into(), serde_json::json!(tree));
        object.insert("focused_element".into(), serde_json::json!(self.focused));
        if !self.selected_text.is_empty() {
            object.insert("selected_text".into(), serde_json::json!(self.selected_text));
        }
        if !self.selected_elements.is_empty() {
            object.insert(
                "selected_elements".into(),
                serde_json::json!(self.selected_elements),
            );
        }
        if !self.document_text.is_empty() {
            object.insert("document_text".into(), serde_json::json!(self.document_text));
        }
        if let Some(meta) = self.truncation_meta() {
            object.insert("meta".into(), meta);
        }
        serde_json::Value::Object(object)
    }
}

pub type UiaResult<T> = Result<T, String>;

enum Job {
    Dump {
        hwnd: isize,
        title: String,
        origin: (f64, f64),
        scale: f64,
        resp: Sender<UiaResult<AccessibilityDump>>,
    },
    SetValue {
        hwnd: isize,
        index: i32,
        value: String,
        resp: Sender<UiaResult<()>>,
    },
    Secondary {
        hwnd: isize,
        index: i32,
        action: String,
        resp: Sender<UiaResult<()>>,
    },
    Scroll {
        hwnd: isize,
        index: i32,
        direction: String,
        pages: i32,
        resp: Sender<UiaResult<()>>,
    },
    CachedBounds {
        index: i32,
        resp: Sender<UiaResult<Bounds>>,
    },
    CachedActions {
        index: i32,
        resp: Sender<UiaResult<Vec<String>>>,
    },
    Diagnostics {
        resp: Sender<serde_json::Value>,
    },
}

pub struct UiaClient {
    tx: Sender<Job>,
}

static CLIENT: OnceLock<UiaClient> = OnceLock::new();

pub fn global() -> &'static UiaClient {
    CLIENT.get_or_init(UiaClient::new)
}

impl UiaClient {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("computer-use-uia-monitor".into())
            .spawn(move || monitor_loop(rx))
            .expect("spawn UIA monitor");
        Self { tx }
    }

    pub fn dump(&self, hwnd: isize, title: &str, origin: (f64, f64), scale: f64) -> UiaResult<AccessibilityDump> {
        if let Some(msg) = integrity_blocked(hwnd) {
            let bounds = window_logical_bounds(hwnd, origin, scale);
            let node = UiNode {
                index: 0,
                role: "window".into(),
                name: msg,
                bounds,
                value: String::new(),
                depth: 0,
                actions: Vec::new(),
                automation_id: String::new(),
                description: String::new(),
                states: Vec::new(),
                focused: true,
                runtime_id: Vec::new(),
                truncated: None,
            };
            let focused = focused_line(&node);
            return Ok(AccessibilityDump {
                focused,
                nodes: vec![node],
                ..AccessibilityDump::default()
            });
        }
        if hwnd == 0 {
            return Ok(fallback_dump(hwnd, title, origin, scale));
        }
        wait_window_opened_ready()?;
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .send(Job::Dump {
                hwnd,
                title: title.to_string(),
                origin,
                scale,
                resp: resp_tx,
            })
            .map_err(|_| MONITOR_DID_NOT_START.to_string())?;
        resp_rx.recv().map_err(|_| "wait for accessibility dump timeout".to_string())?
    }

    pub fn set_value(&self, hwnd: isize, index: i32, value: &str) -> UiaResult<()> {
        wait_window_opened_ready()?;
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .send(Job::SetValue {
                hwnd,
                index,
                value: value.to_string(),
                resp: resp_tx,
            })
            .map_err(|_| "send set value request to accessibility monitor".to_string())?;
        resp_rx.recv().map_err(|_| "wait for accessibility set value".to_string())?
    }

    pub fn secondary(&self, hwnd: isize, index: i32, action: &str) -> UiaResult<()> {
        wait_window_opened_ready()?;
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .send(Job::Secondary {
                hwnd,
                index,
                action: action.to_string(),
                resp: resp_tx,
            })
            .map_err(|_| "send secondary action request to accessibility monitor".to_string())?;
        resp_rx.recv().map_err(|_| "wait for accessibility secondary action".to_string())?
    }

    pub fn scroll(&self, hwnd: isize, index: i32, direction: &str, pages: i32) -> UiaResult<()> {
        wait_window_opened_ready()?;
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .send(Job::Scroll {
                hwnd,
                index,
                direction: direction.to_string(),
                pages,
                resp: resp_tx,
            })
            .map_err(|_| "send element target request to accessibility monitor".to_string())?;
        resp_rx.recv().map_err(|_| "wait for accessibility element target".to_string())?
    }

    pub fn cached_bounds(&self, index: i32) -> UiaResult<Bounds> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .send(Job::CachedBounds { index, resp: resp_tx })
            .map_err(|_| format!("element {index} {NO_CACHED_BOUNDS}"))?;
        resp_rx.recv().map_err(|_| format!("element {index} {NO_CACHED_BOUNDS}"))?
    }

    pub fn cached_actions(&self, index: i32) -> UiaResult<Vec<String>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        self.tx
            .send(Job::CachedActions { index, resp: resp_tx })
            .map_err(|_| format!("element {index} {NO_CACHED_SECONDARY}"))?;
        resp_rx.recv().map_err(|_| format!("element {index} {NO_CACHED_SECONDARY}"))?
    }

    pub fn diagnostics(&self) -> serde_json::Value {
        let (resp_tx, resp_rx) = mpsc::channel();
        if wait_window_opened_ready().is_err() || self.tx.send(Job::Diagnostics { resp: resp_tx }).is_err() {
            return diagnostics_payload(None);
        }
        resp_rx.recv().unwrap_or_else(|_| diagnostics_payload(None))
    }
}

fn diagnostics_payload(eng: Option<&Engine>) -> serde_json::Value {
    let input_hwnd = foreground_hwnds().into_iter().next().unwrap_or(0);
    match eng {
        Some(eng) => serde_json::json!({
            "appId": "",
            "processId": eng.pid,
            "rootHwnd": eng.hwnd,
            "inputHwnd": input_hwnd,
            "processName": eng.process_name,
            "bounds": {
                "x": eng.window_bounds.x,
                "y": eng.window_bounds.y,
                "width": eng.window_bounds.width,
                "height": eng.window_bounds.height,
            },
            "snapshotRevision": eng.snapshot_revision,
            "accessibilityRevision": eng.accessibility_revision,
            "accessibilitySnapshotCount": eng.snapshot_count,
            "lastCaptureInvalidationReason": eng.last_reason,
            "cachedElements": eng.elements.len(),
            "eventMonitor": eng.event_monitor && eng.window_opened_ready,
            "windowOpenedReady": eng.window_opened_ready,
            "windowOpenedError": if eng.window_opened_ready { String::new() } else { WINDOW_OPENED_NOT_READY.to_string() },
            "elementIdSpace": eng.element_id_space,
            "invalidateGeneration": eng.applied_gen,
        }),
        None => {
            let (ready, error) = setup_window_opened();
            serde_json::json!({
                "appId": "",
                "processId": 0,
                "rootHwnd": 0,
                "inputHwnd": input_hwnd,
                "processName": "",
                "bounds": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
                "snapshotRevision": 0,
                "accessibilityRevision": 0,
                "accessibilitySnapshotCount": 0,
                "lastCaptureInvalidationReason": if ready { String::new() } else { error.clone() },
                "cachedElements": 0,
                "eventMonitor": false,
                "windowOpenedReady": ready,
                "windowOpenedError": if ready { String::new() } else { error },
                "elementIdSpace": 0,
                "invalidateGeneration": 0,
            })
        }
    }
}

struct Engine {
    automation: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    dump_cache: IUIAutomationCacheRequest,
    elements: HashMap<i32, IUIAutomationElement>,
    runtime_ids: HashMap<i32, Vec<i32>>,
    actions: HashMap<i32, Vec<String>>,
    bounds: HashMap<i32, Bounds>,
    /// AX-16: the target window's logical bounds, reported as `bounds` in the diagnostic
    /// payload (the official's diagnostic field list has it; DSH did not).
    window_bounds: Bounds,
    hwnd: isize,
    pid: i32,
    process_name: String,
    snapshot_revision: u64,
    accessibility_revision: u64,
    snapshot_count: u64,
    applied_gen: u64,
    last_reason: String,
    window_opened_ready: bool,
    element_id_space: u32,
    event_monitor: bool,
    _focus: Option<IUIAutomationFocusChangedEventHandler>,
    _structure: Option<IUIAutomationStructureChangedEventHandler>,
    _events: Option<IUIAutomationEventHandler>,
    _event_cache: Option<IUIAutomationCacheRequest>,
    _winevent: HWINEVENTHOOK,
    _winevent_fg: HWINEVENTHOOK,
}

impl Engine {
    fn alloc_ids(&mut self, count: usize) -> UiaResult<()> {
        let count = count.max(1) as u32;
        if self.element_id_space >= ELEMENT_ID_MAX || count > ELEMENT_ID_MAX.saturating_sub(self.element_id_space) {
            return Err(ID_SPACE_EXHAUSTED.to_string());
        }
        self.element_id_space = self.element_id_space.saturating_add(count);
        Ok(())
    }

    fn apply_invalidate(&mut self) {
        let gen = INVALIDATE_GEN.load(Ordering::SeqCst);
        if gen == self.applied_gen {
            return;
        }
        self.applied_gen = gen;
        self.elements.clear();
        self.runtime_ids.clear();
        self.actions.clear();
        self.bounds.clear();
        self.accessibility_revision = gen;
        self.last_reason = INVALIDATE_REASON.lock().ok().map(|g| g.clone()).unwrap_or_default();
    }
}

fn monitor_loop(rx: Receiver<Job>) {
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        mark_monitor_setup(Err(INIT_COM_UIA.to_string()));
        for job in rx {
            fail_job(job, INIT_COM_UIA);
        }
        return;
    }
    let (mut engine, setup_err) = match unsafe { Engine::open() } {
        Ok(mut engine) => match unsafe { engine.install_handlers() } {
            Ok(()) => {
                mark_monitor_setup(Ok(()));
                (Some(engine), None)
            }
            Err(err) => {
                mark_monitor_setup(Err(err.clone()));
                (None, Some(err))
            }
        },
        Err(err) => {
            mark_monitor_setup(Err(err.clone()));
            (None, Some(err))
        }
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(40)) {
            Ok(job) => match job {
            Job::Dump {
                hwnd,
                title,
                origin,
                scale,
                resp,
            } => {
                let result = match engine.as_mut() {
                    Some(eng) => {
                        eng.apply_invalidate();
                        unsafe { eng.dump(hwnd, &title, origin, scale) }
                    }
                    None => Err(setup_err
                        .clone()
                        .unwrap_or_else(|| CREATE_UIA.to_string())),
                };
                let _ = resp.send(result.or_else(|err| {
                    if err == ID_SPACE_EXHAUSTED || dump_setup_error(&err) {
                        Err(err)
                    } else {
                        Ok(fallback_dump(hwnd, &title, origin, scale))
                    }
                }));
            }
            Job::SetValue {
                hwnd,
                index,
                value,
                resp,
            } => {
                let result = match engine.as_mut() {
                    Some(eng) => {
                        eng.apply_invalidate();
                        unsafe { eng.set_value(hwnd, index, &value) }
                    }
                    None => Err(setup_err
                        .clone()
                        .unwrap_or_else(|| CREATE_UIA.to_string())),
                };
                let _ = resp.send(result);
            }
            Job::Secondary {
                hwnd,
                index,
                action,
                resp,
            } => {
                let result = match engine.as_mut() {
                    Some(eng) => {
                        eng.apply_invalidate();
                        unsafe { eng.secondary(hwnd, index, &action) }
                    }
                    None => Err(setup_err
                        .clone()
                        .unwrap_or_else(|| CREATE_UIA.to_string())),
                };
                let _ = resp.send(result);
            }
            Job::Scroll {
                hwnd,
                index,
                direction,
                pages,
                resp,
            } => {
                let result = match engine.as_mut() {
                    Some(eng) => {
                        eng.apply_invalidate();
                        unsafe { eng.scroll(hwnd, index, &direction, pages) }
                    }
                    None => Err(setup_err
                        .clone()
                        .unwrap_or_else(|| CREATE_UIA.to_string())),
                };
                let _ = resp.send(result);
            }
            Job::CachedBounds { index, resp } => {
                let result = engine
                    .as_ref()
                    .and_then(|eng| eng.bounds.get(&index).cloned())
                    .ok_or_else(|| format!("element {index} {NO_CACHED_BOUNDS}"));
                let _ = resp.send(result);
            }
            Job::CachedActions { index, resp } => {
                let result = engine
                    .as_ref()
                    .and_then(|eng| eng.actions.get(&index).cloned())
                    .ok_or_else(|| format!("element {index} {NO_CACHED_SECONDARY}"));
                let _ = resp.send(result);
            }
            Job::Diagnostics { resp } => {
                if let Some(eng) = engine.as_mut() {
                    eng.apply_invalidate();
                }
                let _ = resp.send(diagnostics_payload(engine.as_ref()));
            }
            },
            Err(RecvTimeoutError::Timeout) => {
                let mut msg = MSG::default();
                unsafe {
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    unsafe { CoUninitialize() };
}

fn fail_job(job: Job, err: &str) {
    match job {
        Job::Dump { resp, hwnd, title, origin, scale, .. } => {
            if dump_setup_error(err) {
                let _ = resp.send(Err(err.to_string()));
            } else {
                let _ = resp.send(Ok(fallback_dump(hwnd, &title, origin, scale)));
            }
        }
        Job::SetValue { resp, .. } | Job::Secondary { resp, .. } | Job::Scroll { resp, .. } => {
            let _ = resp.send(Err(err.to_string()));
        }
        Job::CachedBounds { resp, index } => {
            let _ = resp.send(Err(format!("element {index} {NO_CACHED_BOUNDS}")));
        }
        Job::CachedActions { resp, index } => {
            let _ = resp.send(Err(format!("element {index} {NO_CACHED_SECONDARY}")));
        }
        Job::Diagnostics { resp } => {
            let mut payload = diagnostics_payload(None);
            payload["error"] = serde_json::json!(err);
            let _ = resp.send(payload);
        }
    }
}

impl Engine {
    unsafe fn open() -> UiaResult<Self> {
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| CREATE_UIA.to_string())?;
        let walker = automation
            .ControlViewWalker()
            .map_err(|_| GET_UIA_ROOT.to_string())?;
        let dump_cache = automation
            .CreateCacheRequest()
            .map_err(|_| CREATE_UIA_CACHE.to_string())?;
        for prop in dump_cache_properties() {
            dump_cache.AddProperty(*prop).map_err(|_| CREATE_UIA_CACHE.to_string())?;
        }
        for pattern in dump_cache_patterns() {
            dump_cache.AddPattern(*pattern).map_err(|_| CREATE_UIA_CACHE.to_string())?;
        }
        // AX-03: the official never calls put_TreeScope / put_TreeFilter, so its request
        // keeps the default TreeScope_Element. Only the "rich" profile widens to the
        // subtree, which is what gives every node its Value/states/actions.
        if !official_annotations() {
            dump_cache
                .SetTreeScope(TreeScope_Subtree)
                .map_err(|_| CREATE_UIA_CACHE.to_string())?;
            if let Ok(cond) = automation.ControlViewCondition() {
                let _ = dump_cache.SetTreeFilter(&cond);
            }
            dump_cache
                .SetAutomationElementMode(AutomationElementMode_Full)
                .map_err(|_| CREATE_UIA_CACHE.to_string())?;
        }
        let engine = Self {
            automation,
            walker,
            dump_cache,
            elements: HashMap::new(),
            runtime_ids: HashMap::new(),
            actions: HashMap::new(),
            bounds: HashMap::new(),
            window_bounds: Bounds { x: 0.0, y: 0.0, width: 0.0, height: 0.0 },
            hwnd: 0,
            pid: 0,
            process_name: String::new(),
            snapshot_revision: 0,
            accessibility_revision: 0,
            snapshot_count: 0,
            applied_gen: 0,
            last_reason: String::new(),
            window_opened_ready: false,
            element_id_space: 0,
            event_monitor: false,
            _focus: None,
            _structure: None,
            _events: None,
            _event_cache: None,
            _winevent: HWINEVENTHOOK::default(),
            _winevent_fg: HWINEVENTHOOK::default(),
        };
        Ok(engine)
    }

    unsafe fn install_handlers(&mut self) -> UiaResult<()> {
        let event_cache = self
            .automation
            .CreateCacheRequest()
            .map_err(|_| CREATE_UIA_EVENT_CACHE.to_string())?;
        for prop in EVENT_CACHE_PROPERTIES {
            event_cache
                .AddProperty(*prop)
                .map_err(|_| CREATE_UIA_EVENT_CACHE.to_string())?;
        }
        event_cache
            .SetTreeScope(TreeScope_Element)
            .map_err(|_| CREATE_UIA_EVENT_CACHE.to_string())?;
        if let Ok(cond) = self.automation.ControlViewCondition() {
            let _ = event_cache.SetTreeFilter(&cond);
        }
        event_cache
            .SetAutomationElementMode(AutomationElementMode_Full)
            .map_err(|_| CREATE_UIA_EVENT_CACHE.to_string())?;
        let desktop = self.automation.GetRootElement().ok();
        let focus: IUIAutomationFocusChangedEventHandler = FocusSink.into();
        if self
            .automation
            .AddFocusChangedEventHandler(&event_cache, &focus)
            .is_ok()
        {
            self._focus = Some(focus);
        }
        if let Some(desktop) = desktop.as_ref() {
            let structure: IUIAutomationStructureChangedEventHandler = StructureSink.into();
            if self
                .automation
                .AddStructureChangedEventHandler(desktop, TreeScope_Subtree, &event_cache, &structure)
                .is_ok()
            {
                self._structure = Some(structure);
            }
            let events: IUIAutomationEventHandler = EventSink.into();
            let mut opened = false;
            for event_id in automation_events() {
                // FUN_140016587 hardcodes TreeScope_Subtree (MOV R9D,0x7). Event-cache
                // TreeScope_Element is put_TreeScope on the cache request, not the handler.
                if self
                    .automation
                    .AddAutomationEventHandler(
                        *event_id,
                        desktop,
                        TreeScope_Subtree,
                        &event_cache,
                        &events,
                    )
                    .is_ok()
                    && *event_id == UIA_Window_WindowOpenedEventId
                {
                    opened = true;
                }
            }
            self._events = Some(events);
            self.window_opened_ready = opened;
        }
        if !self.window_opened_ready {
            let _ = self.automation.RemoveAllEventHandlers();
            self._focus = None;
            self._structure = None;
            self._events = None;
            self.last_reason = WINDOW_OPENED_NOT_READY.into();
            return Err(WINDOW_OPENED_NOT_READY.to_string());
        }
        self._winevent = SetWinEventHook(
            0x8004,
            EVENT_OBJECT_FOCUS,
            None,
            Some(on_uia_winevent),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        self._winevent_fg = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_uia_winevent),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        self._event_cache = Some(event_cache);
        self.event_monitor = true;
        Ok(())
    }

    unsafe fn dump(
        &mut self,
        hwnd: isize,
        title: &str,
        origin: (f64, f64),
        scale: f64,
    ) -> UiaResult<AccessibilityDump> {
        let targeted = take_targeted_hwnd(hwnd);
        let root = self
            .element_from_handle(hwnd)
            .ok_or_else(|| {
                if targeted {
                    format!("{TARGETED_REFRESH_FAILED}{REFRESH_TARGET_WINDOW}")
                } else if title.is_empty() {
                    GET_APP_UIA.to_string()
                } else {
                    format!("{NO_VISIBLE_TOP_LEVEL}{title}")
                }
            })?;
        let root = if targeted {
            match root.BuildUpdatedCache(&self.dump_cache) {
                Ok(updated) => updated,
                Err(_) => root,
            }
        } else {
            root
        };
        // Official mode: the root was just built with the cache request, and a plain
        // `NormalizeElement` would hand back an *uncached* element -- silently dropping
        // the root's patterns (the official prints `Secondary Actions: Raise` there).
        let root = self.normalize_root(root);
        let focused = self
            .automation
            .GetFocusedElementBuildCache(&self.dump_cache)
            .ok()
            .or_else(|| self.automation.GetFocusedElement().ok());
        let mut walk = WalkState {
            origin,
            scale,
            limits: walk_limits(),
            nodes: Vec::new(),
            elements: Vec::new(),
            focused_node: None,
            selected_text: String::new(),
            document_text: String::new(),
            selected_elements: Vec::new(),
            truncation: String::new(),
            truncation_limit: 0,
            truncation_omitted: 0,
            focused: focused.clone(),
        };
        self.visit(&root, 0, &mut HashSet::new(), &mut walk)?;
        self.alloc_ids(walk.nodes.len())?;
        self.elements.clear();
        self.runtime_ids.clear();
        self.actions.clear();
        self.bounds.clear();
        for (i, el) in walk.elements.into_iter().enumerate() {
            self.elements.insert(i as i32, el);
        }
        for node in &walk.nodes {
            self.runtime_ids.insert(node.index, node.runtime_id.clone());
            self.actions.insert(node.index, node.actions.clone());
            self.bounds.insert(node.index, node.bounds.clone());
        }
        self.hwnd = hwnd;
        self.window_bounds = window_logical_bounds(hwnd, origin, scale);
        self.pid = process_id(&root).unwrap_or(0);
        self.process_name = process_name(self.pid as u32);
        self.snapshot_revision += 1;
        self.snapshot_count += 1;
        if walk.nodes.is_empty() {
            if title.is_empty() {
                return Ok(fallback_dump(hwnd, title, origin, scale));
            }
            return Err(format!("{NO_VISIBLE_TOP_LEVEL}{title}"));
        }
        let focused_text = walk
            .focused_node
            .as_ref()
            .or(walk.nodes.first())
            .map(focused_line)
            .unwrap_or_default();
        Ok(AccessibilityDump {
            nodes: walk.nodes,
            focused: focused_text,
            selected_text: walk.selected_text,
            document_text: walk.document_text,
            selected_elements: walk.selected_elements,
            process_id: self.pid,
            process_name: self.process_name.clone(),
            snapshot_revision: self.snapshot_revision,
            truncation: walk.truncation,
            limits: walk.limits,
            truncation_omitted: walk.truncation_omitted,
            truncation_limit: walk.truncation_limit,
        })
    }

    unsafe fn element_from_handle(&self, hwnd: isize) -> Option<IUIAutomationElement> {
        let mut candidates = vec![hwnd];
        for extra in foreground_hwnds() {
            if extra != 0 && !candidates.contains(&extra) {
                candidates.push(extra);
            }
        }
        for handle in candidates {
            if handle == 0 {
                continue;
            }
            if let Ok(el) = self
                .automation
                .ElementFromHandleBuildCache(as_hwnd(handle), &self.dump_cache)
            {
                return Some(el);
            }
            if let Ok(el) = self.automation.ElementFromHandle(as_hwnd(handle)) {
                return Some(el);
            }
        }
        None
    }

    /// Root normalisation. The root only: descendants go through [`Self::normalize`].
    unsafe fn normalize_root(&self, el: IUIAutomationElement) -> IUIAutomationElement {
        if official_annotations() {
            return el;
        }
        self.normalize(el)
    }

    unsafe fn normalize(&self, el: IUIAutomationElement) -> IUIAutomationElement {
        if official_annotations() {
            // Official mode never cache-builds descendants; keeping their patterns out
            // of the cache request is the whole point of the official TreeScope_Element
            // mode, and it is why the official's `set_value` fails on a non-root element.
            return self.walker.NormalizeElement(&el).unwrap_or(el);
        }
        self.walker
            .NormalizeElementBuildCache(&el, &self.dump_cache)
            .or_else(|_| self.walker.NormalizeElement(&el))
            .unwrap_or(el)
    }

    unsafe fn first_child(&self, el: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        if official_annotations() {
            return self.walker.GetFirstChildElement(el).ok();
        }
        self.walker
            .GetFirstChildElementBuildCache(el, &self.dump_cache)
            .ok()
            .or_else(|| self.walker.GetFirstChildElement(el).ok())
    }

    unsafe fn next_sibling(&self, el: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        if official_annotations() {
            return self.walker.GetNextSiblingElement(el).ok();
        }
        self.walker
            .GetNextSiblingElementBuildCache(el, &self.dump_cache)
            .ok()
            .or_else(|| self.walker.GetNextSiblingElement(el).ok())
    }

    unsafe fn visit(
        &self,
        el: &IUIAutomationElement,
        depth: usize,
        path: &mut HashSet<Vec<i32>>,
        walk: &mut WalkState,
    ) -> UiaResult<Option<&'static str>> {
        let limits = walk.limits;
        if walk.nodes.len() >= limits.max_nodes {
            // AX-23: name the budget that actually bound the walk.
            note_truncation(walk, "max_nodes", limits.max_nodes, 0);
            return Ok(Some("limit"));
        }
        let name = element_name(el);
        let ctype = control_type_id(el);
        if depth > 0 && SKIP_TITLES.iter().any(|t| *t == name) {
            return Ok(None);
        }
        let rid = runtime_id(el);
        if !rid.is_empty() && path.contains(&rid) {
            note_truncation(walk, "cycle", limits.max_nodes, 0);
            return Ok(Some("cycle"));
        }
        if depth > limits.max_depth {
            note_truncation(walk, "max_depth", limits.max_depth, 0);
            return Ok(Some("max_depth"));
        }
        let mut node = element_node(el, walk.nodes.len() as i32, depth, walk.origin, walk.scale);
        let parent_index = node.index;
        let same_focus = walk
            .focused
            .as_ref()
            .and_then(|focus| self.automation.CompareElements(el, focus).ok())
            .map(|b| b.as_bool())
            .unwrap_or(false);
        if same_focus || node.focused {
            node.focused = true;
            walk.focused_node = Some(node.clone());
            if walk.selected_text.is_empty() {
                walk.selected_text = selection_text(el);
            }
            if walk.document_text.is_empty() {
                walk.document_text = document_text(el);
            }
        }
        if node.states.iter().any(|s| s == "selected") {
            // Same grammar as the tree lines (bare index, unquoted name).
            let name = if node.name.is_empty() {
                String::new()
            } else {
                format!(" {}", node.name)
            };
            walk.selected_elements
                .push(format!("{} {}{name}", node.index, node.role));
        }
        // AX-25: keyed by control type, because the localised role on a Chinese Word is
        // `文档` and the old string comparison therefore never fired there.
        if walk.document_text.is_empty() && ctype == UIA_DOCUMENT_CONTROL_TYPE {
            walk.document_text = document_text(el);
            if walk.document_text.is_empty() {
                walk.document_text = node.value.clone();
            }
        }
        node.runtime_id = rid.clone();
        walk.nodes.push(node);
        walk.elements.push(el.clone());
        if walk.nodes.len() >= limits.max_nodes {
            // AX-23: name the budget that actually bound the walk.
            note_truncation(walk, "max_nodes", limits.max_nodes, 0);
            return Ok(Some("limit"));
        }
        if !rid.is_empty() {
            path.insert(rid.clone());
        }
        let mut child = self.first_child(el);
        let mut skipped = 0usize;
        let mut seen_children = 0usize;
        let mut omitted_reason: Option<(&'static str, usize)> = None;
        let cap = limits.child_cap_for_id(ctype);
        while let Some(raw) = child.take() {
            let current = self.normalize(raw);
            seen_children += 1;
            let over_nodes = walk.nodes.len() >= limits.max_nodes;
            let over_cap = seen_children > cap;
            if over_nodes || over_cap {
                skipped += 1;
                // AX-23: blame the budget that actually bound the walk. DSH used to report
                // `child_limit` (48) for children the node budget had already ruled out,
                // which is how the official-mode Word root ended up reading
                // `(truncated: 48, omitted 2 children)`.
                let entry = if over_nodes {
                    ("max_nodes", limits.max_nodes)
                } else {
                    ("child_limit", cap)
                };
                if omitted_reason.is_none() {
                    omitted_reason = Some(entry);
                }
                child = self.next_sibling(&current);
                continue;
            }
            self.visit(&current, depth + 1, path, walk)?;
            child = self.next_sibling(&current);
        }
        if !rid.is_empty() {
            path.remove(&rid);
        }
        if skipped > 0 {
            let (reason, limit) = omitted_reason.unwrap_or(("child_limit", cap));
            note_truncation(walk, reason, limit, skipped);
            // AX-09: the official template is a suffix on the truncated element's own
            // line. Previously DSH pushed a synthetic `text` node, which the model could
            // select and "click" because it carried a real element index.
            if let Some(node) = walk.nodes.get_mut(parent_index as usize) {
                let entry = node.truncated.get_or_insert_with(Truncation::default);
                entry.reason = reason.to_string();
                entry.limit = limit;
                entry.omitted += skipped;
            }
        }
        Ok(None)
    }

    unsafe fn cached_element(&mut self, hwnd: isize, index: i32) -> UiaResult<IUIAutomationElement> {
        if let Some(cached) = self.elements.get(&index).cloned() {
            // Official mode keeps the element exactly as the walk produced it. The
            // official never re-caches a descendant, which is why its own `set_value`
            // fails there; re-caching here would silently restore DSH's superset power.
            let live = if official_annotations() {
                cached.clone()
            } else {
                cached
                    .BuildUpdatedCache(&self.dump_cache)
                    .unwrap_or_else(|_| cached.clone())
            };
            self.elements.insert(index, live.clone());
            let want = self.runtime_ids.get(&index).cloned().unwrap_or_default();
            let got = runtime_id(&live);
            if !want.is_empty() && !got.is_empty() && want != got {
                return Err(format!("element {index}{CACHED_TARGET_MISMATCH} {hwnd}"));
            }
            if let Some(pid) = process_id(&live) {
                if self.pid != 0 && pid != 0 && pid != self.pid {
                    return Err(format!("element {index}{PROCESS_MISMATCH}"));
                }
            }
            return Ok(live);
        }
        if !self.elements.is_empty() {
            return Err(format!("element {index}{RUNTIME_ID_MISMATCH}"));
        }
        // AX-13: the official answers an action against a never-observed app with this
        // sentence, not with a bounds complaint.
        Err(format!("{NO_CACHED_APP_STATE}{}", self.process_name))
    }

    unsafe fn set_value(&mut self, hwnd: isize, index: i32, value: &str) -> UiaResult<()> {
        let el = self.cached_element(hwnd, index)?;
        el.SetFocus().map_err(|_| FOCUS_BEFORE_SET_VALUE.to_string())?;
        if let Some(pat) = pattern::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId) {
            let readonly = pat
                .CachedIsReadOnly()
                .ok()
                .or_else(|| pat.CurrentIsReadOnly().ok())
                .map(|b| b.as_bool())
                .unwrap_or(false);
            if readonly {
                return Err(NOT_SETTABLE.to_string());
            }
            let bstr = BSTR::from(value);
            pat.SetValue(&bstr).map_err(|_| "set UIA value".to_string())?;
            return Ok(());
        }
        if let Some(rng) = pattern::<IUIAutomationRangeValuePattern>(&el, UIA_RangeValuePatternId) {
            let number: f64 = value
                .parse()
                .map_err(|_| format!("range value must be a number: {value}"))?;
            rng.SetValue(number)
                .map_err(|_| "set UIA range value".to_string())?;
            return Ok(());
        }
        Err(NOT_SETTABLE.to_string())
    }

    unsafe fn secondary(&mut self, hwnd: isize, index: i32, action: &str) -> UiaResult<()> {
        let el = self.cached_element(hwnd, index)?;
        let available = secondary_actions(&el);
        if let Some(cached) = self.actions.get(&index) {
            if cached.is_empty() {
                return Err(format!("element {index} {NO_CACHED_SECONDARY} {action}"));
            }
        }
        let key = action.trim().to_ascii_lowercase();
        let canonical = SECONDARY_ACTIONS
            .iter()
            .find(|name| name.eq_ignore_ascii_case(&key));
        if canonical.is_none() {
            return Err(SECONDARY_EXPECTED.replace("{action}", action));
        }
        if !available.iter().any(|item| item.eq_ignore_ascii_case(&key)) {
            let listed = if available.is_empty() {
                self.actions.get(&index).cloned().unwrap_or_default().join(", ")
            } else {
                available.join(", ")
            };
            return Err(format!(
                "secondary action '{action}' is not available for element {index}; available actions: {listed}"
            ));
        }
        match key.as_str() {
            "raise" => {
                let _ = el.SetFocus();
                if let Some(inv) = pattern::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId) {
                    let _ = inv.Invoke();
                }
                Ok(())
            }
            "scroll up" | "scroll down" | "scroll left" | "scroll right" => {
                let pat = pattern::<IUIAutomationScrollPattern>(&el, UIA_ScrollPatternId)
                    .ok_or_else(|| SCROLL_GONE.to_string())?;
                let (h, v) = match key.as_str() {
                    "scroll up" => (ScrollAmount_NoAmount, ScrollAmount_LargeDecrement),
                    "scroll down" => (ScrollAmount_NoAmount, ScrollAmount_LargeIncrement),
                    "scroll left" => (ScrollAmount_LargeDecrement, ScrollAmount_NoAmount),
                    _ => (ScrollAmount_LargeIncrement, ScrollAmount_NoAmount),
                };
                pat.Scroll(h, v)
                    .map_err(|_| "perform UIA secondary action".to_string())
            }
            "expand" | "collapse" => {
                let pat = pattern::<IUIAutomationExpandCollapsePattern>(&el, UIA_ExpandCollapsePatternId)
                    .ok_or_else(|| EXPAND_GONE.to_string())?;
                if key == "expand" {
                    pat.Expand()
                        .map_err(|_| "perform UIA secondary action".to_string())
                } else {
                    pat.Collapse()
                        .map_err(|_| "perform UIA secondary action".to_string())
                }
            }
            _ => Err(SECONDARY_EXPECTED.replace("{action}", action)),
        }
    }

    unsafe fn scroll(&mut self, hwnd: isize, index: i32, direction: &str, pages: i32) -> UiaResult<()> {
        let el = self.cached_element(hwnd, index)?;
        let pat = pattern::<IUIAutomationScrollPattern>(&el, UIA_ScrollPatternId)
            .ok_or_else(|| SCROLL_GONE.to_string())?;
        let (h, v) = match direction.trim().to_ascii_lowercase().as_str() {
            "up" => (ScrollAmount_NoAmount, ScrollAmount_LargeDecrement),
            "down" => (ScrollAmount_NoAmount, ScrollAmount_LargeIncrement),
            "left" => (ScrollAmount_LargeDecrement, ScrollAmount_NoAmount),
            "right" => (ScrollAmount_LargeIncrement, ScrollAmount_NoAmount),
            other => return Err(format!("unsupported scroll direction: {other}")),
        };
        for _ in 0..pages.max(1) {
            pat.Scroll(h, v).map_err(|_| SCROLL_GONE.to_string())?;
        }
        Ok(())
    }
}

struct WalkState {
    origin: (f64, f64),
    scale: f64,
    limits: WalkLimits,
    nodes: Vec<UiNode>,
    elements: Vec<IUIAutomationElement>,
    focused_node: Option<UiNode>,
    selected_text: String,
    document_text: String,
    selected_elements: Vec<String>,
    truncation: String,
    truncation_limit: usize,
    truncation_omitted: usize,
    focused: Option<IUIAutomationElement>,
}

/// AX-07/AX-10: record what the walk had to drop. The reason keeps the official
/// `cycle` / `child_limit` / `max_depth` spelling.
fn note_truncation(walk: &mut WalkState, reason: &str, limit: usize, omitted: usize) {
    if walk.truncation.is_empty() {
        walk.truncation = reason.to_string();
    }
    if walk.truncation_limit == 0 {
        walk.truncation_limit = limit;
    }
    walk.truncation_omitted += omitted;
}

fn as_hwnd(id: isize) -> HWND {
    HWND(id as *mut core::ffi::c_void)
}

fn hwnd_val(hwnd: HWND) -> isize {
    hwnd.0 as isize
}

/// Pattern lookup. The official reads patterns only from the cache request (that is why
/// its `set_value` fails with `所需属性不在 CacheRequest 中` on a non-root element);
/// the "rich" profile additionally falls back to a live lookup so the whole subtree keeps
/// its annotations.
fn pattern<T: Interface>(el: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Option<T> {
    unsafe {
        let cached = el.GetCachedPatternAs::<T>(id).ok();
        if official_annotations() {
            cached
        } else {
            cached.or_else(|| el.GetCurrentPatternAs::<T>(id).ok())
        }
    }
}

fn has_pattern(el: &IUIAutomationElement, id: UIA_PATTERN_ID) -> bool {
    unsafe {
        if official_annotations() {
            el.GetCachedPattern(id).is_ok()
        } else {
            el.GetCachedPattern(id).is_ok() || el.GetCurrentPattern(id).is_ok()
        }
    }
}

/// AX-20 / AX-02: the two availability probes the official performs *live*, even on
/// elements below the root. Everything else about a descendant travels through the cache
/// request that the official never builds below the root, which is exactly why its trees
/// show `selectable` and `Raise` on non-root elements but no `selected`, no `Value:`,
/// no `settable`, no collapse state and no scroll actions.
fn pattern_available_live(el: &IUIAutomationElement, id: UIA_PATTERN_ID) -> bool {
    unsafe { el.GetCachedPattern(id).is_ok() || el.GetCurrentPattern(id).is_ok() }
}

fn bstr_to_string(value: BSTR) -> String {
    value.to_string()
}

/// AX-22: the official's tree names are whitespace-normalised. Word's root UIA name is
/// `...docx~~-~~最后由用户保存~~-~~兼容性模式~-~Word` (double spaces, raw probe) while the
/// official tree prints single spaces, and the same holds for the title-bar and menu
/// elements. `split_whitespace().join(" ")` reproduces every observed official line.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn element_name(el: &IUIAutomationElement) -> String {
    let name = unsafe {
        el.CachedName()
            .ok()
            .or_else(|| el.CurrentName().ok())
            .map(bstr_to_string)
            .unwrap_or_default()
    };
    if official_annotations() {
        collapse_whitespace(&name)
    } else {
        name
    }
}

fn role_of(el: &IUIAutomationElement) -> String {
    unsafe {
        if let Ok(localized) = el
            .CachedLocalizedControlType()
            .or_else(|_| el.CurrentLocalizedControlType())
        {
            // AX-21：官方路径会把本地化控件类型原样输出，它会保留
            // capitalised `SplitButton` (official Word tree) and even a trailing space
            // (`切换关闭 ` on Word's AutoSave switch; raw probe lct=[切换关闭~]). The rich
            // profile keeps DSH's historical lower-cased, trimmed spelling.
            let raw = bstr_to_string(localized);
            let text = if official_annotations() {
                raw
            } else {
                raw.trim().to_ascii_lowercase()
            };
            if !text.trim().is_empty() {
                return text;
            }
        }
        let ctype = el
            .CachedControlType()
            .ok()
            .or_else(|| el.CurrentControlType().ok())
            .map(|id| id.0)
            .unwrap_or(50025);
        control_type_name(ctype).to_string()
    }
}

/// `UIA_CustomControlTypeId`.
pub const UIA_CUSTOM_CONTROL_TYPE: i32 = 50025;
/// `UIA_DocumentControlTypeId` -- the official prints `Document text:` for this element.
pub const UIA_DOCUMENT_CONTROL_TYPE: i32 = 50030;

fn control_type_name(id: i32) -> &'static str {
    match id {
        50000 => "button",
        50001 => "calendar",
        50002 => "checkbox",
        50003 => "combo box",
        50004 => "text field",
        50005 => "hyperlink",
        50006 => "image",
        50007 => "list item",
        50008 => "list",
        50009 => "menu",
        50010 => "menu bar",
        50011 => "menu item",
        50012 => "progress bar",
        50013 => "radio button",
        50014 => "scroll bar",
        50015 => "slider",
        50016 => "spinner",
        50017 => "status bar",
        50018 => "tab",
        50019 => "tab item",
        50020 => "text",
        50021 => "toolbar",
        50022 => "tooltip",
        50023 => "tree",
        50024 => "tree item",
        50025 => "custom",
        50026 => "group",
        50027 => "thumb",
        50028 => "data grid",
        50029 => "data item",
        50030 => "document",
        50031 => "split button",
        50032 => "window",
        50033 => "pane",
        50034 => "header",
        50035 => "header item",
        50036 => "table",
        50037 => "title bar",
        50038 => "separator",
        50039 => "semantic zoom",
        50040 => "app bar",
        _ => "custom",
    }
}

/// The control-type id. Role *text* is localised (`文档` on a Chinese Word), so anything
/// that keys off "is this the document?" has to use the id.
fn control_type_id(el: &IUIAutomationElement) -> i32 {
    unsafe {
        el.CachedControlType()
            .ok()
            .or_else(|| el.CurrentControlType().ok())
            .map(|id| id.0)
            .unwrap_or(UIA_CUSTOM_CONTROL_TYPE)
    }
}

fn element_rect(el: &IUIAutomationElement) -> RECT {
    unsafe {
        el.CachedBoundingRectangle()
            .ok()
            .or_else(|| el.CurrentBoundingRectangle().ok())
            .unwrap_or_default()
    }
}

fn logical_bounds(rect: RECT, origin: (f64, f64), scale: f64) -> Bounds {
    let scale = if scale > 0.01 { scale } else { 1.0 };
    let x = (rect.left as f64 - origin.0) / scale;
    let y = (rect.top as f64 - origin.1) / scale;
    let width = (rect.right - rect.left) as f64 / scale;
    let height = (rect.bottom - rect.top) as f64 / scale;
    Bounds { x, y, width, height }
}

fn value_of(el: &IUIAutomationElement) -> String {
    pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId)
        .and_then(|pat| unsafe { pat.CachedValue().ok().or_else(|| pat.CurrentValue().ok()) })
        .map(bstr_to_string)
        .unwrap_or_default()
}

fn expand_state(el: &IUIAutomationElement) -> Option<ExpandCollapseState> {
    pattern::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId).and_then(|pat| unsafe {
        pat.CachedExpandCollapseState()
            .ok()
            .or_else(|| pat.CurrentExpandCollapseState().ok())
    })
}

fn toggle_state(el: &IUIAutomationElement) -> Option<i32> {
    pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId).and_then(|pat| unsafe {
        pat.CachedToggleState()
            .ok()
            .or_else(|| pat.CurrentToggleState().ok())
            .map(|s| s.0)
    })
}

fn scrollable(el: &IUIAutomationElement) -> (bool, bool) {
    let Some(pat) = pattern::<IUIAutomationScrollPattern>(el, UIA_ScrollPatternId) else {
        return (false, false);
    };
    unsafe {
        let hz = pat
            .CachedHorizontallyScrollable()
            .ok()
            .or_else(|| pat.CurrentHorizontallyScrollable().ok())
            .map(|b| b.as_bool())
            .unwrap_or(false);
        let vt = pat
            .CachedVerticallyScrollable()
            .ok()
            .or_else(|| pat.CurrentVerticallyScrollable().ok())
            .map(|b| b.as_bool())
            .unwrap_or(false);
        (hz, vt)
    }
}

fn value_readonly(el: &IUIAutomationElement) -> Option<bool> {
    pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId).and_then(|pat| unsafe {
        pat.CachedIsReadOnly()
            .ok()
            .or_else(|| pat.CurrentIsReadOnly().ok())
            .map(|b| b.as_bool())
    })
}

fn secondary_actions(el: &IUIAutomationElement) -> Vec<String> {
    let mut actions = Vec::new();
    // AX-02: `Raise` is a live WindowPattern read. Probed on Word: live WindowPattern
    // elements = {root, 4 panes} = exactly the official's five `Secondary Actions: Raise`
    // lines, while 59 live Invoke-capable elements get none (and neither does ParityTarget's
    // Invoke button). DSH's rich profile keeps its Invoke-inclusive superset.
    let raise = if official_annotations() {
        pattern_available_live(el, UIA_WindowPatternId)
    } else {
        has_pattern(el, UIA_InvokePatternId) || has_pattern(el, UIA_WindowPatternId)
    };
    if raise {
        actions.push("Raise");
    }
    let (hz, vt) = scrollable(el);
    if vt || has_pattern(el, UIA_ScrollPatternId) {
        if vt || !hz {
            actions.extend(["Scroll Up", "Scroll Down"]);
        }
        if hz {
            actions.extend(["Scroll Left", "Scroll Right"]);
        }
    }
    let expand = expand_state(el);
    if expand.is_some() || has_pattern(el, UIA_ExpandCollapsePatternId) {
        let expand_id = expand.map(|s| s.0);
        if expand_id.is_none()
            || expand_id == Some(ExpandCollapseState_Collapsed.0)
            || expand_id == Some(ExpandCollapseState_PartiallyExpanded.0)
        {
            actions.push("Expand");
        }
        if expand_id.is_none()
            || expand_id == Some(ExpandCollapseState_Expanded.0)
            || expand_id == Some(ExpandCollapseState_PartiallyExpanded.0)
        {
            actions.push("Collapse");
        }
    }
    let mut out = Vec::new();
    for name in SECONDARY_ACTIONS {
        if actions.contains(name) && !out.iter().any(|item| item == name) {
            out.push((*name).to_string());
        }
    }
    out
}

fn states_of(el: &IUIAutomationElement) -> Vec<String> {
    let mut flags = Vec::new();
    // AX-20: the official reads SelectionItem *availability* live on descendants (Word's
    // ribbon tabs are `(selectable)`) but reads the `IsSelected` *property* only through a
    // cache that is never built below the root -- probed: TabHome is live IsSelected=true
    // and the official still prints `(selectable)` with no `(selected)`.
    if pattern_available_live(el, UIA_SelectionItemPatternId) {
        flags.push("selectable".into());
        if let Some(pat) = pattern::<IUIAutomationSelectionItemPattern>(el, UIA_SelectionItemPatternId) {
            let selected = unsafe {
                pat.CachedIsSelected()
                    .ok()
                    .or_else(|| pat.CurrentIsSelected().ok())
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
            };
            if selected {
                flags.push("selected".into());
            }
        }
    }
    let enabled = unsafe {
        el.CachedIsEnabled()
            .ok()
            .or_else(|| el.CurrentIsEnabled().ok())
            .map(|b| b.as_bool())
            .unwrap_or(true)
    };
    if !enabled {
        flags.push("disabled".into());
    }
    match expand_state(el).map(|s| s.0) {
        Some(id) if id == ExpandCollapseState_Collapsed.0 => flags.push("collapsed".into()),
        Some(id) if id == ExpandCollapseState_Expanded.0 => flags.push("expanded".into()),
        Some(id) if id == ExpandCollapseState_PartiallyExpanded.0 => flags.push("partially expanded".into()),
        _ => {}
    }
    let readonly = value_readonly(el);
    if has_pattern(el, UIA_RangeValuePatternId) {
        flags.push("settable, float".into());
    } else if readonly == Some(false) {
        flags.push("settable, string".into());
    }
    match toggle_state(el) {
        Some(x) if x == ToggleState_Off.0 => flags.push("off".into()),
        Some(x) if x == ToggleState_On.0 => flags.push("on".into()),
        Some(x) if x == ToggleState_Indeterminate.0 => flags.push("indeterminate".into()),
        _ => {}
    }
    flags
}

fn element_node(
    el: &IUIAutomationElement,
    index: i32,
    depth: usize,
    origin: (f64, f64),
    scale: f64,
) -> UiNode {
    let focused = unsafe {
        el.CachedHasKeyboardFocus()
            .ok()
            .or_else(|| el.CurrentHasKeyboardFocus().ok())
            .map(|b| b.as_bool())
            .unwrap_or(false)
    };
    let automation_id = unsafe {
        el.CachedAutomationId()
            .ok()
            .or_else(|| el.CurrentAutomationId().ok())
            .map(bstr_to_string)
            .unwrap_or_default()
    };
    let description = unsafe {
        el.CachedHelpText()
            .ok()
            .or_else(|| el.CurrentHelpText().ok())
            .map(bstr_to_string)
            .unwrap_or_default()
    };
    UiNode {
        index,
        role: role_of(el),
        name: element_name(el),
        bounds: logical_bounds(element_rect(el), origin, scale),
        value: value_of(el),
        depth,
        actions: secondary_actions(el),
        automation_id,
        description,
        states: states_of(el),
        focused,
        runtime_id: runtime_id(el),
        truncated: None,
    }
}

fn runtime_id(el: &IUIAutomationElement) -> Vec<i32> {
    unsafe {
        let Ok(psa) = el.GetRuntimeId() else {
            return Vec::new();
        };
        if psa.is_null() {
            return Vec::new();
        }
        let lb = SafeArrayGetLBound(psa, 1).unwrap_or(0);
        let ub = SafeArrayGetUBound(psa, 1).unwrap_or(-1);
        let mut data = std::ptr::null_mut();
        let mut out = Vec::new();
        if SafeArrayAccessData(psa, &mut data).is_ok() && !data.is_null() && ub >= lb {
            let n = ((ub - lb + 1) as usize).min(16);
            out.extend_from_slice(std::slice::from_raw_parts(data as *const i32, n));
            let _ = SafeArrayUnaccessData(psa);
        }
        let _ = SafeArrayDestroy(psa);
        out
    }
}

fn process_id(el: &IUIAutomationElement) -> Option<i32> {
    unsafe {
        el.CachedProcessId()
            .ok()
            .or_else(|| el.CurrentProcessId().ok())
    }
}

/// AX-25: the official extracts text through a *live* TextPattern. Its Word tree carries a
/// `Document text:` block, which is unreachable when the pattern is read out of the
/// element-scoped cache (the official never builds the cache below the root).
fn text_pattern(el: &IUIAutomationElement) -> Option<IUIAutomationTextPattern> {
    unsafe {
        el.GetCachedPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()
            .or_else(|| el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).ok())
    }
}

/// AX-28: TextPattern text arrives with the provider's own line endings (Word uses CR for
/// paragraph marks). The official prints LF, so both text fields are normalised.
pub fn normalize_newlines(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn selection_text(el: &IUIAutomationElement) -> String {
    let Some(pat) = text_pattern(el) else {
        return String::new();
    };
    unsafe {
        if let Ok(arr) = pat.GetSelection() {
            let n = arr.Length().unwrap_or(0).min(8);
            let mut chunks = Vec::new();
            for i in 0..n {
                if let Ok(rng) = arr.GetElement(i) {
                    if let Ok(text) = rng.GetText(-1) {
                        let s = bstr_to_string(text);
                        if !s.is_empty() {
                            chunks.push(s);
                        }
                    }
                }
            }
            if !chunks.is_empty() {
                return normalize_newlines(&chunks.join("\n"));
            }
        }
        // AX-27: no fallback to `DocumentRange`. That fallback made the whole document look
        // like the user's selection, and the official reports `selected_text` only for a real
        // selection (its Word result simply has no `selected_text` key).
        String::new()
    }
}

fn document_text(el: &IUIAutomationElement) -> String {
    let Some(pat) = text_pattern(el) else {
        return String::new();
    };
    unsafe {
        let text = normalize_newlines(
            &pat.DocumentRange()
                .ok()
                .and_then(|rng| rng.GetText(-1).ok())
                .map(bstr_to_string)
                .unwrap_or_default(),
        );
        if text.len() > 32_000 {
            text[..32_000].to_string()
        } else {
            text
        }
    }
}

fn process_name(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 260];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        if ok.is_err() {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.replace('\\', "/")
            .rsplit('/')
            .next()
            .unwrap_or(&path)
            .to_string()
    }
}

fn window_title(hwnd: HWND) -> String {
    unsafe {
        let n = GetWindowTextLengthW(hwnd);
        if n <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; n as usize + 1];
        let got = GetWindowTextW(hwnd, &mut buf);
        if got <= 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..got as usize])
        }
    }
}

fn skip_title(title: &str) -> bool {
    SKIP_TITLES.iter().any(|t| *t == title)
}

fn foreground_hwnds() -> Vec<isize> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return Vec::new();
        }
        let root = GetAncestor(fg, GA_ROOT);
        let mut out = Vec::new();
        for handle in [fg, root] {
            let id = hwnd_val(handle);
            if id != 0 && !out.contains(&id) && !skip_title(&window_title(handle)) {
                out.push(id);
            }
        }
        out
    }
}

fn window_logical_bounds(hwnd: isize, origin: (f64, f64), scale: f64) -> Bounds {
    let mut rect = RECT::default();
    if hwnd != 0 {
        let _ = unsafe { GetWindowRect(as_hwnd(hwnd), &mut rect) };
    }
    logical_bounds(rect, origin, scale)
}

fn fallback_dump(hwnd: isize, title: &str, origin: (f64, f64), scale: f64) -> AccessibilityDump {
    let node = UiNode {
        index: 0,
        role: "window".into(),
        name: if title.is_empty() {
            hwnd.to_string()
        } else {
            title.to_string()
        },
        bounds: window_logical_bounds(hwnd, origin, scale),
        value: String::new(),
        depth: 0,
        actions: Vec::new(),
        automation_id: String::new(),
        description: String::new(),
        states: Vec::new(),
        focused: true,
        runtime_id: Vec::new(),
        truncated: None,
    };
    let focused = focused_line(&node);
    AccessibilityDump {
        focused,
        nodes: vec![node],
        ..AccessibilityDump::default()
    }
}

fn integrity_rid(pid: u32) -> Option<u32> {
    unsafe {
        let proc = if pid == GetCurrentProcessId() {
            GetCurrentProcess()
        } else {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?
        };
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(proc, TOKEN_QUERY, &mut token);
        if pid != GetCurrentProcessId() {
            let _ = CloseHandle(proc);
        }
        opened.ok()?;
        let mut size = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut size);
        if size == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let ok = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            size,
            &mut size,
        );
        let _ = CloseHandle(token);
        ok.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count_ptr = GetSidSubAuthorityCount(label.Label.Sid);
        if count_ptr.is_null() || *count_ptr == 0 {
            return None;
        }
        let rid_ptr = GetSidSubAuthority(label.Label.Sid, (*count_ptr as u32) - 1);
        if rid_ptr.is_null() {
            None
        } else {
            Some(*rid_ptr)
        }
    }
}

pub fn integrity_blocked(hwnd: isize) -> Option<String> {
    if hwnd == 0 {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(as_hwnd(hwnd), Some(&mut pid)) };
    let theirs = integrity_rid(pid)?;
    let ours = integrity_rid(unsafe { GetCurrentProcessId() })?;
    if theirs > ours {
        Some(INTEGRITY_MESSAGE.to_string())
    } else {
        None
    }
}

/// Official template, recovered from the three adjacent fragments
/// `(truncated: ` / `, omitted ` / ` children)` (S:18346-18348). Two arguments; the
/// first is the budget that was hit, the second the number of children not walked.
/// Static evidence cannot pin the first argument beyond "not a role/name" -- the old DSH
/// label stuffed `{role} {name}` in there, which is why this no longer takes a node.
pub fn truncated_label(truncation: &Truncation) -> String {
    format!(
        "{TRUNCATED_PREFIX}{}, omitted {} children)",
        truncation.limit, truncation.omitted
    )
}

/// The `focused_element` field is the element's formatted *line*, exactly as it appears
/// in the tree (a human-readable one-line label). The
/// `The focused UI element is ...` sentence is added once, at the end of the tree.
pub fn focused_line(node: &UiNode) -> String {
    focused_sentence(node)
}

fn focused_sentence(node: &UiNode) -> String {
    // The official's focused line carries no indentation even for a nested element.
    format_node_line(node).trim_start_matches('\t').to_string()
}

pub fn format_node_line(node: &UiNode) -> String {
    // Grammar verified against the official helper itself (parity/golden-ax.mjs drives
    // codex-computer-use.exe and diffs both trees):
    //   * one TAB per depth (the official api.md calls it "tab hierarchy"),
    //   * a bare element index, no brackets,
    //   * the name unquoted, and omitted entirely when empty,
    //   * NO bounding box -- the official prints none, and its string table contains no
    //     bounds template at all (only the viewport-error one).
    // The official indents the root by one tab too (verified: root line starts with a
    // single \t, its children with two).
    let indent = "\t".repeat(node.depth + 1);
    let mut extras = Vec::new();
    let pre: Vec<_> = node
        .states
        .iter()
        .filter(|s| {
            matches!(
                s.as_str(),
                "selectable"
                    | "selected"
                    | "disabled"
                    | "collapsed"
                    | "expanded"
                    | "partially expanded"
                    | "settable"
                    | "settable, string"
                    | "settable, float"
            )
        })
        .cloned()
        .collect();
    let toggle: Vec<_> = node
        .states
        .iter()
        .filter(|s| matches!(s.as_str(), "off" | "on" | "indeterminate"))
        .cloned()
        .collect();
    let other: Vec<_> = node
        .states
        .iter()
        .filter(|s| {
            !pre.contains(s) && !toggle.contains(s)
        })
        .cloned()
        .collect();
    // Official state formatting: the primary state list is wrapped in
    // parentheses, exactly as the template pair found in .rdata
    // ("({{}, {})" and " ({{}, {})") renders it.
    // AX-19: the official's field order is `role (state) name ...`, not
    // `role name (state) ...` (`1 窗格 (disabled) DropShadowTop`,
    // `11 SplitButton (disabled) 无法撤消 ID: Undo`). ParityTarget carries no element state
    // at all, which is why the older golden never caught this.
    let state_block = if pre.is_empty() {
        String::new()
    } else {
        format!(" ({})", pre.join(", "))
    };
    if !node.description.is_empty() {
        extras.push(format!("Description: {}", node.description));
    }
    if !node.value.is_empty() {
        extras.push(format!("Value: {}", node.value));
    }
    if !toggle.is_empty() {
        extras.push(toggle.join(", "));
    }
    if !other.is_empty() {
        extras.push(other.join(", "));
    }
    if !node.actions.is_empty() {
        extras.push(format!("Secondary Actions: {}", node.actions.join(", ")));
    }
    if !node.automation_id.is_empty() {
        extras.push(format!("ID: {}", node.automation_id));
    }
    // AX-09: the truncation marker is a suffix on the truncated element itself, on the
    // same footing as `Secondary Actions:` / `ID:` -- never a synthetic tree node.
    if let Some(truncation) = &node.truncated {
        extras.push(truncated_label(truncation));
    }
    let suffix = if extras.is_empty() {
        String::new()
    } else {
        format!(" {}", extras.join(" "))
    };
    // Name is unquoted and absent when empty, so a title bar renders as `4 标题栏`.
    let name = if node.name.is_empty() {
        String::new()
    } else {
        format!(" {}", node.name)
    };
    format!(
        "{indent}{} {}{state_block}{name}{suffix}",
        node.index, node.role
    )
}

/// PSG-3 / AX-04: this sentence is NOT from the Windows helper. The official window2
/// surface has no diffing at all (`diff`/`iff`/`ferent` are absent from its string
/// table; a second observation returns the full tree -- `golden-ax/official-diff.txt`).
/// It comes from the browser/alt surface (`disable_diffing`, `getAXState`). It is kept
/// only because the DSH plugin still opts into the diff; `get_window_state` must not
/// present it as an official contract.
pub const NO_TREE_CHANGE: &str = "no accessibility-tree change";

/// DSH extension (not an official window2 contract): line-wise diff of two trees, used
/// by the `disableDiffing` opt-out. Prefer `AccessibilityDump::to_json` + the full tree
/// for anything model-facing.
pub fn tree_diff(previous: &str, current: &str) -> String {
    if previous == current {
        return NO_TREE_CHANGE.to_string();
    }
    let before: std::collections::HashSet<&str> = previous.lines().collect();
    let after: std::collections::HashSet<&str> = current.lines().collect();
    let removed: Vec<&str> = previous
        .lines()
        .filter(|line| !after.contains(line))
        .collect();
    let added: Vec<&str> = current
        .lines()
        .filter(|line| !before.contains(line))
        .collect();
    if removed.is_empty() && added.is_empty() {
        // Same set of lines, different order: nothing for the model to re-read.
        return NO_TREE_CHANGE.to_string();
    }
    let mut parts: Vec<String> = Vec::new();
    if !removed.is_empty() {
        parts.push("removed:".to_string());
        parts.extend(removed.iter().map(|line| (*line).to_string()));
    }
    if !added.is_empty() {
        parts.push("added/changed:".to_string());
        parts.extend(added.iter().map(|line| (*line).to_string()));
    }
    parts.join("\n")
}

/// The official prints the executable file name in the tree header even though its
/// `list_windows` identity is the tagged `process:<full path>` form (verified live by
/// `parity/golden-ax.mjs`: the official reports `process:E:\\...\\ParityTarget.exe` as the
/// window app but prints `App: ParityTarget.exe.`). DSH carries the same tagged identity,
/// so the header normalises it the same way. Keep this in step with the identity plane if
/// the tag ever changes.
pub fn display_app(app: &str) -> &str {
    let name = app.strip_prefix("process:").unwrap_or(app);
    match name.rsplit(['\\', '/']).next() {
        Some(file) if !file.is_empty() => file,
        _ => app,
    }
}

pub fn format_accessibility(dump: &AccessibilityDump, window_title: &str, app: &str) -> String {
    // AX-22: in official mode the header carries the whitespace-normalised UIA name of the
    // target window -- Word's own list_windows title keeps the double spaces while the
    // official's tree header does not, so the header is not the raw Win32 text. The rich
    // profile keeps DSH's historical behaviour of printing the title it was handed.
    let header_title: String = if official_annotations() {
        match dump.nodes.first().map(|node| node.name.clone()) {
            Some(name) if !name.is_empty() => name,
            _ => collapse_whitespace(window_title),
        }
    } else {
        window_title.to_string()
    };
    let mut parts = vec![format!(
        "Window: \"{header_title}\", App: {}.",
        display_app(app)
    )];
    parts.extend(dump.nodes.iter().map(format_node_line));
    // AX-06: every tail section carries its own leading newline in the official (the section
    // literals are `\nThe focused UI element is `, `\nSelected text: ``, `\nDocument text: ``),
    // so the tree body is always followed by exactly one blank line before the first section.
    // The blank line used to be pushed only by the focused-sentence branch, which is why
    // suppressing the sentence for a document-text window also dropped the separator.
    let has_tail = (!dump.focused.is_empty()
        && !(official_annotations() && !dump.document_text.is_empty()))
        || !dump.selected_elements.is_empty()
        || !dump.selected_text.is_empty()
        || !dump.document_text.is_empty();
    if has_tail {
        parts.push(String::new());
    }
    if !dump.focused.is_empty() && !(official_annotations() && !dump.document_text.is_empty()) {
        // The field itself is the bare line; the tree carries the sentence.
        //
        // AX-26: the official never prints both. Word's tree ends with
        // `\n\nDocument text: ```...``` ` and no focused sentence even though it does report
        // a `focused_element`; ParityTarget and Explorer print the sentence and have no
        // document text. The `focused_element` field itself is still reported.
        //
        // AX-06: the official golden is `...关闭\n\nThe focused UI element is ...` -- the
        // section literals (`\nThe focused UI element is `, `\nSelected text: ``,
        // `\nDocument text: ``) each carry their own leading newline, so the tree body
        // and the sentence are separated by a blank line. DSH was missing it.
        parts.push(format!("{FOCUSED_PREFIX} {}.", dump.focused));
    }
    if !dump.selected_elements.is_empty() {
        parts.push(SELECTED_LIST_PREFIX.to_string());
        parts.extend(dump.selected_elements.iter().cloned());
    }
    if !dump.selected_text.is_empty() {
        parts.push(format!("{SELECTED_PREFIX} ```\n{}\n```", dump.selected_text));
    }
    if !dump.document_text.is_empty() {
        parts.push(format!("{DOCUMENT_PREFIX} ```\n{}\n```", dump.document_text));
    }
    if !dump.selected_text.is_empty() || !dump.selected_elements.is_empty() {
        parts.push(SELECTED_NOTE.to_string());
    }
    parts.join("\n")
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    #[test]
    fn identical_trees_report_the_official_sentence() {
        let tree = "Window: \"a\", App: b.\n  [0] button \"OK\"";
        assert_eq!(tree_diff(tree, tree), NO_TREE_CHANGE);
    }

    #[test]
    fn diff_lists_removed_then_added() {
        let previous = "Window: \"a\", App: b.\n  [0] button \"OK\"\n  [1] text \"hi\"";
        let current = "Window: \"a\", App: b.\n  [0] button \"Cancel\"\n  [1] text \"hi\"";
        let diff = tree_diff(previous, current);
        assert!(diff.starts_with("removed:\n"), "{diff}");
        assert!(diff.contains("  [0] button \"OK\""), "{diff}");
        assert!(diff.contains("added/changed:\n"), "{diff}");
        assert!(diff.contains("  [0] button \"Cancel\""), "{diff}");
    }

    #[test]
    fn reordered_only_tree_counts_as_no_change() {
        // Same set of lines in a different order carries no new information for
        // the model, so it collapses to the stable "no change" sentence.
        assert_eq!(tree_diff("a\nb", "b\na"), NO_TREE_CHANGE);
    }

    fn sample_node(depth: usize, index: i32, role: &str, name: &str) -> UiNode {
        UiNode {
            depth,
            index,
            role: role.to_string(),
            name: name.to_string(),
            bounds: Bounds { x: 48.0, y: 83.0, width: 480.0, height: 36.0 },
            value: "parity-initial".to_string(),
            automation_id: "ParityBox".to_string(),
            description: String::new(),
            states: vec!["settable, string".to_string()],
            actions: Vec::new(),
            focused: false,
            runtime_id: Vec::new(),
            truncated: None,
        }
    }

    /// Grammar verified by driving the official helper (`parity/golden-ax.mjs`): one TAB
    /// per depth *including the root*, a bare index, an unquoted name that is omitted when
    /// empty, and no bounding box. This test exists so the format cannot drift back.
    #[test]
    fn node_line_matches_the_official_grammar() {
        let root = sample_node(0, 0, "窗口", "Parity Target");
        let line = format_node_line(&root);
        // AX-19: the synthetic root carries a state, so it also pins where that state goes
        // -- between the role and the name, exactly like the official's
        // `1 窗格 (disabled) DropShadowTop`. `Value:` stays after the name: it is
        // root-exclusive and no official sample shows it next to a state.
        assert!(
            line.starts_with("\t0 窗口 (settable, string) Parity Target"),
            "{line}"
        );
        assert!(!line.contains('"'), "names are unquoted: {line}");
        assert!(!line.contains("{x:"), "the official prints no bounds: {line}");
        assert!(!line.contains('['), "the index is bare: {line}");

        let child = sample_node(1, 2, "编辑", "Parity probe label");
        let child_line = format_node_line(&child);
        assert!(
            child_line.starts_with("\t\t2 编辑 (settable, string) Parity probe label"),
            "{child_line}"
        );
        assert!(child_line.ends_with("ID: ParityBox"), "{child_line}");

        // An unnamed element renders as `<indent><index> <role>` with no trailing space.
        let unnamed = sample_node(1, 4, "标题栏", "");
        let unnamed_line = format_node_line(&unnamed);
        assert!(unnamed_line.starts_with("\t\t4 标题栏"), "{unnamed_line}");
        assert!(!unnamed_line.contains("标题栏  "), "no double space: {unnamed_line}");

        // The focused line is the bare line, with no indentation and no prefix sentence.
        let focused = focused_line(&child);
        assert!(focused.starts_with("2 编辑 (settable, string) Parity probe label"), "{focused}");
        assert!(!focused.contains(FOCUSED_PREFIX), "{focused}");
    }
}

/// AX-06 / AX-01 / AX-02 / AX-03 / AX-07 / AX-09 / AX-10 / AX-11 / AX-12 gates.
///
/// These are the checks the 2026-09-14 deep dive found missing: the live
/// `verify-all.ps1` gates never touched the accessibility tree, and the only grammar
/// test asserted a single line prefix.
#[cfg(test)]
mod ax_tests {
    use super::*;

    /// The official sample, byte for byte (`parity/golden-ax/official.tree.txt`).
    /// `\n\n` before the focused sentence is AX-06 -- the one pure syntax difference the
    /// deep dive still found in the golden.
    const GOLDEN_TREE: &str = concat!(
        "Window: \"Parity Target\", App: ParityTarget.exe.\n",
        "\t0 窗口 Parity Target Secondary Actions: Raise\n",
        "\t\t1 文本 Parity probe label ID: 14681076\n",
        "\t\t2 编辑 Parity probe label ID: ParityBox\n",
        "\t\t3 按钮 Parity Button ID: ParityButton\n",
        "\t\t4 标题栏\n",
        "\t\t\t5 菜单栏 系统 ID: MenuBar\n",
        "\t\t\t\t6 菜单项 系统\n",
        "\t\t\t7 按钮 最小化\n",
        "\t\t\t8 按钮 最大化\n",
        "\t\t\t9 按钮 关闭\n",
        "\n",
        "The focused UI element is 2 编辑 Parity probe label ID: ParityBox."
    );

    fn node(index: i32, depth: usize, role: &str, name: &str) -> UiNode {
        UiNode {
            index,
            role: role.to_string(),
            name: name.to_string(),
            bounds: Bounds { x: 0.0, y: 0.0, width: 0.0, height: 0.0 },
            value: String::new(),
            depth,
            actions: Vec::new(),
            automation_id: String::new(),
            description: String::new(),
            states: Vec::new(),
            focused: false,
            runtime_id: Vec::new(),
            truncated: None,
        }
    }

    fn golden_dump() -> AccessibilityDump {
        let mut root = node(0, 0, "窗口", "Parity Target");
        root.actions = vec!["Raise".into()];
        let mut text = node(1, 1, "文本", "Parity probe label");
        text.automation_id = "14681076".into();
        let mut edit = node(2, 1, "编辑", "Parity probe label");
        edit.automation_id = "ParityBox".into();
        let mut button = node(3, 1, "按钮", "Parity Button");
        button.automation_id = "ParityButton".into();
        let menu = node(4, 1, "标题栏", "");
        let mut bar = node(5, 2, "菜单栏", "系统");
        bar.automation_id = "MenuBar".into();
        AccessibilityDump {
            nodes: vec![
                root,
                text,
                edit,
                button,
                menu,
                bar,
                node(6, 3, "菜单项", "系统"),
                node(7, 2, "按钮", "最小化"),
                node(8, 2, "按钮", "最大化"),
                node(9, 2, "按钮", "关闭"),
            ],
            focused: "2 编辑 Parity probe label ID: ParityBox".into(),
            ..AccessibilityDump::default()
        }
    }

    #[test]
    fn official_golden_tree_matches_byte_for_byte() {
        let dump = golden_dump();
        let rendered = format_accessibility(&dump, "Parity Target", "ParityTarget.exe");
        assert_eq!(rendered, GOLDEN_TREE);
    }
    #[test]
    fn tagged_window_identity_renders_the_official_app_name() {
        assert_eq!(display_app("ParityTarget.exe"), "ParityTarget.exe");
        assert_eq!(
            display_app("process:C:\\repo\\parity\\ParityTarget.exe"),
            "ParityTarget.exe"
        );
        let rendered = format_accessibility(
            &golden_dump(),
            "Parity Target",
            "process:C:\\repo\\parity\\ParityTarget.exe",
        );
        assert_eq!(rendered, GOLDEN_TREE);
    }

    #[test]
    fn tree_tail_has_a_blank_line_before_the_focused_sentence() {
        let rendered = format_accessibility(&golden_dump(), "Parity Target", "ParityTarget.exe");
        assert!(rendered.contains("9 按钮 关闭\n\nThe focused UI element is 2 编辑"), "{rendered}");
        // ... and the focused *field* stays a bare line (official official.focused.txt).
        assert!(!golden_dump().focused.contains(FOCUSED_PREFIX));
    }

    /// AX-19: the state parenthesis sits between the role and the name. Both fixtures are
    /// official lines from the Word sample that the old order could not render.
    #[test]
    fn element_states_precede_the_name() {
        let mut pane = node(1, 1, "窗格", "DropShadowTop");
        pane.states = vec!["disabled".into()];
        assert_eq!(format_node_line(&pane), "\t\t1 窗格 (disabled) DropShadowTop");

        let mut split = node(11, 5, "SplitButton", "无法撤消");
        split.states = vec!["disabled".into()];
        split.automation_id = "Undo".into();
        assert_eq!(
            format_node_line(&split),
            "\t\t\t\t\t\t11 SplitButton (disabled) 无法撤消 ID: Undo"
        );

        // A state-free line keeps the historical shape (this is what the ParityTarget golden
        // pins, and why the old order survived for so long).
        assert_eq!(
            format_node_line(&node(2, 1, "编辑", "Parity probe label")),
            "\t\t2 编辑 Parity probe label"
        );
    }

    /// AX-28: provider line endings are normalised to LF, matching the official's output.
    #[test]
    fn provider_line_endings_become_lf() {
        assert_eq!(normalize_newlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
        assert_eq!(normalize_newlines("no breaks"), "no breaks");
    }

    /// AX-22: names are whitespace-normalised. The first two cases are the raw UIA values
    /// probed from Word; the official prints them with single spaces.
    #[test]
    fn official_names_collapse_whitespace() {
        assert_eq!(
            collapse_whitespace("03_关键时间节点与行动清单.docx  -  最后由用户保存  -  兼容性模式 - Word"),
            "03_关键时间节点与行动清单.docx - 最后由用户保存 - 兼容性模式 - Word"
        );
        assert_eq!(collapse_whitespace("  前  后  "), "前 后");
        assert_eq!(collapse_whitespace("自动保存"), "自动保存");
        assert_eq!(collapse_whitespace(""), "");
    }

    /// AX-23: both profiles must be able to render the official's 414-line Word tree without
    /// a truncation marker. `rich` keeps a (now generous) belt; `official` mirrors the
    /// official's effectively unbounded walk.
    #[test]
    fn official_walk_budgets_cover_the_official_word_tree() {
        let rich = WalkLimits::for_mode(AnnotationsMode::Rich);
        let official = WalkLimits::for_mode(AnnotationsMode::Official);
        assert_eq!(rich.max_nodes, UIA_MAX_NODES);
        assert_eq!(rich.child_limit, CHILD_LIMIT);
        assert!(
            official.max_nodes >= 414,
            "the official Word tree is 414 lines: {official:?}"
        );
        // The default (`rich`) profile must clear the same bar: it is what the model actually
        // sees, and it used to truncate the official Word tree at 250 nodes.
        assert!(
            rich.max_nodes >= 414,
            "the rich belt must clear the official Word tree: {rich:?}"
        );
        assert!(rich.child_limit >= 200, "rich child cap: {rich:?}");
        assert!(official.child_limit > rich.child_limit);
        assert!(official.max_depth >= rich.max_depth);
        // document 上限的比较不受角色名大小写影响（AX-21）。
        assert_eq!(
            WalkLimits { child_limit: 7, document_child_limit: 9, ..rich }.child_cap_for("Document"),
            9
        );
        assert_eq!(
            WalkLimits { child_limit: 7, document_child_limit: 9, ..rich }.child_cap_for("list"),
            7
        );
    }

    /// AX-16: the diagnostic payload carries every field name the official ships
    /// (`S:18075 @0x12fe76`), including `bounds`, which DSH used to omit.
    #[test]
    fn diagnostic_payload_keeps_the_official_field_names() {
        let value = diagnostics_payload(None);
        for key in [
            "appId",
            "processId",
            "rootHwnd",
            "inputHwnd",
            "processName",
            "bounds",
            "snapshotRevision",
            "accessibilityRevision",
            "accessibilitySnapshotCount",
            "lastCaptureInvalidationReason",
        ] {
            assert!(value.get(key).is_some(), "missing official diagnostic field {key}");
        }
        assert!(value["bounds"]["width"].is_number(), "{value}");
    }

    fn property_ids(ids: &[windows::Win32::UI::Accessibility::UIA_PROPERTY_ID]) -> Vec<i32> {
        let mut values: Vec<i32> = ids.iter().map(|id| id.0).collect();
        values.sort_unstable();
        values
    }

    fn pattern_ids(ids: &[UIA_PATTERN_ID]) -> Vec<i32> {
        let mut values: Vec<i32> = ids.iter().map(|id| id.0).collect();
        values.sort_unstable();
        values
    }

    fn event_ids(ids: &[UIA_EVENT_ID]) -> Vec<i32> {
        let mut values: Vec<i32> = ids.iter().map(|id| id.0).collect();
        values.sort_unstable();
        values
    }

    /// AX-01: the official 11 properties recovered from the immediate arrays at
    /// `G:18703-18710`. Any further widening must edit this test on purpose.
    #[test]
    fn official_property_set_matches_the_ghidra_immediates() {
        assert_eq!(
            property_ids(OFFICIAL_DUMP_PROPERTIES),
            vec![30000, 30001, 30002, 30003, 30004, 30005, 30008, 30010, 30011, 30013, 30020]
        );
        // The rich profile is exactly the official set plus the two registered extras.
        let rich = property_ids(DUMP_CACHE_PROPERTIES);
        let extras = property_ids(RICH_ONLY_PROPERTIES);
        assert_eq!(extras, vec![30012, 30022]);
        let mut union = property_ids(OFFICIAL_DUMP_PROPERTIES);
        union.extend(extras);
        union.sort_unstable();
        assert_eq!(rich, union);
    }

    /// AX-02: the official 9 patterns (`G:18715-18719`); DSH adds Invoke / ScrollItem /
    /// LegacyIAccessible. `Invoke` is what made every DSH button print `Raise`.
    #[test]
    fn official_pattern_set_matches_the_ghidra_immediates() {
        assert_eq!(
            pattern_ids(OFFICIAL_DUMP_PATTERNS),
            vec![10001, 10002, 10003, 10004, 10005, 10009, 10010, 10014, 10015]
        );
        let extras = pattern_ids(RICH_ONLY_PATTERNS);
        assert_eq!(extras, vec![10000, 10017, 10018]);
        let mut union = pattern_ids(OFFICIAL_DUMP_PATTERNS);
        union.extend(extras);
        union.sort_unstable();
        assert_eq!(pattern_ids(DUMP_CACHE_PATTERNS), union);
    }

    /// AX-11: the official registers exactly three automation events
    /// (`G:18892/18895/18898`). DSH's extra menu open/close and window-closed handlers
    /// dropped the cache on every menu interaction.
    #[test]
    fn official_event_set_matches_the_ghidra_immediates() {
        assert_eq!(event_ids(OFFICIAL_AUTOMATION_EVENTS), vec![20014, 20015, 20016]);
        let extras = event_ids(RICH_ONLY_EVENTS);
        assert_eq!(extras, vec![20003, 20007, 20017]);
        let mut union = event_ids(OFFICIAL_AUTOMATION_EVENTS);
        union.extend(extras);
        union.sort_unstable();
        assert_eq!(event_ids(AUTOMATION_EVENTS), union);
    }

    /// AX-03: the two profiles select the documented sets. The behavioural half (no
    /// `put_TreeScope`, plain descendant walk, cached-only patterns) lives in
    /// `open` / `visit` / `pattern`; this pins the selector those branches use.
    #[test]
    fn annotations_mode_selects_the_matching_profile() {
        assert_eq!(AnnotationsMode::parse("official"), Some(AnnotationsMode::Official));
        assert_eq!(AnnotationsMode::parse(" RICH "), Some(AnnotationsMode::Rich));
        assert_eq!(AnnotationsMode::parse(""), Some(AnnotationsMode::Rich));
        assert_eq!(AnnotationsMode::parse("verbose"), None);

        assert_eq!(
            property_ids(dump_cache_properties_for(AnnotationsMode::Official)),
            property_ids(OFFICIAL_DUMP_PROPERTIES)
        );
        assert_eq!(
            pattern_ids(dump_cache_patterns_for(AnnotationsMode::Official)),
            pattern_ids(OFFICIAL_DUMP_PATTERNS)
        );
        assert_eq!(
            event_ids(automation_events_for(AnnotationsMode::Official)),
            event_ids(OFFICIAL_AUTOMATION_EVENTS)
        );
        assert_eq!(
            property_ids(dump_cache_properties_for(AnnotationsMode::Rich)),
            property_ids(DUMP_CACHE_PROPERTIES)
        );
    }

    /// AX-09: the truncation marker is a suffix on the truncated element, using the
    /// official two-argument template, and it never becomes a synthetic tree node.
    #[test]
    fn truncation_is_a_line_suffix_not_a_synthetic_node() {
        let mut parent = node(3, 1, "列表", "Inbox");
        parent.truncated = Some(Truncation {
            reason: "child_limit".into(),
            limit: 48,
            omitted: 12,
        });
        let line = format_node_line(&parent);
        assert!(line.starts_with("\t\t3 列表 Inbox"), "{line}");
        assert!(line.ends_with("(truncated: 48, omitted 12 children)"), "{line}");
        assert_eq!(truncated_label(parent.truncated.as_ref().unwrap()), "(truncated: 48, omitted 12 children)");
        // A second chunk of omitted children accumulates rather than duplicating the line.
        let mut two = node(4, 1, "列表", "Other");
        two.truncated = Some(Truncation { reason: "child_limit".into(), limit: 48, omitted: 5 });
        let mut dump = AccessibilityDump {
            nodes: vec![parent, two],
            ..AccessibilityDump::default()
        };
        dump.truncation = "child_limit".into();
        dump.truncation_limit = 48;
        dump.truncation_omitted = 17;
        let rendered = format_accessibility(&dump, "t", "a");
        assert_eq!(rendered.matches("(truncated: 48").count(), 2, "{rendered}");
    }

    /// AX-07 / AX-10: the official `cycle` / `child_limit` / `max_depth` names carry
    /// the effective budgets, and `meta` only appears when the walk truncated.
    #[test]
    fn truncation_meta_uses_the_official_key_names() {
        let limits = WalkLimits {
            max_nodes: 250,
            child_limit: 48,
            document_child_limit: 200,
            max_depth: 32,
        };
        let mut dump = AccessibilityDump { limits, ..AccessibilityDump::default() };
        assert!(dump.truncation_meta().is_none());
        dump.truncation = "child_limit".into();
        dump.truncation_limit = 48;
        dump.truncation_omitted = 5;
        let meta = dump.truncation_meta().unwrap();
        assert_eq!(meta["cycle"], serde_json::json!(250));
        assert_eq!(meta["child_limit"], serde_json::json!(48));
        assert_eq!(meta["max_depth"], serde_json::json!(32));
        assert_eq!(meta["reason"], serde_json::json!("child_limit"));
        assert_eq!(meta["omitted_children"], serde_json::json!(5));
        // The defaults are the documented DSH budgets and are env-overridable. They are read
        // through the constants (not literals) so raising the belt cannot leave a stale
        // expectation behind -- the previous literal 48 is exactly what broke when the rich
        // profile was raised to clear the official's 414-element Word tree.
        let default = WalkLimits::default();
        assert_eq!(default.max_nodes, UIA_MAX_NODES);
        assert_eq!(default.child_limit, CHILD_LIMIT);
        assert_eq!(default.document_child_limit, DOCUMENT_FIND_MAX);
        assert_eq!(default.max_depth, MAX_DEPTH);
        assert_eq!(WalkLimits { child_limit: 7, document_child_limit: 9, ..WalkLimits::default() }.child_cap_for("list"), 7);
        assert_eq!(WalkLimits { child_limit: 7, document_child_limit: 9, ..WalkLimits::default() }.child_cap_for("document"), 9);
    }

    /// AX-05: the official `AccessibilityState` omits optional fields when they are
    /// empty and never carries a DSH `diff` key.
    #[test]
    fn accessibility_json_omits_absent_optional_fields() {
        let mut dump = AccessibilityDump {
            focused: "2 编辑 Parity probe label ID: ParityBox".into(),
            ..AccessibilityDump::default()
        };
        let value = dump.to_json("TREE");
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 2, "{value}");
        assert!(value.get("tree").is_some() && value.get("focused_element").is_some());
        assert!(value.get("diff").is_none(), "{value}");
        assert!(value.get("meta").is_none(), "{value}");

        dump.selected_text = "hello".into();
        dump.selected_elements = vec!["2 编辑".into()];
        dump.document_text = "doc".into();
        let value = dump.to_json("TREE");
        assert_eq!(value["selected_text"], serde_json::json!("hello"));
        assert_eq!(value["selected_elements"], serde_json::json!(["2 编辑"]));
        assert_eq!(value["document_text"], serde_json::json!("doc"));
        assert!(value.get("meta").is_none());
    }

    /// AX-12 / AX-13: the official fragments carry literal punctuation between the index
    /// and the sentence, and the never-observed app gets the official sentence.
    #[test]
    fn official_failure_fragments_keep_their_punctuation() {
        assert_eq!(RUNTIME_ID_MISMATCH, "( no longer matches the cached runtime ID");
        assert_eq!(CACHED_TARGET_MISMATCH, "( no longer matches the cached target in");
        assert_eq!(PROCESS_MISMATCH, "/ no longer belongs to the cached target process");
        assert_eq!(NO_CACHED_APP_STATE, "no cached app state is available for ");
        // main.rs classifies these by substring; keep that contract intact.
        assert!(format!("element 7{CACHED_TARGET_MISMATCH} 12").contains("no longer matches"));
        assert!(format!("element 7{PROCESS_MISMATCH}").contains("no longer belongs"));
    }
}

pub fn window_is_visible(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    unsafe { IsWindowVisible(as_hwnd(hwnd)).as_bool() }
}

pub fn window_title_of(hwnd: isize) -> String {
    window_title(as_hwnd(hwnd))
}

pub fn pid_of_hwnd(hwnd: isize) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(as_hwnd(hwnd), Some(&mut pid)) };
    pid
}

pub fn exe_of_pid(pid: u32) -> String {
    process_name(pid)
}


