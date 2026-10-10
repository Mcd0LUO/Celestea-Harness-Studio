//! 合成光标 / 状态胶囊 overlay —— 本期**不移植**，此处为零操作垫片。
//!
//! 背景：总规划 §2 与 §9 明确把 overlay 排除在本期之外（规避双光标坑）。
//! 参考仓 `src/overlay/`（约 5.9k 行：状态胶囊、合成光标、动效、系统光标管理器）
//! **未**被移植，这个文件不是它的移植结果。
//!
//! 保留这个模块的唯一原因是：`capture.rs` / `input.rs` / `interrupt.rs` /
//! `state.rs` / `main.rs` 里共有 46 处 `crate::overlay::*` 调用。把它们改成
//! 无操作实现而不是逐处删除，是为了让移植后的 diff 只集中在「语义真正变了」的地方，
//! 便于日后决定要不要把 overlay 接回来。
//!
//! 语义后果（已确认、不是 bug）：没有 overlay 窗口 → 没有东西需要从截图里排除 →
//! `capture_exclusion()` 恒为 `Off`、`display_hwnds()` 恒空、`visible()` 恒 false。
//! 这与「不创建 overlay 窗口」自洽。
//!
//! 唯一的非零语义是 show()/hide()：参考仓把租约监测的 arm/disarm 挂在
//! overlay 生命周期上，垫片保留这条接线（见两函数的文档与 tests 模块）。
//!
//! 若将来决定移植 overlay：删除本文件，换回参考仓的 `src/overlay/`，
//! 并同步复核 `capture.rs` 的排除逻辑（本垫片让 `OVERLAY_HWNDS` 注册表恒空）。

use windows::Win32::Foundation::HWND;

/// 垫片不创建任何窗口，因此这两个窗口类名永远不会匹配到真实窗口。
/// 保留常量是因为 `input.rs` 用它们做「这是不是我自己画的指针」的判据。
pub const CLASS_NAME: &str = "CelesteaDesktopHelperOverlayAbsent";
pub const CURSOR_CLASS: &str = "CelesteaDesktopHelperOverlayPointerAbsent";

/// 截图时如何处理 overlay 窗口。垫片只有一种现实取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureExclusion {
    /// 合成一层遮罩把 overlay 涂掉。
    Mask,
    /// 不做任何排除（垫片的唯一取值）。
    Off,
    /// 走 `SetWindowDisplayAffinity` 让 overlay 不进截图。
    Wda,
}

/// 恒为 `Off`：没有 overlay 窗口，也就没有可排除的东西。
pub fn capture_exclusion() -> CaptureExclusion {
    CaptureExclusion::Off
}

/// 所有 overlay 窗口句柄。垫片恒空。
pub fn hwnds() -> Vec<isize> {
    Vec::new()
}

/// 显示类 overlay（状态胶囊 / 微光）窗口句柄。垫片恒空。
pub fn display_hwnds() -> Vec<isize> {
    Vec::new()
}

/// 恒 false：垫片没有窗口可显示。
pub fn visible() -> bool {
    false
}

/// 垫片的窗口诊断。恒为空对象。
pub fn diagnostics() -> serde_json::Value {
    serde_json::json!({
        "ported": false,
        "reason": "overlay is out of scope for the first milestone (plan §2/§9)",
        "windows": 0,
    })
}

/// 空操作：垫片没有窗口要设显示亲和性。返回 false 表示「什么都没排除」。
pub fn exclude_overlay_from_capture() -> bool {
    false
}

/// 没有窗口要显示，但**不是**零语义：参考仓把租约监测的武装挂在
/// overlay 生命周期上（show → interrupt::arm，hide → interrupt::disarm），
/// 垫片把这条接线原样保留——2026-10-07 真机实证过丢它的后果：
/// ARMED 恒 false，无印章外部输入进不了 dirty 判定，租约形同虚设
/// （写面冒烟 §4：mouseDowns 计到了，armed:false 所以全部忽略）。
pub fn show() {
    crate::interrupt::arm();
}

/// 没有窗口要隐藏；参考仓只在「overlay 窗口确实不可见」时 disarm，
/// 垫片恒无窗口，该条件恒真。hide 的全部调用点都是回合/生命周期边界
/// （end_turn / interrupt / cancel / idle-exit），动作之间不会调到。
pub fn hide() {
    crate::interrupt::disarm();
}

#[cfg(test)]
mod tests {
    /// 接线回归锁：show 必须武装租约监测、hide 必须解除。
    /// 变异负控制：把 show() 里的 arm() 删掉，本测试第一断言即红
    /// （2026-10-07 实测该变异，确实红）。
    #[test]
    fn show_arms_and_hide_disarms_the_lease_monitor() {
        super::show();
        let armed = crate::interrupt::snapshot()["armed"].as_bool();
        assert_eq!(armed, Some(true), "show() must arm the lease monitor");
        super::hide();
        let armed = crate::interrupt::snapshot()["armed"].as_bool();
        assert_eq!(armed, Some(false), "hide() must disarm the lease monitor");
    }
}

/// 恒 false：没有遮罩可涂。
pub fn mask_for_capture() -> bool {
    false
}

/// 空操作。
pub fn unmask_after_capture() {}

/// 空操作：错误形状保留给主流程的 `let _ =` 丢弃。
pub fn shutdown_overlay() -> Result<(), String> {
    Ok(())
}

/// 空操作：没有合成指针要定位。
pub fn position_for(_action: &str, _x: f32, _y: f32, _press: bool) -> Result<(), String> {
    Ok(())
}

/// 空操作：垫片从不接管系统光标。
pub fn stop_system_cursor_manager() {}

/// 空操作：没有合成指针就没有缩放。
pub fn set_cursor_scale(_scale: f32) {}

/// 让 `cargo` 判定这些垫片确实被引用（`show`/`hide` 只在 main.rs 的写路径上）。
#[allow(dead_code)]
fn _assert_hwnd_type(_: Option<HWND>) {}
