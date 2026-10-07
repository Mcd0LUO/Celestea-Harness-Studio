//! Per-monitor DPI awareness (official `src/dpi.rs`).

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

pub fn enable() {
    unsafe {
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_ok() {
            return;
        }
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
    }
}

pub fn window_dpi(hwnd: HWND) -> u32 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        96
    } else {
        dpi
    }
}

pub fn dpi_scale(dpi: u32) -> f64 {
    let dpi = if dpi == 0 { 96 } else { dpi };
    dpi as f64 / 96.0
}

pub fn scaled_size(width: i32, height: i32, dpi: u32) -> (i32, i32) {
    let scale = dpi_scale(dpi);
    (
        (width as f64 / scale).round() as i32,
        (height as f64 / scale).round() as i32,
    )
}

pub fn logical_to_physical(x: f64, y: f64, origin_x: f64, origin_y: f64, scale: f64) -> (f64, f64) {
    let scale = if scale > 0.01 { scale } else { 1.0 };
    (origin_x + x * scale, origin_y + y * scale)
}

pub fn physical_to_logical(x: f64, y: f64, origin_x: f64, origin_y: f64, scale: f64) -> (f64, f64) {
    let scale = if scale > 0.01 { scale } else { 1.0 };
    ((x - origin_x) / scale, (y - origin_y) / scale)
}

pub fn physical_size_to_logical(width: f64, height: f64, scale: f64) -> (f64, f64) {
    let scale = if scale > 0.01 { scale } else { 1.0 };
    (width / scale, height / scale)
}
