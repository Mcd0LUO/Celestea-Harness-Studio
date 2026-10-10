//! Celestea 桌面 helper 的库面。stdio 可执行文件是 `src/main.rs`。
//!
//! 移植来源：参考仓 `dsh-computer-use_codex-style/helper-rs`（只读）。
//! 与参考仓的差异清单见同目录 `PORTING.md`。

pub mod app_catalog;
pub mod assist;
pub mod capture;
pub mod desktop;
pub mod dpi;
pub mod enum_windows;
pub mod images;
pub mod input;
pub mod interrupt;
/// 零操作垫片，**不是**参考仓 `src/overlay/` 的移植。见本文件头注释。
pub mod overlay;
pub mod notify;
pub mod pipe;
pub mod policy;
pub mod protocol;
pub mod state;
pub mod tools;
pub mod uia;

pub use capture::{capture_hwnd, CaptureFrame};
