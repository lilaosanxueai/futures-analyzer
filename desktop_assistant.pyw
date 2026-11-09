# -*- coding: utf-8 -*-
"""散户之盾 · 桌面小助手 v2——置顶迷你窗，重视觉层级与可读性"""
import json
import tkinter as tk
import urllib.request
import webbrowser
from datetime import datetime

BASE = "http://127.0.0.1:8300"
REFRESH_MS = 8000

# 色板
BG = "#0d1117"          # 主背景
BG_CARD = "#161b22"     # 卡片背景
BG_TITLE = "#1a2332"    # 标题栏
FG_MAIN = "#e6edf3"     # 主文字
FG_SUB = "#8b949e"      # 次要文字
FG_DIM = "#484f58"      # 极淡文字
ACCENT = "#58a6ff"      # 强调色
UP = "#f85149"          # 涨(红)
DOWN = "#3fb950"        # 跌(绿)
WARN = "#d29922"        # 警告

FONT = "Microsoft YaHei UI"
FONT_MONO = "Cascadia Code"


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
        self.root.geometry("340x280+30+50")
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.96)
        self.root.configure(bg=BG)
        self.root.minsize(320, 240)
        self._drag = None
        self._alert_mode = False
        self._alert_text = ""
        self._flash_on = False
        self._flash_count = 0

        self._build_title()
        self._build_body()
        self._build_footer()

        self.root.after(500, self.tick)

    def _build_title(self):
        bar = tk.Frame(self.root, bg=BG_TITLE, cursor="fleur", height=36)
        bar.pack(fill=tk.X)
        bar.pack_propagate(False)
        bar.bind("<Button-1>", self._press)
        bar.bind("<B1-Motion>", self._drag_move)
        tk.Label(bar, text="♜", bg=BG_TITLE, fg=ACCENT,
                 font=(FONT, 14)).pack(side=tk.LEFT, padx=(12, 4), pady=4)
        tk.Label(bar, text="散户之盾", bg=BG_TITLE, fg=FG_MAIN,
                 font=(FONT, 11, "bold")).pack(side=tk.LEFT, pady=4)
        link = tk.Label(bar, text="打开", bg=BG_TITLE, fg=ACCENT, cursor="hand2",
                        font=(FONT, 9, "underline"))
        link.pack(side=tk.RIGHT, padx=12, pady=4)
        link.bind("<Button-1>", lambda e: webbrowser.open(BASE))

    def _build_body(self):
        body = tk.Frame(self.root, bg=BG)
        body.pack(fill=tk.BOTH, expand=True, padx=12, pady=8)

        # 盾状态
        self.shield_var = tk.StringVar(value="连接中…")
        tk.Label(body, textvariable=self.shield_var, bg=BG, fg=FG_SUB,
                 font=(FONT, 9), anchor="w").pack(fill=tk.X, pady=(0, 6))

        # 持仓区（主体）
        self.pos_frame = tk.Frame(body, bg=BG)
        self.pos_frame.pack(fill=tk.BOTH, expand=True)

        # 警报
        self.alert_var = tk.StringVar(value="")
        self.alert_lbl = tk.Label(body, textvariable=self.alert_var, bg=BG, fg=UP,
                                  font=(FONT, 8), anchor="w", wraplength=310, justify=tk.LEFT)
        self.alert_lbl.pack(fill=tk.X, pady=(4, 0))

    def _build_footer(self):
        self.status_var = tk.StringVar(value="--:--:--")
        tk.Label(self.root, textvariable=self.status_var, bg=BG, fg=FG_DIM,
                 font=(FONT_MONO, 8), anchor="e").pack(fill=tk.X, padx=12, pady=(0, 6))

    # ---- 拖动 ----
    def _press(self, e):
        self._drag = (e.x, e.y)

    def _drag_move(self, e):
        if self._drag:
            self.root.geometry(f"+{self.root.winfo_x() + e.x - self._drag[0]}+{self.root.winfo_y() + e.y - self._drag[1]}")

    # ---- 轮询 ----
    def tick(self):
        self.refresh()
        self.root.after(REFRESH_MS, self.tick)

    def refresh(self):
        self.status_var.set(datetime.now().strftime("%H:%M:%S"))
        s = api("/api/shield")

        # ★ 高危检测：查事件流有无 fatal 级 + 盾状态
        ss = api("/api/shield-state")
        ev = api("/api/monitor/events?limit=3")
        has_fatal = False
        fatal_text = ""
        if ev:
            items = ev.get("events") or ev.get("items") or []
            for it in items:
                if it.get("level") == "fatal":
                    has_fatal = True
                    fatal_text = str(it.get("text", ""))[:50]
                    break
        # 有持仓+有fatal → 闪红
        pos_count = (ss or {}).get("active_positions", 0)
        if has_fatal and pos_count > 0:
            self._alert_mode = True
            self._alert_text = fatal_text
        else:
            self._alert_mode = False

        if not s:
            self.shield_var.set("⚠ 服务离线")
            self.root.configure(bg="#2d1110")
        elif self._alert_mode:
            self.shield_var.set("🔴 " + (self._alert_text or "高危警报"))
            self._flash()
        else:
            self.shield_var.set(
                f"🛡 拦截 {s.get('blocked_today', 0)} · 违规 {s.get('forced_today', 0)}"
                f" · 连胜 {s.get('streak', 0)} 天")
            self.root.configure(bg=BG)
            self._flash_on = False

        for w in self.pos_frame.winfo_children():
            w.destroy()

        # 优先：持仓建议
        adv = api("/api/position-advice")
        if adv and adv.get("positions"):
            for p in adv["positions"][:3]:
                self._render_pos_card(p)
            return

        # 备选：镜像/手动持仓
        t = api("/api/trades?source=real")
        if t:
            opens = [x for x in t.get("items", [])
                     if x.get("status") == "open" and x.get("source") in (None, "", "ths-sync")]
            if opens:
                for o in opens[:3]:
                    self._render_simple_pos(o)
                return

        # 空仓
        self._render_empty()

    def _render_pos_card(self, p):
        hColor = {"healthy": DOWN, "danger": UP, "caution": WARN}.get(p["health"], FG_SUB)
        pnl = p.get("float_pnl") or 0
        pnlColor = UP if pnl > 0 else (DOWN if pnl < 0 else FG_SUB)
        actionColor = UP if ("平" in p["action"] or "减" in p["action"]) else (DOWN if "增" in p["action"] else WARN)

        card = tk.Frame(self.pos_frame, bg=BG_CARD)
        card.pack(fill=tk.X, pady=(0, 6))
        # 色条
        tk.Frame(card, width=4, bg=hColor).pack(side=tk.LEFT, fill=tk.Y)

        inner = tk.Frame(card, bg=BG_CARD)
        inner.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10, pady=8)

        # 行1: 品种 + 浮盈
        r1 = tk.Frame(inner, bg=BG_CARD)
        r1.pack(fill=tk.X)
        tk.Label(r1, text=f"{p['symbol']}  {'多' if p['direction']=='long' else '空'}  {p['lots']}手",
                 bg=BG_CARD, fg=FG_MAIN, font=(FONT, 12, "bold")).pack(side=tk.LEFT)
        tk.Label(r1, text=f"@{p['entry']}", bg=BG_CARD, fg=FG_SUB,
                 font=(FONT, 9)).pack(side=tk.LEFT, padx=(4, 0), pady=(2, 0))
        tk.Label(r1, text=f"{pnl:+.0f}点", bg=BG_CARD, fg=pnlColor,
                 font=(FONT, 16, "bold")).pack(side=tk.RIGHT)

        # 行2: 健康 + 操作
        r2 = tk.Frame(inner, bg=BG_CARD)
        r2.pack(fill=tk.X, pady=(4, 0))
        tk.Label(r2, text=p["health_txt"], bg=BG_CARD, fg=hColor,
                 font=(FONT, 9, "bold")).pack(side=tk.LEFT)
        tk.Label(r2, text=f"· {p['action']}", bg=BG_CARD, fg=actionColor,
                 font=(FONT, 10, "bold")).pack(side=tk.LEFT, padx=(6, 0))

        # 行3: 点位
        r3 = tk.Frame(inner, bg=BG_CARD)
        r3.pack(fill=tk.X, pady=(2, 0))
        tk.Label(r3, text=f"止损 {p['stop_price']}", bg=BG_CARD, fg=UP,
                 font=(FONT_MONO, 9)).pack(side=tk.LEFT)
        tk.Label(r3, text=f"  目标 {p['target_price']}", bg=BG_CARD, fg=DOWN,
                 font=(FONT_MONO, 9)).pack(side=tk.LEFT)

    def _render_simple_pos(self, o):
        live = o.get("live") or {}
        pnl = live.get("pnl_pts")
        color = UP if (pnl or 0) > 0 else DOWN
        row = tk.Frame(self.pos_frame, bg=BG_CARD)
        row.pack(fill=tk.X, pady=(0, 4))
        tk.Frame(row, width=4, bg=FG_DIM).pack(side=tk.LEFT, fill=tk.Y)
        inner = tk.Frame(row, bg=BG_CARD)
        inner.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10, pady=6)
        r1 = tk.Frame(inner, bg=BG_CARD)
        r1.pack(fill=tk.X)
        src = "🪞" if o.get("source") == "ths-sync" else "👤"
        tk.Label(r1, text=f"{src} {o['symbol']} {'多' if o['direction']=='long' else '空'} {o.get('lots',1)}手 @{o.get('entry')}",
                 bg=BG_CARD, fg=FG_MAIN, font=(FONT, 11)).pack(side=tk.LEFT)
        tk.Label(r1, text=(f"{pnl:+.1f}点" if pnl is not None else "--"),
                 bg=BG_CARD, fg=color, font=(FONT, 13, "bold")).pack(side=tk.RIGHT)

    def _render_empty(self):
        box = tk.Frame(self.pos_frame, bg=BG_CARD)
        box.pack(fill=tk.BOTH, expand=True, pady=(10, 0))
        tk.Label(box, text="📭", bg=BG_CARD, fg=FG_DIM,
                 font=(FONT, 24)).pack(pady=(16, 4))
        tk.Label(box, text="当前无持仓", bg=BG_CARD, fg=FG_SUB,
                 font=(FONT, 10)).pack()
        tk.Label(box, text="开仓后自动显示操作建议", bg=BG_CARD, fg=FG_DIM,
                 font=(FONT, 8)).pack(pady=(2, 12))

    def _flash(self):
        """高危模式：窗口红/暗交替闪烁"""
        self._flash_count += 1
        self._flash_on = not self._flash_on
        color = "#5d1116" if self._flash_on else "#2d0508"
        self.root.configure(bg=color)
        # 同时更新子元素背景
        for w in self.root.winfo_children():
            try:
                w.configure(bg=color)
                for c in w.winfo_children():
                    c.configure(bg=color)
                    for gc in c.winfo_children():
                        gc.configure(bg=color)
            except tk.TclError:
                pass
        # 500ms 后下一闪（最多持续到下次 refresh）
        if self._alert_mode and self._flash_count < 16:
            self.root.after(500, self._flash)
        else:
            self._flash_count = 0

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    Assistant().run()
