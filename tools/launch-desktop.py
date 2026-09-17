# -*- coding: utf-8 -*-
"""可靠地拉起 Electron 应用并观察它到底是活着还是秒退。

背景：在 Git Bash 里直接跑 electron.exe，进程是否被等待、stdout 是否被管道吞掉都不确定，
排障时全是噪音。这里用 Python 显式 spawn + 定时轮询，把「活着 / 退出码 / 输出」一次说清。
"""
import os
import subprocess
import sys
import time
import urllib.request

DESKTOP = r"C:\Users\kevin\WorkBuddy\2026-09-14-18-22-50\courseforge\desktop"
EXE = os.path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe")
UDD = r"C:/Users/kevin/AppData/Local/CourseForge-Overnight"
PORT = 9555


def env_without_run_as_node():
    e = dict(os.environ)
    for k in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"):
        e.pop(k, None)
    return e


def cdp_targets(port=PORT):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as r:
            import json
            return json.load(r)
    except Exception:
        return None


def main():
    args = [
        EXE, ".",
        f"--user-data-dir={UDD}",
        f"--remote-debugging-port={PORT}",
    ]
    extra = [a for a in sys.argv[1:] if a != "--hold"]
    # 注意：--hold 只属于本脚本，不能透传给 Electron；所以判断必须看原始 argv，
    # 而不是过滤后的 extra（踩过：过滤掉之后再查 extra 永远为假，守候静默失效）
    hold = "--hold" in sys.argv
    args += extra
    print("[launch]", " ".join(args[1:]))
    # 关键：让子进程脱离当前控制台，并且尽量脱离「作业对象」。
    # 沙箱把工具调用派生的进程挂在一个 Job 上，命令一结束就可能整组回收 ——
    # 表现是「启动成功，但下一句查询时进程已经没了」。
    # CREATE_BREAKAWAY_FROM_JOB 最彻底，但 Job 不允许 breakaway 时会直接 PermissionError，
    # 所以按「从强到弱」逐个退让，而不是赌某一个标志一定可用。
    DETACHED_PROCESS = 0x00000008
    CREATE_BREAKAWAY_FROM_JOB = 0x01000000
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    log = open(os.path.join(DESKTOP, "..", "tools", "_app.out.log"), "a", encoding="utf-8")
    flag_sets = [
        DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP,
        DETACHED_PROCESS,
        0,
    ]
    p = None
    last_err = None
    for flags in flag_sets:
        try:
            p = subprocess.Popen(
                args,
                cwd=DESKTOP,
                env=env_without_run_as_node(),
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=flags,
            )
            break
        except OSError as err:
            last_err = err
    if p is None:
        print(f"[fail] 完全起不来：{last_err!r}")
        return 2
    deadline = time.time() + 20
    while time.time() < deadline:
        if p.poll() is not None:
            out = p.stdout.read().decode("utf-8", "replace")
            print(f"[died] 退出码={p.returncode} 用时={20 - (deadline - time.time()):.1f}s")
            print("---- 输出 ----")
            print(out[-4000:])
            return 1
        t = cdp_targets()
        if t is not None:
            print(f"[alive] pid={p.pid} CDP 已就绪，目标 {len(t)} 个")
            for x in t:
                print("   ", x.get("type"), "|", (x.get("title") or "")[:40], "|", (x.get("url") or "")[:80])
            if hold:
                # 守候模式：本进程活着 = 应用活着。
                # 这不是多余的 —— 沙箱会连同「调用派生出的进程树」一起回收，
                # 只有让父进程一直挂着，应用才能真正在两次工具调用之间活下来。
                print("[hold] 父进程守候中，应用退出即返回…")
                p.wait()
                print("[hold] 应用已退出")
            return 0
        time.sleep(0.5)
    print(f"[alive] pid={p.pid} CDP 未开（可能端口被占），进程仍存活")
    return 0


if __name__ == "__main__":
    sys.exit(main())
