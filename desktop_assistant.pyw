# -*- coding: utf-8 -*-
"""散户之盾 · 桌面小助手——置顶迷你窗：持仓浮盈/操作建议/盾状态/警报，8秒自刷。"""
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
        self.root.geometry("320x240+40+60")
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.94)
        self.root.configure(bg="#14161c")
        self.root.minsize(300, 200)
        self._drag = None

        title = tk.Frame(self.root, bg="#1d2fee", cursor="fleur")
        title.pack(fill=tk.X)
        title.bind("<Button-1>", self._press)
        title.bind("<B1-Motion>", self._drag_move)
        tk.Label(title, text="♜ 散户之盾", bg="#1d2fee", fg="white",
                 font=("Microsoft YaHei UI", 10, "bold")).pack(side=tk.LEFT, padx=8, pady=3)
        tk.Label(title, text="↗ 主界面", bg="#1d2fee", fg="#cdd3ff", cursor="hand2",
                 font=("Microsoft YaHei UI", 9)).pack(side=tk.RIGHT, padx=8)
        for w in title.winfo_children():
            if w.cget("text") == "↗ 主界面":
                w.bind("<Button-1>", lambda e: webbrowser.open(BASE))

        self.shield_var = tk.StringVar(value="🛡 连接中…")
        tk.Label(self.root, textvariable=self.shield_var, bg="#14161c", fg="#aab2c4",
                 font=("Microsoft YaHei UI", 9), anchor="w").pack(fill=tk.X, padx=10, pady=(6, 0))

        # 持仓建议区（主区域）
        self.pos_frame = tk.Frame(self.root, bg="#14161c")
        self.pos_frame.pack(fill=tk.BOTH, expand=True, padx=10)

        self.alert_var = tk.StringVar(value="")
        self.alert_lbl = tk.Label(self.root, textvariable=self.alert_var, bg="#14161c", fg="#f34e4e",
                                  font=("Microsoft YaHei UI", 8), anchor="w", wraplength=300, justify=tk.LEFT)
        self.alert_lbl.pack(fill=tk.X, padx=10, pady=(2, 0))

        self.status_var = tk.StringVar(value="--:--:--")
        tk.Label(self.root, textvariable=self.status_var, bg="#14161c", fg="#4b5563",
                 font=("Consolas", 8), anchor="e").pack(fill=tk.X, padx=10, pady=(0, 4))

        self.root.after(500, self.tick)

    _press = None

    def _press(self, e):
        self._drag = (e.x, e.y)

    def _drag_move(self, e):
        if self._drag:
            x = self.root.winfo_x() + e.x - self._drag[0]
            y = self.root.winfo_y() + e.y - self._drag[1]
            self.root.geometry(f"+{x}+{y}")

    def tick(self):
        self.refresh()
        self.root.after(REFRESH_MS, self.tick)

    def refresh(self):
        self.status_var.set(datetime.now().strftime("%H:%M:%S"))
        s = api("/api/shield")
        if not s:
            self.shield_var.set("🛡 服务离线")
            self.root.configure(bg="#14161c")
        else:
            self.shield_var.set(
                f"🛡 拦截 {s.get('blocked_today', 0)} · 违规 {s.get('forced_today', 0)}"
                f" · 连胜 {s.get('streak', 0)} 天")

        # 持仓建议（优先展示）
        for w in self.pos_frame.winfo_children():
            w.destroy()
        adv = api("/api/position-advice")
        if adv and adv.get("positions"):
            for p in adv["positions"][:3]:
                hColor = {"healthy": "#22c55e", "danger": "#f34e4e", "caution": "#f59e0b"}.get(p["health"], "#6b7280")
                pnl = p.get("float_pnl") or 0
                pnlColor = "#f34e4e" if pnl > 0 else ("#22c55e" if pnl < 0 else "#6b7280")
                row = tk.Frame(self.pos_frame, bg="#1a1d25")
                row.pack(fill=tk.X, pady=2)
                # 左边条
                tk.Frame(row, width=3, bg=hColor).pack(side=tk.LEFT, fill=tk.Y)
                info = tk.Frame(row, bg="#1a1d25")
                info.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=6, pady=4)
                l1 = tk.Frame(info, bg="#1a1d25")
                l1.pack(fill=tk.X)
                tk.Label(l1, text=f"{p['symbol']} {'多' if p['direction']=='long' else '空'} {p['lots']}手 @{p['entry']}",
                         bg="#1a1d25", fg="#d1d5db", font=("Microsoft YaHei UI", 9, "bold")).pack(side=tk.LEFT)
                tk.Label(l1, text=f"{pnl:+.0f}点", bg="#1a1d25", fg=pnlColor,
                         font=("Microsoft YaHei UI", 10, "bold")).pack(side=tk.RIGHT)
                l2 = tk.Frame(info, bg="#1a1d25")
                l2.pack(fill=tk.X)
                actionColor = "#f34e4e" if ("平" in p["action"] or "减" in p["action"]) else ("#22c55e" if "增" in p["action"] else "#f59e0b")
                tk.Label(l2, text=f"{p['health_txt']} · {p['action']}",
                         bg="#1a1d25", fg=hColor, font=("Microsoft YaHei UI", 8, "bold")).pack(side=tk.LEFT)
                tk.Label(l2, text=f"损{p['stop_price']} 目{p['target_price']}",
                         bg="#1a1d25", fg="#6b7280", font=("Microsoft YaHei UI", 8)).pack(side=tk.RIGHT)
        else:
            t = api("/api/trades?source=real")
            if t:
                opens = [x for x in t.get("items", []) if x.get("status") == "open" and x.get("source") in (None, "", "ths-sync")]
                if opens:
                    for o in opens[:3]:
                        live = o.get("live") or {}
                        pnl = live.get("pnl_pts")
                        color = "#f34e4e" if (pnl or 0) > 0 else "#22c55e"
                        row = tk.Frame(self.pos_frame, bg="#14161c")
                        row.pack(fill=tk.X)
                        src = "🪞" if o.get("source") == "ths-sync" else "👤"
                        tk.Label(row, text=f"{src} {o['symbol']} {'多' if o['direction']=='long' else '空'} {o.get('lots',1)}手 @{o.get('entry')}",
                                 bg="#14161c", fg="#d1d5db", font=("Microsoft YaHei UI", 9)).pack(side=tk.LEFT)
                        tk.Label(row, text=(f"{pnl:+.1f}" if pnl is not None else "--"),
                                 bg="#14161c", fg=color, font=("Microsoft YaHei UI", 9, "bold")).pack(side=tk.RIGHT)
                else:
                    tk.Label(self.pos_frame, text="（空仓）", bg="#14161c", fg="#4b5563",
                             font=("Microsoft YaHei UI", 9)).pack(anchor="w")

        ev = api("/api/monitor/events?limit=1")
        if ev:
            items = ev.get("items") or ev.get("events") or []
            if items:
                it = items[0]
                self.alert_var.set("⚡ " + str(it.get("text", ""))[:60])
                self.root.configure(bg="#3d1112" if it.get("level") == "fatal" else "#14161c")
            else:
                self.alert_var.set("")

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    Assistant().run()
