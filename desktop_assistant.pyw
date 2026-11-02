# -*- coding: utf-8 -*-
"""散户之盾 · 桌面小助手——置顶迷你窗：持仓浮盈/盾状态/最新警报，8 秒自刷。
零第三方依赖（tkinter+urllib），双击 desktop_assistant.bat 启动。"""
import json
import tkinter as tk
import urllib.request
import webbrowser
from datetime import datetime

BASE = "http://127.0.0.1:8300"
REFRESH_MS = 8000


def api(path, timeout=6):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


class Assistant:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("散户之盾")
        self.root.geometry("300x210+40+60")
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.94)
        self.root.configure(bg="#14161c")
        self.root.minsize(280, 170)
        self._drag = None

        title = tk.Frame(self.root, bg="#1d2fee", cursor="fleur")
        title.pack(fill=tk.X)
        title.bind("<Button-1>", self._press)
        title.bind("<B1-Motion>", self._drag_move)
        tk.Label(title, text="♜ 散户之盾 · 实时", bg="#1d2fee", fg="white",
                 font=("Microsoft YaHei UI", 10, "bold")).pack(side=tk.LEFT, padx=8, pady=3)
        tk.Label(title, text="↗ 主界面", bg="#1d2fee", fg="#cdd3ff", cursor="hand2",
                 font=("Microsoft YaHei UI", 9)).pack(side=tk.RIGHT, padx=8)
        title.children[list(title.children)[-1]].bind("<Button-1>", lambda e: webbrowser.open(BASE))

        self.shield_var = tk.StringVar(value="🛡 连接中…")
        tk.Label(self.root, textvariable=self.shield_var, bg="#14161c", fg="#aab2c4",
                 font=("Microsoft YaHei UI", 9), anchor="w").pack(fill=tk.X, padx=10, pady=(6, 0))

        self.pos_hdr = tk.Label(self.root, text="持仓（镜像/手动）", bg="#14161c", fg="#6b7280",
                                font=("Microsoft YaHei UI", 8), anchor="w")
        self.pos_hdr.pack(fill=tk.X, padx=10)
        self.pos_frame = tk.Frame(self.root, bg="#14161c")
        self.pos_frame.pack(fill=tk.BOTH, expand=True, padx=10)

        self.alert_var = tk.StringVar(value="")
        self.alert_lbl = tk.Label(self.root, textvariable=self.alert_var, bg="#14161c", fg="#f34e4e",
                                  font=("Microsoft YaHei UI", 8), anchor="w", wraplength=280, justify=tk.LEFT)
        self.alert_lbl.pack(fill=tk.X, padx=10, pady=(2, 0))

        self.status_var = tk.StringVar(value="--:--:--")
        tk.Label(self.root, textvariable=self.status_var, bg="#14161c", fg="#4b5563",
                 font=("Consolas", 8), anchor="e").pack(fill=tk.X, padx=10, pady=(0, 4))

        self.root.after(500, self.tick)

    # ---- 拖动 ----
    def _press(self, e):
        self._drag = (e.x, e.y)

    def _drag_move(self, e):
        if self._drag:
            x = self.root.winfo_x() + e.x - self._drag[0]
            y = self.root.winfo_y() + e.y - self._drag[1]
            self.root.geometry(f"+{x}+{y}")

    # ---- 轮询 ----
    def tick(self):
        self.refresh()
        self.root.after(REFRESH_MS, self.tick)

    def refresh(self):
        self.status_var.set(datetime.now().strftime("%H:%M:%S"))
        s = api("/api/shield")
        if not s:
            self.shield_var.set("🛡 服务离线（守护会自动拉起）")
            self.root.configure(bg="#14161c")
        else:
            self.shield_var.set(
                f"🛡 今日拦截 {s.get('blocked_today', 0)} · 强行违规 {s.get('forced_today', 0)}"
                f" · 纪律连胜 {s.get('streak', 0)} 天")

        t = api("/api/trades?source=real")
        for w in self.pos_frame.winfo_children():
            w.destroy()
        if t:
            opens = [x for x in t.get("items", [])
                     if x.get("status") == "open" and x.get("source") in (None, "", "ths-sync")]
            if not opens:
                tk.Label(self.pos_frame, text="（空仓）", bg="#14161c", fg="#4b5563",
                         font=("Microsoft YaHei UI", 9)).pack(anchor="w")
            for o in opens[:6]:
                live = o.get("live") or {}
                pnl = live.get("pnl_pts")
                color = "#f34e4e" if (pnl or 0) > 0 else ("#22c55e" if pnl is not None and pnl < 0 else "#6b7280")
                src = "🪞" if o.get("source") == "ths-sync" else "👤"
                row = tk.Frame(self.pos_frame, bg="#14161c")
                row.pack(fill=tk.X)
                tk.Label(row, text=f"{src} {o['symbol']} {'多' if o['direction']=='long' else '空'} "
                                   f"{o.get('lots',1)}手 @{o.get('entry')}",
                         bg="#14161c", fg="#d1d5db", font=("Microsoft YaHei UI", 9)).pack(side=tk.LEFT)
                tk.Label(row, text=(f"{pnl:+.1f}点" if pnl is not None else "--"),
                         bg="#14161c", fg=color, font=("Microsoft YaHei UI", 9, "bold")).pack(side=tk.RIGHT)

        ev = api("/api/monitor/events?limit=1")
        if ev:
            items = ev.get("items") or ev.get("events") or []
            if items:
                it = items[0]
                self.alert_var.set("⚡ " + str(it.get("text", ""))[:60])
                lvl = it.get("level", "")
                self.root.configure(bg="#3d1112" if lvl == "fatal" else "#14161c")
            else:
                self.alert_var.set("")

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    Assistant().run()
