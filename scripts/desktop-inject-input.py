#!/usr/bin/env python3
"""scripts/desktop-inject-input.py — 无印章外部输入注入器（租约自动化验收的「真人之手」）。

为什么需要它：helper 的租约靠 dwExtraInfo 印章区分「自己注入的」与「外部输入」
（PORTING.md §7.7：LLMHF_INJECTED 标志在 RDP/VM 下会误标真人输入，不能用作判据，
所以唯一判据是印章）。本脚本用 ctypes 直接调 SendInput，dwExtraInfo 保持默认 0
（**不盖章**），对 helper 而言与真人敲键盘/点鼠标不可区分——这就是自动化租约
测试里替代「真人的手」的东西。

⚠️ 它会真的向前台窗口发键鼠。只许对准测试夹具自己开的窗口。

用法：
  python scripts/desktop-inject-input.py mouse <x> <y>   # 屏幕绝对坐标左键单击
  python scripts/desktop-inject-input.py text <string>   # 向前台窗口逐字符键入（UNICODE 路径）
退出码：0 = SendInput 全数发出；1 = 参数错误；2 = SendInput 部分/全部失败。
"""
import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class MouseInput(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),  # 默认 0 = 无印章，对 helper 即「真人」
    ]


class KeybdInput(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),  # 默认 0 = 无印章
    ]


class InputUnion(ctypes.Union):
    _fields_ = [("mi", MouseInput), ("ki", KeybdInput)]


class Input(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("ii", InputUnion)]


def send(*inputs):
    arr = (Input * len(inputs))(*inputs)
    sent = user32.SendInput(len(arr), arr, ctypes.sizeof(Input))
    return sent


def click_at(x, y):
    if not user32.SetCursorPos(x, y):
        print(f"SetCursorPos({x},{y}) failed", file=sys.stderr)
        return 0
    down = Input(type=INPUT_MOUSE, ii=InputUnion(mi=MouseInput(0, 0, 0, MOUSEEVENTF_LEFTDOWN, 0, 0)))
    up = Input(type=INPUT_MOUSE, ii=InputUnion(mi=MouseInput(0, 0, 0, MOUSEEVENTF_LEFTUP, 0, 0)))
    return send(down, up)


def type_text(text):
    events = []
    for ch in text:
        code = ord(ch)
        events.append(Input(type=INPUT_KEYBOARD, ii=InputUnion(ki=KeybdInput(0, code, KEYEVENTF_UNICODE, 0, 0))))
        events.append(Input(type=INPUT_KEYBOARD, ii=InputUnion(ki=KeybdInput(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0))))
    return send(*events)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    mode = sys.argv[1]
    time.sleep(0.2)  # 给调用方一点把窗口摆到前台的时间
    if mode == "mouse" and len(sys.argv) == 4:
        x, y = int(sys.argv[2]), int(sys.argv[3])
        sent = click_at(x, y)
        print(f"mouse click at ({x},{y}): SendInput sent {sent}/2, dwExtraInfo=0 (unstamped)")
        return 0 if sent == 2 else 2
    if mode == "text" and len(sys.argv) == 3:
        text = sys.argv[2]
        sent = type_text(text)
        print(f"typed {len(text)} char(s) {text!r}: SendInput sent {sent}/{len(text) * 2}, dwExtraInfo=0 (unstamped)")
        return 0 if sent == len(text) * 2 else 2
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
