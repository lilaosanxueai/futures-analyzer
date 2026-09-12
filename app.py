"""期货实时分析助手 - 后端服务

数据来源：AkShare（新浪财经），免费、约 3~5 秒延迟，仅供研究参考。
AI 对话：转发到 OpenAI 兼容接口（智谱 GLM / DeepSeek），API Key 保存在本机 config.json。
"""

import asyncio
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, time as dtime
from functools import partial
from pathlib import Path
from typing import Optional

import akshare as ak
import httpx
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from indicators import compute_indicators, detect_signals, latest_values

try:
    from pypinyin import Style, lazy_pinyin

    def _py_initials(name: str) -> str:
        return "".join(lazy_pinyin(name, style=Style.FIRST_LETTER))

    def _py_full(name: str) -> str:
        return "".join(lazy_pinyin(name))
except ImportError:  # 未安装 pypinyin 时拼音搜索自动降级
    def _py_initials(name: str) -> str:
        return ""

    def _py_full(name: str) -> str:
        return ""

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"

PROVIDERS = {
    "zhipu": {
        "label": "智谱 GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "default_model": "glm-4-flash",
    },
    "deepseek": {
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "default_model": "deepseek-flash",  # 2026-09 平台目录：仅剩 deepseek-flash / deepseek-v4-pro
    },
    "custom": {
        "label": "自定义 / Coding Plan",
        "base_url": "",  # 由设置页填写（Coding Plan 等 OpenAI 兼容端点）
        "default_model": "glm-5",    },
}


def provider_base_url(cfg: dict, provider: str) -> str:
    """自定义服务商的接口地址从配置读取；返回空串由调用方统一报错"""
    if provider == "custom":
        return str(cfg.get("custom_base_url") or "").strip().rstrip("/")
    return PROVIDERS[provider]["base_url"]


_PROVIDER_HARD_CODES = (401, 402, 429)  # 认证/欠费/限流——换服务商可解，触发兜底

# 熔断降级：连续 2 次硬错误的服务商 10 分钟内排到候选末尾（仍可兜底，不再每次先撞墙）
_provider_health: dict[str, dict] = {}


def _note_provider_fail(provider: str) -> None:
    import time as _t
    h = _provider_health.setdefault(provider, {"fails": 0, "until": 0.0})
    h["fails"] += 1
    if h["fails"] >= 2:
        h["until"] = _t.monotonic() + 600


def _note_provider_ok(provider: str) -> None:
    _provider_health.pop(provider, None)


def _provider_demoted(provider: str) -> bool:
    import time as _t
    h = _provider_health.get(provider)
    return bool(h and h["until"] > _t.monotonic())


def _is_provider_hard_error(resp) -> bool:
    if getattr(resp, "status_code", 0) in _PROVIDER_HARD_CODES:
        return True
    return resp.status_code == 403 and "balance" in resp.text.lower()


def _llm_candidates(cfg: dict) -> list[dict]:
    """LLM 调用候选（含兜底）：当前服务商在前，其余已存 Key 的按序在后。
    主服务商限流/欠费时自动降级到备用（如 Coding Plan 打满 → DeepSeek），
    应用不因单一服务商停摆。兜底候选用该服务商的默认模型。"""
    active = cfg["provider"] if cfg["provider"] in PROVIDERS else "zhipu"
    out = []
    for p in [active] + [x for x in PROVIDERS if x != active]:
        key = cfg["api_keys"].get(p)
        url = provider_base_url(cfg, p)
        if not key or not url:
            continue
        model = (cfg["model"] or PROVIDERS[p]["default_model"]) if p == active else PROVIDERS[p]["default_model"]
        out.append({"provider": p, "base_url": url, "api_key": key, "model": model})
    out.sort(key=lambda c: _provider_demoted(c["provider"]))  # 稳定排序：被熔断的沉底
    return out

# 各模型最大输出 tokens（按模型名片段匹配；未知模型用默认值，超限时自动降级）
MODEL_MAX_OUTPUT = [
    ("deepseek-reasoner", 65536),
    ("deepseek", 8192),
    ("glm-5", 16384),
    ("glm-4-flash", 4095),
    ("glm-4", 4095),
    ("glm", 8192),
]
DEFAULT_MAX_OUTPUT = 8192


def max_output_for(model: str) -> int:
    m = (model or "").lower()
    for frag, v in MODEL_MAX_OUTPUT:
        if frag in m:
            return v
    return DEFAULT_MAX_OUTPUT

DEFAULT_CONFIG = {
    "provider": "zhipu",
    "model": PROVIDERS["zhipu"]["default_model"],
    "custom_base_url": "",  # 自定义服务商（Coding Plan 等）的 OpenAI 兼容端点
    "api_keys": {},  # 按服务商独立保存：{"zhipu": "...", "deepseek": "..."}
    "feishu": {},    # 飞书云文档同步：{"app_id", "app_secret", "doc_title", "doc_id"}
    "monitor": {
        "enabled": True,
        "sensitivity": 1.0,          # 阈值倍率：0.5 灵敏 / 1 标准 / 2 迟钝
        "focus": ["SC0", "AU0"],     # 重点常驻监控（原油、黄金）
    },
    # 交易纪律参数（用户按自身账户规模与承受力设定，AI 不代定）
    "discipline": {
        "account_size": 0.0,       # 账户权益（用于 ATR 头寸建议，0=未设置不计算）
        "risk_per_trade": 1.0,     # 单笔风险上限（总资金%）
        "daily_stop": 3.0,         # 日内止损线（总资金%，达到即当日停手）
        "weekly_max_trades": 5,    # 周交易次数上限
        "daily_max_trades": 3,     # 日内交易次数上限
        "min_grid_spacing": 1.5,   # 梯度建仓最小间距（%）
        "max_adds": 2,             # 同方向最大加仓次数
        "min_rr": 2.0,             # 风险收益比最低要求（盈亏比）
        "cooling_min": 30,         # 冲动后的冷静等待期（分钟）
        "universe": [],            # 自选品种池（空 = 不限制）
    },
}

# 常见主力合约乘数（每手对应吨/千克/桶等数量，用于 ATR 头寸建议）。
# 以交易所最新公布为准；未收录品种不显示建议手数。
CONTRACT_MULTIPLIER: dict[str, float] = {
    "RB": 10, "HC": 10, "I": 100, "J": 100, "JM": 60,
    "CU": 5, "AL": 5, "ZN": 5, "NI": 1, "SN": 1, "SS": 5,
    "AU": 1000, "AG": 15,
    "M": 10, "Y": 10, "P": 10, "A": 10, "B": 10, "C": 10,
    "CF": 5, "SR": 10, "AP": 10, "CJ": 5, "PK": 5,
    "TA": 5, "MA": 10, "FG": 20, "SA": 20, "UR": 20,
    "L": 5, "V": 5, "PP": 5, "EG": 10, "EB": 5,
    "FU": 10, "LU": 20, "SC": 1000, "NR": 20, "RU": 10, "SP": 10,
    "SF": 5, "SM": 5, "SI": 5,
    "IF": 300, "IH": 300, "IC": 200, "IM": 200,
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # 深拷贝默认值
    if CONFIG_FILE.exists():
        try:
            saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            cfg.update({k: saved[k] for k in cfg if k in saved and not isinstance(cfg[k], dict)})
            for k in cfg:
                if isinstance(cfg[k], dict) and isinstance(saved.get(k), dict):
                    cfg[k].update(saved[k])
            # 旧版单 key 迁移到当前 provider
            if saved.get("api_key") and not cfg["api_keys"].get(cfg["provider"]):
                cfg["api_keys"][cfg["provider"]] = saved["api_key"]
        except Exception:
            pass
    cfg.setdefault("api_keys", {})
    return cfg

# AkShare 依赖 py_mini_racer（V8 引擎），其内存分区只允许初始化一次：
# 多线程同时首次调用会直接 abort 整个进程；且 V8 实例绑定创建它的线程，
# 后续在其他线程复用会挂起。因此所有调用固定走同一个专属线程。
# 新浪接口偶发断连/无限挂起：超时或连接错误时丢弃旧线程换新线程并重试，
# 避免一个挂起的请求把串行队列整个堵死。
_AK_CALL_TIMEOUT = 18.0  # 数据接口为小 JSON，18s 不回即放弃；过长超时会占住单线程堵死队列
_AK_MAX_TRIES = 2
_AK_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="akshare")
# 数据源熔断降温：被废弃的旧线程不会死（akshare 内部请求无超时，被限速
# 就永久挂住且持续抢 GIL）——连续超时说明源已劣化，停发新请求 90s，
# 让遗留线程自然结束，避免僵尸线程把事件循环拖垮（实测整机变慢的根因）。
_ak_degrade = {"fails": 0, "until": 0.0}
_AK_DEGRADE_PAUSE = 90.0
_AK_DEGRADE_THRESHOLD = 3


async def call_ak(func, *args, **kwargs):
    global _AK_EXECUTOR
    loop = asyncio.get_running_loop()
    if loop.time() < _ak_degrade["until"]:
        raise TimeoutError("数据源限流降温中（连续超时自动暂停约 90 秒），稍后自动恢复")
    last_err = None
    for attempt in range(_AK_MAX_TRIES):
        try:
            fut = loop.run_in_executor(_AK_EXECUTOR, partial(func, *args, **kwargs))
            result = await asyncio.wait_for(fut, timeout=_AK_CALL_TIMEOUT)
            _ak_degrade["fails"] = 0
            return result
        except (asyncio.TimeoutError, OSError) as e:
            # requests 的连接类异常均继承 OSError；超时说明旧线程可能仍
            # 阻塞在网络上，弃用旧 executor 防止后续请求排死队。
            last_err = e
            _ak_degrade["fails"] += 1
            if _ak_degrade["fails"] >= _AK_DEGRADE_THRESHOLD:
                _ak_degrade["until"] = loop.time() + _AK_DEGRADE_PAUSE
                _ak_degrade["fails"] = 0
            _AK_EXECUTOR = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="akshare"
            )
            if attempt + 1 < _AK_MAX_TRIES:
                await asyncio.sleep(1.0 + attempt)
    raise last_err


async def _warmup():
    try:
        await call_ak(ak.futures_zh_spot, symbol="RB0", market="CF", adjust="0")
        await call_ak(ak.futures_zh_daily_sina, symbol="RB0")
        await call_ak(ak.futures_display_main_sina)
    except Exception:
        pass  # 预热失败不影响服务：后续请求会自行重试并完成初始化


@asynccontextmanager
async def lifespan(_app):
    # 预热放后台：不阻塞端口绑定，页面可立即打开（数据请求在专属
    # 线程串行排队，预热只是提前热身，V8 初始化的串行性由 executor 保证）
    warmup_task = asyncio.create_task(_warmup())
    monitor_task = asyncio.create_task(monitor_loop())
    trail_task = asyncio.create_task(trail_loop())
    news_watch_task = asyncio.create_task(news_watch_loop())
    radar_task = asyncio.create_task(radar_loop())
    report_task = asyncio.create_task(report_push_loop())
    selfcheck_task = asyncio.create_task(selfcheck_loop())
    yield
    warmup_task.cancel()
    monitor_task.cancel()
    trail_task.cancel()
    news_watch_task.cancel()
    radar_task.cancel()
    report_task.cancel()
    selfcheck_task.cancel()

app = FastAPI(title="期货实时分析助手", lifespan=lifespan)

# ---------------------------------------------------------------- 配置


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- 行情

QUOTE_TTL = 5.0        # 单合约行情缓存（秒），与前端轮询周期一致
DIR_TTL = 3600.0       # 合约目录缓存（秒）
DIR_FAIL_BACKOFF = 300.0  # 目录拉取失败后的重试退避（秒）
DAILY_TTL = 60.0            # 日线缓存（秒），交易时段内的新数据
DAILY_TTL_CLOSED = 1800.0   # 已收盘的日线缓存（秒）：最后交易日早于今天则数据不再变化
INTRADAY_TTL = 30.0    # 分钟线缓存（秒）

_quote_cache: dict[str, tuple[float, dict]] = {}
_dir_cache: dict = {"ts": 0.0, "data": {}, "fail_ts": 0.0}
_daily_cache: dict[str, tuple[float, list]] = {}
_minute_cache: dict[tuple, tuple[float, list]] = {}
_intraday_cache: dict[str, tuple[float, dict]] = {}

# 中金所品种前缀（IF/IH/IC/IM 股指，T/TF/TS/TL 国债）
_CFFEX_RE = re.compile(r"^(IF|IH|IC|IM|T|TF|TS|TL)\d")


def market_of(symbol: str) -> str:
    return "CFFEX" if _CFFEX_RE.match(symbol.upper()) else "CF"


# 国内期货夜盘收盘时间（分钟数，按品种前缀；夜盘统一 21:00 开始）。
# 三档：23:00 收盘（多数品种）/ 01:00（金属类）/ 02:30（SC 原油、AU 黄金、AG 白银）。
# 未列出的默认 23:00（若有夜盘）；None = 无夜盘。
_NIGHT_CLOSE = {
    "SC": 150, "AU": 150, "AG": 150,                     # 原油/黄金/白银 至 02:30
    "CU": 60, "AL": 60, "ZN": 60, "PB": 60, "NI": 60,    # 金属 至 01:00
    "SN": 60, "SS": 60, "BC": 60, "AO": 60,
    "AP": None, "CJ": None, "JD": None, "LH": None, "PK": None,  # 无夜盘
}


def _night_close_min(prefix: str):
    """该品种夜盘收盘（分钟数，可能跨午夜如 150=02:30）；无夜盘返回 None"""
    if prefix in _NIGHT_CLOSE:
        v = _NIGHT_CLOSE[prefix]
        return v if v is not None else None
    return 23 * 60  # 默认 23:00（有夜盘品种）


def domestic_session_active(prefix: str, now: Optional[datetime] = None) -> bool:
    """单品种国内交易时段判断：
    - 日盘（周一至周五）：9:00-10:15 / 10:30-11:30 / 13:30-15:00
    - 夜盘（周一至周五 21:00 起）：按品种 23:00 / 01:00 / 02:30 分档收盘，
      凌晨时段属前一交易日夜盘（周六凌晨=周五夜盘延续）"""
    now = now or datetime.now()
    wd, t = now.weekday(), now.time()
    nm = t.hour * 60 + t.minute

    # 日盘（周六日无）
    if wd <= 4:
        for a, b in ((dtime(9, 0), dtime(10, 15)), (dtime(10, 30), dtime(11, 30)), (dtime(13, 30), dtime(15, 0))):
            a_m, b_m = a.hour * 60 + a.minute, b.hour * 60 + b.minute
            if a_m <= nm < b_m:
                return True

    close = _night_close_min(prefix)
    if close is None:
        return False  # 无夜盘品种

    night_start = 21 * 60
    if close > night_start:
        # 不跨午夜（23:00 收盘）：周一至周五 21:00-23:00
        return wd <= 4 and night_start <= nm < close
    # 跨午夜（01:00 / 02:30 收盘）：
    #   21:00-24:00（周一开始的夜盘）或 0:00-收盘（前一交易日夜盘延续）
    if wd <= 4 and nm >= night_start:
        return True
    # 凌晨段：周六=周五夜盘延续；周二至周五=前一交易日夜盘延续
    return (nm < close) and (wd == 5 or 1 <= wd <= 4)


def is_trading_time(now: Optional[datetime] = None) -> bool:
    """国内期货总体交易时段（任一品种在交易，即夜盘最晚至 02:30）。
    供 market_open 状态展示；盯盘的分品种时段用 domestic_session_active()。"""
    now = now or datetime.now()
    wd, t = now.weekday(), now.time()
    nm = t.hour * 60 + t.minute
    if wd <= 4:
        for a, b in ((dtime(9, 0), dtime(10, 15)), (dtime(10, 30), dtime(11, 30)), (dtime(13, 30), dtime(15, 0))):
            if a.hour * 60 + a.minute <= nm < b.hour * 60 + b.minute:
                return True
        if 21 * 60 <= nm:
            return True
    # 凌晨 0:00-02:30：周六=周五夜盘延续；周二至周五=前一交易日夜盘延续
    if nm < 150 and (wd == 5 or 1 <= wd <= 4):
        return True
    return False


def _fmt_time(raw) -> str:
    s = str(raw).strip()
    if re.fullmatch(r"\d{6}", s):
        return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"
    return s


async def get_directory(max_age: float = 0.0) -> dict[str, dict]:
    """主力合约目录：symbol(如 RB0) -> {name, exchange}。
    max_age>0：缓存不老于该秒数就直接用（不刷新）——行情轮询等高频
    路径用，名称映射极少变化，绝不该为它到 V8 单线程队列里排队。"""
    loop_now = asyncio.get_event_loop().time()
    if max_age > 0 and _dir_cache["ts"] > 0 and loop_now - _dir_cache["ts"] <= max_age:
        return _dir_cache["data"]
    if loop_now - _dir_cache["ts"] > DIR_TTL:
        # 失败退避：目录拉取失败后一段时间内不再重试，避免行情轮询
        # 每 5 秒触发一次全量拉取（内部为逐品种匹配请求）轰垮数据源。
        if loop_now - _dir_cache.get("fail_ts", 0.0) < DIR_FAIL_BACKOFF:
            return _dir_cache["data"]
        try:
            df = await call_ak(ak.futures_display_main_sina)
            _dir_cache["data"] = {
                str(row["symbol"]).upper(): {
                    "name": str(row["name"]),
                    "exchange": str(row["exchange"]).upper(),
                }
                for _, row in df.iterrows()
            }
            _dir_cache["ts"] = loop_now
        except Exception as e:
            _dir_cache["fail_ts"] = loop_now
            print(
                f"[get_directory] 目录刷新失败: {type(e).__name__}: {e}",
                flush=True,
            )  # 目录刷新失败时沿用旧缓存
    return _dir_cache["data"]


# 国际品种定义：实时快照品种 ↔ 新浪外盘日线 symbol 映射（DXY 无日线历史，仅实时）
INTL_SYMBOLS = ["WTI", "BRENT", "GOLD", "DXY"]
_INTL_HIST_MAP = {"WTI": "CL", "BRENT": "OIL", "GOLD": "GC"}
_INTL_NAMES = {"WTI": "WTI 原油", "BRENT": "布伦特原油", "GOLD": "COMEX 黄金", "DXY": "美元指数"}


async def get_daily(symbol: str, max_age: float = 60.0) -> list[dict]:
    """日线数据（带缓存：收盘后基本不变，60 秒内复用）。
    国际品种（WTI/BRENT/GOLD）自动分流到新浪外盘历史接口。"""
    symbol = symbol.upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _daily_cache.get(symbol)
    if cached and loop_now - cached[0] < cached[2]:
        return cached[1]

    if symbol in _INTL_HIST_MAP:
        # 国际品种：新浪外盘日线（date/open/high/low/close/volume/position）
        df = await call_ak(ak.futures_foreign_hist, symbol=_INTL_HIST_MAP[symbol])
        records = [
            {
                "date": str(r["date"])[:10],
                "open": _num(r.get("open")),
                "high": _num(r.get("high")),
                "low": _num(r.get("low")),
                "close": _num(r.get("close")),
                "volume": _num(r.get("volume")) or 0,
                "hold": _num(r.get("position")) or 0,
                "settle": _num(r.get("settle")) or None,
            }
            for r in df.to_dict("records")
        ]
        _daily_cache[symbol] = (loop_now, records, DAILY_TTL_CLOSED)
        return records

    # 主连：用成交量主力合约的日线，与 fetch_quote 同源（否则行情与指标基于不同合约）
    dom = await _dominant_contract(symbol)
    df = await call_ak(ak.futures_zh_daily_sina, symbol=dom or symbol)
    records = df.to_dict("records")
    # 最后交易日早于今天 → 已收盘，数据不再变化，用长缓存减少对数据源的反复请求
    today = datetime.now().strftime("%Y-%m-%d")
    ttl = DAILY_TTL_CLOSED if records and str(records[-1].get("date")) < today else max_age
    _daily_cache[symbol] = (loop_now, records, ttl)
    return records


MINUTE_TTL = 30.0


async def get_minute(symbol: str, period: str) -> list[dict]:
    """分钟 K 线（标准化字段，带缓存）"""
    symbol = symbol.upper()
    key = (symbol, period)
    loop_now = asyncio.get_event_loop().time()
    cached = _minute_cache.get(key)
    if cached and loop_now - cached[0] < MINUTE_TTL:
        return cached[1]
    df = await call_ak(ak.futures_zh_minute_sina, symbol=symbol, period=period)
    rows = [
        {
            "datetime": str(r.get("datetime") or r.get("date") or ""),
            "open": _num(r.get("open")),
            "high": _num(r.get("high")),
            "low": _num(r.get("low")),
            "close": _num(r.get("close")),
            "volume": _num(r.get("volume")),
            "position": _num(r.get("hold")),
        }
        for r in df.to_dict("records")
    ]
    _minute_cache[key] = (loop_now, rows)
    return rows


def _num(v):
    try:
        f = float(v)
        return f if f == f else None  # NaN -> None
    except (TypeError, ValueError):
        return None


_HQ_CLIENT: Optional[httpx.AsyncClient] = None  # 复用连接与 SSL 上下文——每 5s 轮询新建客户端会反复
# 加载 Windows 证书库（CPU 重活），实测能把事件循环饿死


async def _hq_quote(symbol: str) -> Optional[dict]:
    """新浪 hq 国内期货快照（nf_ 前缀，商品期货字段布局；CFFEX 布局不同不支持）。
    轻量 CDN 接口 ~0.2s 且不占 AkShare V8 单线程——akshare spot 被限速时的快路径。
    字段（实测 2026-09：1时间 2开 3高 4低 6买 7卖 8最新 10昨结 11买量 12卖量 13持仓 14成交量）"""
    global _HQ_CLIENT
    if _HQ_CLIENT is None:
        _HQ_CLIENT = httpx.AsyncClient(timeout=6)
    r = await _HQ_CLIENT.get(
        "https://hq.sinajs.cn/",
        params={"list": f"nf_{symbol}"},
        headers={"Referer": "https://finance.sina.com.cn"},
    )
    txt = r.content.decode("gbk", errors="replace")
    m = re.search(r'"([^"]*)"', txt)
    if not m:
        return None
    f = m.group(1).split(",")
    if len(f) < 15:
        return None

    def n(i: int):
        try:
            v = float(f[i])
            return v if v == v else None  # NaN -> None
        except (ValueError, IndexError):
            return None

    last, prev_settle = n(8), n(10)
    if last is None:
        return None
    info = _dir_cache.get("data", {}).get(symbol, {})  # 名称用现有缓存，不为它联网
    # 具体月份合约（MA2610）不在目录里：用 hq 字段 15 的品种简称，再退静态映射
    name = info.get("name", "") or (str(f[15]).strip() if len(f) > 15 else "")
    if not name:
        name = _PREFIX_CN.get(re.match(r"^([A-Za-z]{1,2})", symbol).group(1).upper(), "") if re.match(r"^([A-Za-z]{1,2})", symbol) else ""
    change = round(last - prev_settle, 2) if prev_settle else None
    return {
        "symbol": symbol,
        "name": name,
        "exchange": info.get("exchange", ""),
        "time": _fmt_time(f[1]),
        "last": last,
        "open": n(2),
        "high": n(3),
        "low": n(4),
        "prev_settle": prev_settle,
        "change": change,
        "change_pct": round(change / prev_settle * 100, 2) if change is not None and prev_settle else None,
        "volume": n(14),
        "position": n(13),
        "bid": n(6),
        "ask": n(7),
        "bid_vol": n(11),
        "ask_vol": n(12),
        "digits": 1,
    }


# 主力合约解析：新浪连续（nf_XXX0）按**持仓量**映射，近月逼仓时与市场活跃合约
# 背离（实测甲醇 2026-09：nf_MA0→MA2701(3049)，而 MA2610 成交量大 5.6 倍(3455)）。
# 交易者看的是活跃合约，故按**成交量**重新判定，缓存 30 分钟。
_DOM_TTL = 1800.0
_dom_cache: dict[str, tuple[float, str]] = {}  # 品种前缀 -> (loop_ts, 具体合约代码)
_CFFEX_PREFIX = {"IF", "IH", "IC", "IM", "T", "TF", "TS", "TL"}


def _candidate_months(n: int = 12) -> list[str]:
    """候选月份合约 YYMM：当月起 n 个月"""
    d = datetime.now()
    y, m = d.year, d.month
    out = []
    for _ in range(n):
        out.append(f"{y % 100:02d}{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


async def _dominant_contract(symbol: str) -> Optional[str]:
    """主连代码（MA0）→ 按成交量判定的主力月份合约（MA2610）。
    非主连/中金所/查询失败返回 None（调用方维持原 symbol）。"""
    m = re.fullmatch(r"([A-Za-z]{1,2})0", symbol or "")
    if not m:
        return None
    pfx = m.group(1).upper()
    if pfx in _CFFEX_PREFIX:
        return None
    loop_now = asyncio.get_event_loop().time()
    cached = _dom_cache.get(pfx)
    if cached and loop_now - cached[0] < _DOM_TTL:
        return cached[1]
    # 原始 URL（逗号不可 URL 编码，params 方式会被新浪拒）
    url = "https://hq.sinajs.cn/list=" + ",".join(f"nf_{pfx}{mo}" for mo in _candidate_months())
    global _HQ_CLIENT
    try:
        if _HQ_CLIENT is None:
            _HQ_CLIENT = httpx.AsyncClient(timeout=6)
        r = await _HQ_CLIENT.get(url, headers={"Referer": "https://finance.sina.com.cn"})
        txt = r.content.decode("gbk", errors="replace")
    except Exception:
        return cached[1] if cached else None
    best, best_vol = None, 0.0
    for line in txt.strip().split("\n"):
        mm = re.search(r'hq_str_nf_(\w+)="([^"]*)"', line)
        if not mm or not mm.group(2):
            continue
        f = mm.group(2).split(",")
        if len(f) < 15:
            continue
        try:
            vol = float(f[14])
        except ValueError:
            continue
        if vol > best_vol:
            best, best_vol = mm.group(1), vol
    if best and best_vol > 0:
        _dom_cache[pfx] = (loop_now, best)
        return best
    return cached[1] if cached else None


async def fetch_quote(symbol: str) -> dict:
    """单合约实时行情（带 5 秒缓存）。国际品种从实时快照组装。"""
    symbol = symbol.strip().upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _quote_cache.get(symbol)
    if cached and loop_now - cached[0] < QUOTE_TTL:
        return cached[1]

    # 国际品种：从 /api/intl 快照（hf_ 实时）组装 quote
    if symbol in INTL_SYMBOLS:
        await fetch_intl()
        it = _intl_cache.get("by_sym", {}).get(symbol, {})
        if it.get("last") is None:
            raise HTTPException(status_code=502, detail="国际品种行情获取失败")
        quote = {
            "symbol": symbol,
            "name": it.get("name", _INTL_NAMES.get(symbol, "")),
            "exchange": "INTL",
            "time": it.get("time", ""),
            "last": it.get("last"),
            "open": it.get("open"),
            "high": it.get("high"),
            "low": it.get("low"),
            "prev_settle": it.get("prev_settle"),
            "change": it.get("chg"),
            "change_pct": it.get("chg_pct"),
            "volume": None,
            "position": None,
            "bid": None,
            "ask": None,
            "bid_vol": None,
            "ask_vol": None,
            "digits": 2,
        }
        _quote_cache[symbol] = (loop_now, quote)
        return quote

    # 国内商品期货：优先走新浪 hq 快路径（~0.2s、不占 V8 线程），失败退回 akshare
    if market_of(symbol) != "CFFEX":
        try:
            # 主连代码按成交量解析真实活跃合约（新浪连续按持仓量，近月逼仓时会背离）
            dom = await _dominant_contract(symbol)
            hq = await _hq_quote(dom or symbol)
            if hq:
                if dom and dom != symbol:
                    hq["symbol"] = symbol      # 对外仍用主连代码，与自选/列表一致
                    hq["contract"] = dom       # 标注实际跟踪的合约（前端可显示）
                _quote_cache[symbol] = (loop_now, hq)
                return hq
        except Exception:
            pass

    try:
        df = await call_ak(ak.futures_zh_spot, symbol=symbol, market=market_of(symbol), adjust="0")
        row = df.iloc[0].to_dict()
    except Exception as e:
        # 数据源全挂时回退最近一次成功缓存（标注 stale），绝不无声显示旧数冒充实时
        stale = _quote_cache.get(symbol)
        if stale and stale[1].get("last") is not None:
            q = dict(stale[1])
            q["stale"] = True
            q["time"] = (q.get("time") or "") + "（延迟）"
            return q
        return {"symbol": symbol, "error": f"行情获取失败：{e}"}

    directory = await get_directory(max_age=3600)  # 名称映射容忍 1h 旧缓存，行情不为目录刷新排队
    info = directory.get(symbol, {})

    last = _num(row.get("current_price"))
    open_ = _num(row.get("open"))
    high = _num(row.get("high"))
    low = _num(row.get("low"))
    volume = _num(row.get("volume"))
    position = _num(row.get("hold"))

    # 涨跌基准：昨结算；中金所 spot 接口不提供，则从日线取最近结算价兜底
    prev_settle = _num(row.get("last_settle_price")) or _num(row.get("last_close"))
    if last is not None and prev_settle is None:
        try:
            daily = await get_daily(symbol)
            today = datetime.now().strftime("%Y-%m-%d")
            prev_rows = [d for d in daily if str(d.get("date")) < today]
            if prev_rows:
                prev_settle = _num(prev_rows[-1].get("settle")) or _num(prev_rows[-1].get("close"))
        except Exception:
            pass

    change = round(last - prev_settle, 2) if last is not None and prev_settle else None
    change_pct = (
        round(change / prev_settle * 100, 2)
        if change is not None and prev_settle
        else None
    )

    quote = {
        "symbol": symbol,
        "name": info.get("name", str(row.get("symbol", ""))),
        "exchange": info.get("exchange", "CFFEX" if market_of(symbol) == "CFFEX" else ""),
        "time": _fmt_time(row.get("time", "")),
        "last": last,
        "open": open_,
        "high": high,
        "low": low,
        "prev_settle": prev_settle,
        "change": change,
        "change_pct": change_pct,
        "volume": volume,
        "position": position,
        "bid": _num(row.get("bid_price")),
        "ask": _num(row.get("ask_price")),
        "bid_vol": _num(row.get("buy_vol")),
        "ask_vol": _num(row.get("sell_vol")),
        "digits": 1,
    }
    _quote_cache[symbol] = (loop_now, quote)
    return quote


# ---------------------------------------------------------------- API：行情


@app.get("/api/main-list")
async def main_list():
    directory = await get_directory()
    items = [
        {
            "symbol": sym,
            "name": v["name"],
            "exchange": v["exchange"],
            "py": _py_initials(v["name"]),
            "pyf": _py_full(v["name"]),
        }
        for sym, v in sorted(directory.items())
    ]
    return {"ok": True, "items": items}


@app.get("/api/watchlist")
async def watchlist(symbols: str):
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:30]
    _MONITOR["watch"] = set(syms)  # 盯盘引擎自动跟随前端自选
    quotes = await asyncio.gather(*(fetch_quote(s) for s in syms))
    return {
        "ok": True,
        "ts": int(datetime.now().timestamp() * 1000),
        "market_open": is_trading_time(),
        "quotes": list(quotes),
    }


@app.get("/api/daily/{symbol}")
async def daily(symbol: str, limit: int = 30):
    try:
        records = (await get_daily(symbol))[-limit:]
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"日线数据获取失败：{e}")
    items = [
        {
            "date": str(r.get("date", "")),
            "open": _num(r.get("open")),
            "high": _num(r.get("high")),
            "low": _num(r.get("low")),
            "close": _num(r.get("close")),
            "volume": _num(r.get("volume")),
            "position": _num(r.get("hold")),
        }
        for r in records
    ]
    return {"ok": True, "items": items}


KLINE_PERIODS = {"day": None, "60m": "60", "30m": "30", "15m": "15", "5m": "5", "1m": "1"}

IND_PERIODS = {"5m": "5", "15m": "15", "30m": "30", "60m": "60"}  # 指标可用分钟周期


async def get_indicators(symbol: str, period: str = "day") -> dict:
    """技术指标 + 信号（日线或分钟级，供 API 与 AI 上下文共用）"""
    if period in IND_PERIODS:
        rows = await get_minute(symbol, IND_PERIODS[period])
        if len(rows) < 60:
            raise ValueError(f"分钟线数据不足（{len(rows)} 根），无法计算指标")
        df = pd.DataFrame([{**r, "date": r["datetime"]} for r in rows])
        label = period
    else:
        records = await get_daily(symbol)
        if len(records) < 30:
            raise ValueError(f"日线数据不足（{len(records)} 根），无法计算指标")
        df = pd.DataFrame(records)
        label = "day"
    ind = compute_indicators(df)
    return {
        "values": latest_values(ind),
        "signals": detect_signals(ind),
        "date": str(ind.iloc[-1].get("date", "")),
        "period": label,
    }


@app.get("/api/indicators/{symbol}")
async def indicators(symbol: str, period: str = "15m"):
    period = period if (period in IND_PERIODS or period == "day") else "15m"
    try:
        data = await get_indicators(symbol, period)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"指标计算失败：{e}")
    return {"ok": True, **data}


# ---------------------------------------------------------------- 资金情绪引擎（价量仓三要素）

def fund_sentiment(symbol: str, daily: list) -> Optional[dict]:
    """主力资金情绪分析：基于日线价/量/持仓三要素（持仓量=保证金占用，反映资金进出）。
    返回 {score(-100~+100), bias(倾向标签), factors(因子列表), summary(一句话)}"""
    rows = [r for r in daily[-60:] if r.get("close") and r.get("volume") is not None]
    if len(rows) < 21:
        return None
    closes = [float(r["close"]) for r in rows]
    vols = [float(r["volume"] or 0) for r in rows]
    holds = [float(r["hold"]) for r in rows if r.get("hold") is not None]
    factors = []
    score = 0.0

    # 外盘数据源无持仓量/成交量（如新浪外盘历史仅 OHLC）：降级为纯价格动量因子
    if sum(vols) == 0 or sum(holds) == 0:
        chg5 = (closes[-1] / closes[-6] - 1) * 100 if closes[-6] else 0.0
        chg20 = (closes[-1] / closes[-21] - 1) * 100 if len(closes) >= 21 and closes[-21] else 0.0
        score = max(-60, min(60, chg5 * 8 + chg20 * 3))
        if chg5 > 0:
            factors.append(f"5 日动量 +{chg5:.2f}%：短期动能向上")
        else:
            factors.append(f"5 日动量 {chg5:.2f}%：短期动能向下")
        if abs(chg20) >= 1:
            factors.append(f"20 日动量 {chg20:+.2f}%：中期趋势{'向上' if chg20 > 0 else '向下'}")
        factors.append("（外盘数据源无持仓量/成交量，资金情绪基于价格动量）")
    else:
        # ① 近 5 日价量仓配合（经典八状态，权重最大）
        win = rows[-5:]
        price_chg = (closes[-1] / closes[-6] - 1) * 100 if closes[-6] else 0.0
        hold_win = [float(r.get("hold") or 0) for r in win]
        hold_chg = (hold_win[-1] - hold_win[0]) / hold_win[0] * 100 if hold_win and hold_win[0] else 0.0
        rising = price_chg > 0
        adding = hold_chg > 0
        if adding:
            score += 30 if rising else -30
            factors.append(f"5日{'涨' if rising else '跌'}{abs(price_chg):.2f}% 且增仓 {abs(hold_chg):.1f}%：{'多头主动进攻' if rising else '空头主动施压'}（资金{'流入' if rising else '做空'}意愿强）")
        else:
            score += 10 if rising else -10
            factors.append(f"5日{'涨' if rising else '跌'}{abs(price_chg):.2f}% 但减仓 {abs(hold_chg):.1f}%：{'空头止损推动' if rising else '多头止盈离场'}（趋势持续性存疑）")

        # ② 20 日持仓趋势（中期资金流向）
        if len(holds) >= 21:
            h20 = (holds[-1] - holds[-21]) / holds[-21] * 100
            if abs(h20) >= 2:
                pts = min(20, abs(h20) * 2)
                score += pts if h20 > 0 else -pts
                factors.append(f"20 日持仓{'增' if h20 > 0 else '减'} {abs(h20):.1f}%：中期资金{'持续流入' if h20 > 0 else '逐步撤离'}")

        # ③ 量能活跃度（5 日均量 / 60 日均量）
        v5 = sum(vols[-5:]) / 5
        v60 = sum(vols[-60:]) / 60
        ratio = v5 / v60 if v60 else 1.0
        if ratio >= 1.5:
            factors.append(f"量能为 60 日均量的 {ratio:.1f} 倍：明显放量，资金关注度升温")
        elif ratio <= 0.7:
            score *= 0.7  # 缩市中信号可靠性下降，衰减评分
            factors.append(f"量能仅为 60 日均量的 {ratio:.1f} 倍：缩量观望，信号可靠性打折")

        # ④ 近 3 日持仓边际变化（最新资金转向）
        if len(holds) >= 4:
            d3 = (holds[-1] - holds[-4]) / holds[-4] * 100 if holds[-4] else 0.0
            if abs(d3) >= 1:
                score += 15 if d3 > 0 else -15
                factors.append(f"近 3 日持仓{'增' if d3 > 0 else '减'} {abs(d3):.1f}%：短线资金{'转强' if d3 > 0 else '转弱'}")

    score = max(-100, min(100, round(score)))
    if score >= 40:
        bias = "🔥 多头资金主导"
    elif score >= 15:
        bias = "📈 偏多"
    elif score <= -40:
        bias = "❄️ 空头资金主导"
    elif score <= -15:
        bias = "📉 偏空"
    else:
        bias = "⚖️ 资金分歧 / 中性"
    summary = {
        "🔥 多头资金主导": "增仓上行，主力资金积极做多",
        "📈 偏多": "价仓配合偏多，可顺势关注",
        "⚖️ 资金分歧 / 中性": "多空资金分歧或观望，方向待选择",
        "📉 偏空": "价仓配合偏空，反弹宜谨慎",
        "❄️ 空头资金主导": "增仓下行，主力资金积极做空",
    }[bias]
    return {
        "symbol": symbol,
        "score": score,
        "bias": bias,
        "factors": factors,
        "summary": summary,
    }


def _fund_text(fs: dict) -> str:
    """资金情绪转 AI 上下文文字"""
    if not fs:
        return ""
    lines = [f"资金情绪评分 {fs['score']:+d}（{fs['bias']}）—— {fs['summary']}"]
    lines += [f"- {f}" for f in fs["factors"]]
    return "\n".join(lines)


@app.get("/api/fund/{symbol}")
async def fund_api(symbol: str):
    """主力资金情绪：价量仓三要素分析"""
    symbol = symbol.upper()
    try:
        daily = await get_daily(symbol)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"日线数据获取失败：{e}")
    fs = fund_sentiment(symbol, daily)
    if not fs:
        raise HTTPException(status_code=400, detail="日线数据不足，无法分析资金情绪")
    return {"ok": True, **fs}


KLINE_PERIODS = {"day": None, "60m": "60", "30m": "30", "15m": "15", "5m": "5", "1m": "1"}


@app.get("/api/kline/{symbol}")
async def kline(symbol: str, period: str = "day", limit: int = 120):
    """K 线（蜡烛图数据）：日线或分钟线，附 MA5/10/20 与（仅日线）信号"""
    period = period if period in KLINE_PERIODS else "day"
    limit = min(max(limit, 30), 500)
    symbol = symbol.upper()
    if symbol in INTL_SYMBOLS:
        # 国际品种：新浪外盘日 K（futures_foreign_hist），分钟级暂不提供
        try:
            df = await call_ak(ak.futures_foreign_hist, symbol=symbol)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"国际K线获取失败：{e}")
        rows = [
            {"datetime": str(r.get("date") or ""), "open": _num(r.get("open")),
             "high": _num(r.get("high")), "low": _num(r.get("low")),
             "close": _num(r.get("close")), "volume": _num(r.get("volume")),
             "position": None}
            for r in df.to_dict("records")
        ][-limit:]
        if not rows:
            raise HTTPException(status_code=502, detail="国际K线数据为空")
        df2 = pd.DataFrame(rows)
        for n in (5, 10, 20):
            df2[f"ma{n}"] = df2["close"].rolling(n).mean()
        _mid = df2["close"].rolling(20).mean()
        _std = df2["close"].rolling(20).std(ddof=0)
        df2["boll_up"] = _mid + 2 * _std
        df2["boll_mid"] = _mid
        df2["boll_low"] = _mid - 2 * _std
        items = [
            {**r, "ma5": _round_ma(v) if (v := r.get("ma5")) is not None else None,
             "ma10": _round_ma(v) if (v := r.get("ma10")) is not None else None,
             "ma20": _round_ma(v) if (v := r.get("ma20")) is not None else None,
             "boll_up": _round_ma(v) if (v := r.get("boll_up")) is not None else None,
             "boll_mid": _round_ma(v) if (v := r.get("boll_mid")) is not None else None,
             "boll_low": _round_ma(v) if (v := r.get("boll_low")) is not None else None}
            for r in df2.to_dict("records")
        ]
        return {"ok": True, "period": "day", "intl": True, "items": items, "signals": []}

    try:
        if period == "day":
            raw = await get_daily(symbol)
            rows = [
                {
                    "datetime": str(r.get("date") or ""),
                    "open": _num(r.get("open")),
                    "high": _num(r.get("high")),
                    "low": _num(r.get("low")),
                    "close": _num(r.get("close")),
                    "volume": _num(r.get("volume")),
                    "position": _num(r.get("hold")),
                }
                for r in raw
            ]
        else:
            rows = await get_minute(symbol, KLINE_PERIODS[period])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"K线数据获取失败：{e}")

    rows = rows[-limit:]
    if not rows:
        raise HTTPException(status_code=502, detail="K线数据为空")
    df = pd.DataFrame(rows)
    for n in (5, 10, 20):
        df[f"ma{n}"] = df["close"].rolling(n).mean()
    _mid = df["close"].rolling(20).mean()
    _std = df["close"].rolling(20).std(ddof=0)
    df["boll_up"] = _mid + 2 * _std
    df["boll_mid"] = _mid
    df["boll_low"] = _mid - 2 * _std
    items = [
        {
            **r,
            "ma5": _round_ma(v) if (v := r.get("ma5")) is not None else None,
            "ma10": _round_ma(v) if (v := r.get("ma10")) is not None else None,
            "ma20": _round_ma(v) if (v := r.get("ma20")) is not None else None,
            "boll_up": _round_ma(v) if (v := r.get("boll_up")) is not None else None,
            "boll_mid": _round_ma(v) if (v := r.get("boll_mid")) is not None else None,
            "boll_low": _round_ma(v) if (v := r.get("boll_low")) is not None else None,
        }
        for r in df.to_dict("records")
    ]
    signals = []
    if period == "day":
        try:
            signals = (await get_indicators(symbol))["signals"]
        except Exception:
            pass
    return {"ok": True, "period": period, "items": items, "signals": signals}


def _round_ma(v):
    try:
        f = float(v)
        return round(f, 2) if f == f else None
    except (TypeError, ValueError):
        return None


@app.get("/api/intraday/{symbol}")
async def intraday(symbol: str):
    symbol = symbol.upper()
    if symbol in INTL_SYMBOLS:
        raise HTTPException(status_code=400, detail="国际品种无日内分时数据（仅日 K 与实时报价）")
    loop_now = asyncio.get_event_loop().time()
    cached = _intraday_cache.get(symbol)
    if cached and loop_now - cached[0] < INTRADAY_TTL:
        return cached[1]
    try:
        rows = await get_minute(symbol, "1")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"分钟数据获取失败：{e}")
    if not rows:
        raise HTTPException(status_code=502, detail="分钟数据为空")
    last_day = rows[-1]["datetime"][:10]
    # 只保留最近一个交易日；均价线按累计量加权（接口无成交额，用 close*volume 近似）
    items, cum_amt, cum_vol = [], 0.0, 0.0
    for r in rows:
        if not r["datetime"].startswith(last_day):
            continue
        vol = r["volume"] or 0.0
        close = r["close"] or 0.0
        cum_amt += close * vol
        cum_vol += vol
        items.append({
            "time": r["datetime"][11:16],
            "price": close,
            "avg": round(cum_amt / cum_vol, 2) if cum_vol else None,
            "volume": vol,
        })
    data = {"ok": True, "date": last_day, "items": items}
    _intraday_cache[symbol] = (loop_now, data)
    return data


# ---------------------------------------------------------------- API：AI


@app.get("/api/ai/health")
async def ai_health():
    """多服务商体检：逐一发极短请求探活，返回每家的状态与失败原因。
    三源全挂时（用户实测过：deepseek Key 失效 + 智谱令牌过期 + coding plan 额度不足）
    用它一眼看出该修哪家，而不是逐个猜。"""
    cfg = load_config()
    out = []
    for cand in _llm_candidates(cfg):
        import time as _t
        t0 = _t.time()
        item = {
            "provider": cand["provider"],
            "model": cand["model"],
            "active": cand["provider"] == cfg["provider"],
            "ok": False, "status": 0, "detail": "", "ms": 0,
        }
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.post(
                    f"{cand['base_url']}/chat/completions",
                    headers={"Authorization": f"Bearer {cand['api_key']}"},
                    json={"model": cand["model"],
                          "messages": [{"role": "user", "content": "回复：OK"}],
                          "max_tokens": 256},
                )
            item["status"] = resp.status_code
            item["ok"] = resp.status_code == 200
            if resp.status_code == 200:
                item["detail"] = "正常"
                _note_provider_ok(cand["provider"])
            else:
                item["detail"] = _resp_reason(resp) or f"HTTP {resp.status_code}"
                if _is_provider_hard_error(resp):
                    _note_provider_fail(cand["provider"])
        except Exception as e:
            item["detail"] = f"{type(e).__name__}: {str(e)[:90]}"
        item["ms"] = int((_t.time() - t0) * 1000)
        out.append(item)
    return {"ok": True, "items": out, "active": cfg["provider"]}


@app.get("/api/ai/config")
async def get_ai_config():
    cfg = load_config()
    provider = cfg["provider"] if cfg["provider"] in PROVIDERS else "zhipu"
    return {
        "ok": True,
        "provider": provider,
        "provider_label": PROVIDERS[provider]["label"],
        "model": cfg["model"] or PROVIDERS[provider]["default_model"],
        "has_key": bool(cfg["api_keys"].get(provider)),
        "keys_status": {p: bool(cfg["api_keys"].get(p)) for p in PROVIDERS},
        "custom_base_url": cfg.get("custom_base_url", ""),
        "feishu_configured": bool((cfg.get("feishu") or {}).get("app_id")),
    }


class AiConfigIn(BaseModel):
    provider: str = "zhipu"
    model: str = ""
    api_key: str = ""
    clear_key: bool = False
    custom_base_url: str = ""


@app.post("/api/ai/config")
async def set_ai_config(body: AiConfigIn):
    if body.provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail="不支持的服务商")
    cfg = load_config()
    if body.custom_base_url.strip():
        cfg["custom_base_url"] = body.custom_base_url.strip()
    if body.provider == "custom" and not (cfg.get("custom_base_url") or "").strip():
        raise HTTPException(status_code=400, detail="自定义服务商需先填写接口地址（如 https://api.z.ai/api/paas/v4）")
    cfg["provider"] = body.provider
    cfg["model"] = body.model.strip() or PROVIDERS[body.provider]["default_model"]
    if body.clear_key:
        cfg["api_keys"][body.provider] = ""
    elif body.api_key.strip():  # 留空则保留该服务商已存的 Key
        cfg["api_keys"][body.provider] = body.api_key.strip()
    save_config(cfg)
    return {"ok": True}


async def _build_market_context(symbol: Optional[str]) -> str:
    """构建 AI 分析的多维上下文（并行拉取各数据段，耗时≈最慢段而非总和）"""
    parts = []
    cached_quotes = [
        {"ts": ts, "q": q}
        for ts, q in _quote_cache.values()
        if not q.get("error")
    ]
    if cached_quotes:
        rows = sorted(cached_quotes, key=lambda x: x["q"]["symbol"])
        if symbol:
            # 选中品种单独一行详细，其余自选压缩为一行摘要（省 token）
            sel = next((c for c in rows if c["q"]["symbol"] == symbol), None)
            others = [c for c in rows if c["q"]["symbol"] != symbol]
            lines = []
            if sel:
                q = sel["q"]
                pct = f"{q['change_pct']:+.2f}%" if q.get("change_pct") is not None else "--"
                lines.append(
                    f"- {q['symbol']} {q.get('name', '')}：最新 {q['last']}，昨结 {q.get('prev_settle')}，"
                    f"涨跌 {pct}，成交量 {q.get('volume')}，持仓量 {q.get('position')}（行情时间 {q.get('time')}）"
                )
            if others:
                brief = "；".join(
                    f"{c['q']['symbol']} {c['q']['last']}({c['q'].get('change_pct')}%)"
                    for c in others
                )
                lines.append(f"- 其他自选：{brief}")
            parts.append("【当前已加载的实时行情】\n" + "\n".join(lines))
        else:
            lines = [
                f"- {c['q']['symbol']} {c['q'].get('name', '')}：最新 {c['q']['last']}，"
                f"涨跌 {c['q'].get('change_pct')}%"
                for c in rows
            ]
            parts.append("【当前已加载的实时行情】\n" + "\n".join(lines))

    if not symbol:
        return "\n\n".join(parts)

    # 并行拉取（互不依赖的数据段）
    async def safe(coro, fallback=None):
        try:
            return await coro
        except Exception:
            return fallback

    (
        daily, directory, ind, ind15, intra, intl, deep, shm, cal_items, scalp,
    ) = await asyncio.gather(
        safe(get_daily(symbol), []),
        safe(get_directory(), {}),
        safe(get_indicators(symbol), None),
        safe(get_indicators(symbol, "15m"), None),
        safe(_intraday_summary(symbol), ""),
        safe(_intl_context_for(symbol), ""),
        safe(_variety_news_deep(symbol), []),
        safe(_shmet_news(symbol), []),
        safe(get_calendar(), []),
        safe(_scalp_snapshot(symbol), None),
    )

    name = directory.get(symbol, {}).get("name", "")

    # 超短雷达置顶（日内结构/动能/量价持仓/时段，超短线第一优先级）
    if scalp:
        parts.append(
            f"【{symbol}（{name}）日内超短雷达（实时计算）】\n"
            + "\n".join(f"- {p}" for p in scalp["points"])
            + f"\n- 可交易性：{scalp['score']}/100（{scalp['grade']}）"
        )

    # 15 分钟级技术指标（超短作战周期）
    if ind15:
        v = ind15["values"]
        dir_cn = {"bull": "看多", "bear": "看空", "warn": "警示"}
        ind_lines = [
            f"【{symbol} 技术指标（15分钟线，截至 {ind15['date']}）】",
            f"最新 {v.get('close')} | MA5 {v.get('ma5')} MA10 {v.get('ma10')} "
            f"MA20 {v.get('ma20')}",
            f"MACD: DIF {v.get('dif')} DEA {v.get('dea')} 柱 {v.get('macd_hist')} | "
            f"RSI6 {v.get('rsi6')} RSI12 {v.get('rsi12')}",
            f"KDJ: K {v.get('k')} D {v.get('d')} J {v.get('j')} | "
            f"BOLL: 上轨 {v.get('boll_up')} 中轨 {v.get('boll_mid')} 下轨 {v.get('boll_low')}",
        ]
        if ind15["signals"]:
            sig = "；".join(
                f"[{dir_cn.get(s['dir'], s['dir'])}]{s['name']}（{s['detail']}）"
                for s in ind15["signals"]
            )
            ind_lines.append(f"最新信号：{sig}")
        parts.append("\n".join(ind_lines))

    # 日线：降为背景参考（定顺逆大势，不做主要依据）
    if ind:
        v = ind["values"]
        trend = "价格在日线MA20上方（大势偏多背景）" if (v.get("close") or 0) > (v.get("ma20") or 0) else "价格在日线MA20下方（大势偏空背景）"
        macd_dir = "多头" if (v.get("dif") or 0) > (v.get("dea") or 0) else "空头"
        parts.append(f"【{symbol} 日线背景（仅定大势，超短不据此开仓）】{trend}；日线MACD{macd_dir}方向；MA20 {v.get('ma20')}")

        # 日线信号历史胜率（量化含金量）
        try:
            import pandas as _pd
            _df = _pd.DataFrame(daily[-500:]) if daily else None
            if _df is not None and len(_df) > 50:
                from indicators import signal_accuracy as _calc_acc
                active = [s["name"] for s in ind.get("signals", [])]
                if active:
                    acc_lines = []
                    for nm in active:
                        r = _calc_acc(_df, nm, 5)
                        if r.get("count", 0) >= 3:
                            acc_lines.append(f"{nm}: {r['win_rate']}%胜率({r['count']}次,均{r['avg_gain']:+.1f}%)")
                    if acc_lines:
                        parts.append("【日线信号历史胜率（近500根，5日后）】" + "；".join(acc_lines))
        except Exception:
            pass

    # 日内走势结构
    if intra:
        parts.append(f"【{symbol} 日内走势结构】{intra}")

    # 日K统计
    stats = _daily_stats(daily) if daily else ""
    if stats:
        parts.append(f"【{symbol} 中期统计】{stats}")

    # 关联外盘行情
    if intl:
        parts.append(intl)

    # 消息面（三层）
    if deep:
        lines = [f"- [{it['time'][5:16]}] {it['title']}（{it['source']}）" for it in deep]
        parts.append(f"【{symbol} 产业·供需聚焦（东财专业新闻，近期待闻）】\n" + "\n".join(lines))
    if shm:
        lines = [f"- [{it['time']}] {it['title']}" for it in shm]
        parts.append(f"【金属行情快讯（上海有色网 SHMET，实时）】\n" + "\n".join(lines))
    vnews = _variety_news(symbol)
    if vnews:
        lines = [f"- [{it['time'][5:16]}] {it['title'][:60]}" for it in vnews]
        parts.append(f"【{symbol} 全球宏观要闻（新浪/东财快讯流）】\n" + "\n".join(lines))

    # 基本面背景
    profile = _variety_profile(symbol)
    if profile:
        parts.append(f"【{symbol} 基本面框架（背景知识，供分析参考）】{profile}")

    # 今日宏观事件日历（时机风险）
    _calendar_cache["items"] = cal_items
    _calendar_cache["date"] = datetime.now().strftime("%Y%m%d")
    cal = _calendar_context()
    if cal:
        parts.append(cal)

        # 主力资金情绪（价量仓三要素）
        try:
            fs_txt = _fund_text(fund_sentiment(symbol, await get_daily(symbol)))
            if fs_txt:
                parts.append(f"【{symbol} 主力资金情绪】\n{fs_txt}")
        except Exception:
            pass

        # 消息面（仅宏观要闻：特朗普发言 + 中东重大动向，白名单过滤）
        try:
            vnews = _news_cache.get("items") or []
            if vnews:
                lines = [f"- [{it['time'][5:16]}] {'🇺🇸' if 'trump' in it['groups'] else '🌍'} {it['title'][:55]}" for it in vnews[:5]]
                parts.append("【宏观要闻（特朗普发言/中东重大动向）】\n" + "\n".join(lines))
        except Exception:
            pass

        # 基本面背景
        profile = _variety_profile(symbol)
        if profile:
            parts.append(f"【{symbol} 基本面框架（背景知识，供分析参考）】{profile}")

        # 专项基本面量化数据（交易所库存趋势 + 现货/主力/基差，日更缓存）
        try:
            fund_txt = await _variety_fundamentals(symbol)
            if fund_txt:
                parts.append(f"【{symbol} 专项基本面量化数据（库存与基差为核心供需晴雨表，第三部分必须引用）】\n{fund_txt}")
        except Exception:
            pass

        # 用户当前持仓（分析时请考虑持仓风险与原计划）
        try:
            holds = [
                e for e in _load_discipline_log()
                if e.get("allowed") and e.get("status") == "open" and e.get("symbol") == symbol
            ]
            if holds:
                h_lines = [
                    f"- {'做多' if h['side'] == 'long' else '做空'}{'（加仓）' if h.get('is_add') else ''}："
                    f"入场 {h['entry']}，止损 {h['sl']}，目标 {h.get('tp') or '未设'}，"
                    f"计划盈亏比 {h.get('rr') or '--'}，理由：{h.get('note') or '无'}（{str(h['ts'])[:16]} 申请）"
                    for h in holds
                ]
                parts.append(
                    f"【用户当前持有 {symbol} 仓位——分析请兼顾该持仓的风险与计划执行，而非仅给方向观点】\n" + "\n".join(h_lines)
                )
        except Exception:
            pass
            return "\n\n".join(parts)


class ChatMessage(BaseModel):
    role: str
    content: str = ""
    images: Optional[list[str]] = None  # data URL 形式的图片（视觉模型用）


class ChatIn(BaseModel):
    messages: list[ChatMessage]
    symbol: Optional[str] = None
    light: int = 0  # 1=跳过行情上下文（周报/自检等与实时行情无关的调用，省 token）


SYSTEM_PROMPT = """你是一位专业的国内期货超短线（日内 T+0）交易教练，服务对象是成熟交易者。你的全部分析以日内实时盘面为核心，不隔夜、不做中线推演。

分析权重（超短视角下的优先级）：
1) 主力资金动向（资金情绪评分、增减仓含义、多空力量）与日内量价持仓配合——主要依据；
2) 宏观消息面（特朗普表态、中东局势对供给/避险/定价的影响路径；地缘脉冲）——主要依据；
3) 日内结构（区间分位 / VWAP / 开盘区间IR / 短时动能 5-15-30分）——超短进出场核心；
4) 基本面（供需逻辑与库存周期——必须引用专项库存/基差量化数据，升贴水含义讲透；开工率/产量等无公开源的项目明说即可）；
5) 技术面（15分钟均线/MACD/KDJ/RSI/BOLL）仅作入场时机与关键价位参考，不作方向主论据。
日线仅定顺逆大势背景，绝不作为主要开仓依据。

分析原则：
- **结论前置**：每部分先给结论（偏多/偏空/中性、可做/观望），再给依据
- **量化表述**：所有判断给出具体数值和价位，不说"可能涨跌"这类模糊语
- **矛盾标注**：资金面与技术面矛盾时明说并以资金面与宏观为准；15分钟信号与日线背景冲突时按超短逻辑处理（顺势回调位优先）
- **可操作性**：给出具体入场触发价、止损价（说明逻辑依据：VWAP/IR边界/前低）、第一目标与移动止盈启动条件；明确"不做"的条件
- **时段纪律**：结合当前时段（早盘定性/午盘二次启动/尾盘只平不开/夜盘联动）给执行纪律
- **量价确认**：任何入场建议必须说明需要放量/缩量、增仓/减仓的确认条件
- 数据缺失要明说；连续主力合约口径注意换月跳空

输出结构：
1. **一句话结论**（方向+强度+核心逻辑，≤30字；清淡行情直接说"今日观望"）
2. **资金与消息面**（资金情绪评分、持仓增减含义、地缘/事件影响路径）
3. **日内结构**（区间分位、VWAP 位置、IR 突破状态、量价持仓定性 → 超短方向暗示）
4. **短时动能**（5/15/30分变化、15分钟指标状态、信号共振或冲突）
5. **超短作战计划**（入场触发价、止损价+逻辑、第一目标、移动止盈条件、"不做"条件）
6. **风险一句话**（今天最可能打脸的场景）

你的输出仅供研究参考，不构成投资建议。"""


@app.post("/api/ai/chat")
async def ai_chat(body: ChatIn):
    # 图片防御：单张 base64 过大或总量过多时直接拒绝，避免撑爆请求与上下文
    n_imgs = 0
    for m in body.messages:
        for url in m.images or []:
            if len(url) > 12 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="单张图片过大（超过约 9MB 原图），请换小图或重新截图")
            n_imgs += 1
    if n_imgs > 8:
        raise HTTPException(status_code=400, detail="图片总数过多（最多 8 张）")

    cfg = load_config()
    provider = cfg["provider"] if cfg["provider"] in PROVIDERS else "zhipu"
    if not cfg["api_keys"].get(provider):
        raise HTTPException(status_code=400, detail="尚未配置 API Key，请先在右上角「AI 设置」中配置")
    base_url = provider_base_url(cfg, provider)
    if not base_url:
        raise HTTPException(status_code=400, detail="自定义服务商未配置接口地址，请先在「⚙ AI 设置」填写")
    candidates = _llm_candidates(cfg)

    context = "" if body.light else await _build_market_context(body.symbol)
    # 多品种识别：问题里提到的其它品种（非当前选中）注入紧凑快照——
    # 否则问"SA/FG 怎么样"而选中的是别的品种时，AI 缺全部判据
    if not body.light:
        last_q = next((m.content for m in reversed(body.messages) if m.role == "user"), "")
        for s in _detect_question_symbols(last_q, exclude=body.symbol):
            try:
                blk = await _symbol_snapshot_block(s)
                if blk:
                    context += (f"\n\n" if context else "") + f"【{s} 快照（问题提及品种，与当前选中对比分析用）】\n{blk}"
            except Exception:
                pass
    profile = _profile_context()
    position = _position_context()
    system = (SYSTEM_PROMPT
              + ("\n\n" + profile if profile else "")
              + ("\n\n" + position if position else "")
              + ("\n\n" + context if context else ""))
    messages = _build_api_messages(body.messages, system)

    import logging
    import time as _time

    logger = logging.getLogger("uvicorn.error")
    t0 = _time.time()
    fallback_used = False
    full_reply = ""
    truncated_rounds = 0

    async with httpx.AsyncClient(timeout=180) as client:  # 推理模型长回复需要更长时间
      for cand in candidates:
        provider, base_url, api_key, model = cand["provider"], cand["base_url"], cand["api_key"], cand["model"]
        max_tokens = max_output_for(model)
        logger.info(f"[ai-chat] 开始调用 {provider}/{model}（消息 {len(body.messages)} 条，图片 {n_imgs} 张，上下文 {len(system)} 字，max_tokens={max_tokens}）")
        full_reply = ""
        truncated_rounds = 0
        # 最多 3 轮：正常 1 轮；finish_reason=length（长度截断）时自动续写拼接
        for round_no in range(3):
            async def request_once(mt: int) -> httpx.Response:
                return await client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={"model": model, "messages": messages,
                          "temperature": 0.6, "max_tokens": mt},
                )

            try:
                resp = await request_once(max_tokens)
                # 某些模型对超过自身上限的 max_tokens 直接报 400，自动降至 4096 重试
                if resp.status_code == 400 and "max_tokens" in resp.text.lower() and max_tokens > 4096:
                    logger.info(f"[ai-chat] max_tokens={max_tokens} 超出模型上限，降至 4096 重试")
                    max_tokens = 4096
                    resp = await request_once(max_tokens)
            except httpx.TimeoutException:
                logger.info(f"[ai-chat] 超时（{_time.time() - t0:.0f}s）")
                raise HTTPException(status_code=504, detail="AI 服务响应超时（推理型模型可能较慢，请重试或换用轻量模型）")
            except httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"无法连接 AI 服务：{e}")

            if (cand is not candidates[-1]) and (
                _is_provider_hard_error(resp)
                or (resp.status_code == 400 and "model" in resp.text.lower())  # 模型名失效（平台目录变更）也换下家
            ):
                logger.info(f"[ai-chat] {provider}/{model} 错误 {resp.status_code}，切换兜底服务商")
                _note_provider_fail(provider)
                fallback_used = True
                break  # 换下一个候选

            if resp.status_code == 401:
                raise HTTPException(status_code=401, detail="API Key 无效，请检查后重新保存")
            if resp.status_code == 429:
                # 透传上游原始信息（如“模型额度不足/无权限”，对定位问题至关重要）
                detail = ""
                try:
                    detail = resp.json().get("error", {}).get("message", "")[:150]
                except Exception:
                    pass
                raise HTTPException(
                    status_code=429,
                    detail=f"AI 服务限流或额度不足：{detail or '请求过于频繁，请稍后重试'}",
                )
            if resp.status_code == 402 or (resp.status_code == 403 and "balance" in resp.text.lower()):
                raise HTTPException(status_code=402, detail="账户余额不足，请到开放平台充值")
            if resp.status_code != 200:
                detail = ""
                try:
                    detail = resp.json().get("error", {}).get("message", "")[:200]
                except Exception:
                    pass
                raise HTTPException(status_code=502, detail=f"AI 服务返回 {resp.status_code}：{detail or '未知错误'}")

            try:
                choice = resp.json()["choices"][0]
                content = (choice["message"].get("content") or "").strip()
            except Exception:
                raise HTTPException(status_code=502, detail="AI 返回内容无法解析")
            full_reply += content

            if choice.get("finish_reason") != "length" or not content:
                break
            # 长度截断：把已生成内容回填并要求续写（不重复）
            truncated_rounds += 1
            logger.info(f"[ai-chat] 第 {round_no + 1} 轮因长度截断，自动续写")
            messages = messages + [
                {"role": "assistant", "content": full_reply},
                {"role": "user", "content": "继续，从你刚才中断的地方接着写，不要重复已有内容"},
            ]
        if full_reply:
            _note_provider_ok(provider)
            break  # 本候选成功

    logger.info(f"[ai-chat] 完成：{provider}/{model}，耗时 {_time.time() - t0:.0f}s，共 {len(full_reply)} 字"
                + (f"（续写 {truncated_rounds} 轮）" if truncated_rounds else "")
                + ("（兜底）" if fallback_used else ""))
    # 对话自动记录到飞书（品种+时间+问答；异步执行不阻塞响应，失败静默）
    if cfg.get("feishu", {}).get("auto_chat_log", True) and body.messages:
        last_q = next((m.content for m in reversed(body.messages) if m.role == "user"), "")
        if last_q.strip():
            asyncio.create_task(
                _feishu_log_chat_round(body.symbol, last_q.strip(), full_reply)
            )
    return {"ok": True, "reply": full_reply, "fallback": fallback_used}


# ---------------------------------------------------------------- 实时解读：最新数据 → AI 盘中快评

_realtime_cache: dict[str, tuple[float, dict]] = {}  # symbol -> (loop_ts, result)


async def _llm_text(prompt: str, max_tokens: int = 1600) -> str:
    """调用已配置的 LLM 输出普通文本（实时解读用，非 JSON）。
    主服务商 401/402/429 时自动兜底到其余已存 Key 的服务商。"""
    import logging
    logger = logging.getLogger("uvicorn.error")
    cfg = load_config()
    candidates = _llm_candidates(cfg)
    if not candidates:
        raise HTTPException(status_code=400, detail="尚未配置 API Key，请先在「⚙ AI 设置」中配置")
    last = {"code": 502, "detail": "AI 调用失败"}
    for idx, cand in enumerate(candidates):
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(
                f"{cand['base_url']}/chat/completions",
                headers={"Authorization": f"Bearer {cand['api_key']}"},
                json={
                    "model": cand["model"],
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.5,
                    "max_tokens": max(max_output_for(cand["model"]), max_tokens),
                },
            )
        if resp.status_code == 200:
            try:
                content = resp.json()["choices"][0]["message"]["content"].strip()
            except Exception:
                content = ""
            if content:
                if idx > 0:
                    logger.info(f"[llm-text] 主服务商不可用，由 {cand['provider']}/{cand['model']} 兜底")
                _note_provider_ok(cand["provider"])
                return content
            last = {"code": 502, "detail": "AI 返回空内容（推理模型思维链耗尽 token，请重试）"}
        elif _is_provider_hard_error(resp) and idx < len(candidates) - 1:
            logger.info(f"[llm-text] {cand['provider']} 硬错误 {resp.status_code}，切换兜底")
            _note_provider_fail(cand["provider"])
            continue
        else:
            detail = ""
            try:
                detail = resp.json().get("error", {}).get("message", "")[:150]
            except Exception:
                pass
            last = {"code": resp.status_code if resp.status_code in (401, 429) else 502,
                    "detail": f"AI 服务限流或额度不足：{detail}" if resp.status_code == 429 else
                              (f"API Key 无效" if resp.status_code == 401 else f"AI 服务返回 {resp.status_code}：{detail or '未知错误'}")}
        if resp.status_code not in (200,) and not (_is_provider_hard_error(resp) and idx < len(candidates) - 1):
            break  # 非可兜底错误（如 502 解析问题）不再尝试后续
    raise HTTPException(status_code=last["code"], detail=last["detail"])


async def _llm_text_retry(prompt: str, max_tokens: int = 0) -> str:
    """_llm_text 带一次自动重试：推理模型偶发空输出/瞬时失败时不劳用户手动重试"""
    try:
        return await _llm_text(prompt, max_tokens)
    except HTTPException as e:
        if e.status_code not in (502, 429) or "API Key" in str(e.detail):
            raise
        await asyncio.sleep(2)
        return await _llm_text(prompt, max_tokens)


async def _realtime_snapshot(symbol: str) -> dict:
    """此刻实时盘面快照（实时解读与纪律 AI 审查共用）：
    最新行情/盘口/日内分时结构/30 分钟节奏/60 分钟方向/日线指标/要闻/持仓。"""
    # 强制拉最新行情（绕过 5 秒缓存直连数据源，失败则退回缓存）
    try:
        quote = await fetch_quote(symbol)
    except Exception:
        cached_q = _quote_cache.get(symbol)
        quote = cached_q[1] if cached_q else {}
    if not quote or quote.get("last") is None:
        raise HTTPException(status_code=502, detail="实时行情获取失败，稍后重试")

    book = (f"买一 {quote.get('bid')}（{quote.get('bid_vol')} 手）/ "
            f"卖一 {quote.get('ask')}（{quote.get('ask_vol')} 手）") if quote.get("bid") else "盘口缺失"
    try:
        intra = await _intraday_summary(symbol)
    except Exception:
        intra = ""
    m30_txt = ""
    try:
        m30 = (await get_minute(symbol, "30"))[-12:]
        # token 优化：12 根 OHLC 逐根展开太长，压缩为收盘序列 + 区间高低（节奏信息保留）
        cs = [r["close"] for r in m30 if r.get("close")]
        if len(cs) >= 2:
            hi = max(r["high"] for r in m30 if r.get("high"))
            lo = min(r["low"] for r in m30 if r.get("low"))
            m30_txt = f"近12根收盘 {'、'.join(str(c) for c in cs)}（区间 {lo}~{hi}）"
    except Exception:
        pass
    try:
        m60 = (await get_minute(symbol, "60"))[-21:]
        c60 = [float(r["close"]) for r in m60 if r.get("close")][-21:]
        m60_dir = ("上行" if sum(c60[-20:]) / 20 > sum(c60[-21:-1]) / 20 else "下行") if len(c60) >= 21 else "未知"
    except Exception:
        m60_dir = "未知"
    try:
        ind = await get_indicators(symbol)
        v = ind["values"]
        sigs = "；".join(f"{s['name']}（{s['detail']}）" for s in ind["signals"]) or "无"
        ind_txt = (f"MA5 {v.get('ma5')} MA10 {v.get('ma10')} MA20 {v.get('ma20')} MA60 {v.get('ma60')}；"
                   f"RSI6 {v.get('rsi6')} KDJ-J {v.get('j')}；MACD 柱 {v.get('macd_hist')}；"
                   f"BOLL {v.get('boll_low')}~{v.get('boll_up')}（中轨 {v.get('boll_mid')}）；信号：{sigs}")
    except Exception:
        ind_txt = "指标不可用"
    try:
        fs = fund_sentiment(symbol, await get_daily(symbol))
        fs_txt = _fund_text(fs) if fs else ""
    except Exception:
        fs_txt = ""
    if fs_txt:
        ind_txt += "\n主力资金情绪：" + fs_txt
    try:
        vnews = (_news_cache.get("items") or [])[:5]
        news_txt = "；".join(it["title"][:40] for it in vnews) or "无特朗普/中东相关要闻"
    except Exception:
        news_txt = "无"
    holds = [
        e for e in _load_discipline_log()
        if e.get("allowed") and e.get("status") == "open" and e.get("symbol") == symbol
    ]
    hold_txt = "；".join(
        f"{'多' if h['side'] == 'long' else '空'}单 入{h['entry']} 损{h['sl']} 目标{h.get('tp') or '未设'}" for h in holds
    ) if holds else "无持仓"
    return {
        "quote": quote,
        "book": book,
        "intra": intra,
        "m30": m30_txt,
        "m60_dir": m60_dir,
        "ind_txt": ind_txt,
        "news": news_txt,
        "holds": hold_txt,
        "now": datetime.now().strftime("%m-%d %H:%M:%S"),
    }


@app.get("/api/ai/realtime")
async def ai_realtime(symbol: str, force: int = 0):
    """实时解读：把此刻的最新行情（盘口/分时结构/分钟线/指标/要闻/持仓）
    打包给 AI 生成盘中快评。同品种 5 分钟内复用缓存（force=1 强刷）。"""
    symbol = symbol.strip().upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _realtime_cache.get(symbol)
    if cached and not force and loop_now - cached[0] < 300:
        return cached[1]

    snap = await _realtime_snapshot(symbol)
    quote = snap["quote"]
    now_str = snap["now"]
    prompt = f"""你是盘口解读员。基于以下此刻（{now_str}）的实时数据，写一份 300 字以内的盘中快评（Markdown）。权重要求：资金情绪与宏观要闻为主要依据，技术指标仅作价位与时机参考。

【{symbol} 实时快照】
最新 {quote['last']}，涨跌 {quote.get('change')}（{quote.get('change_pct')}%），昨结 {quote.get('prev_settle')}，成交量 {quote.get('volume')}，持仓量 {quote.get('position')}
盘口：{snap['book']}
日内结构：{snap['intra'] or '数据不足'}
30分钟节奏（近12根）：{snap['m30'] or '数据不足'}
日线指标：{snap['ind_txt']}
60分钟趋势：{snap['m60_dir']}
相关要闻（特朗普/中东）：{snap['news']}
用户持仓：{snap['holds']}

格式：**资金与消息驱动**（1-2 句：宏观要闻与资金动向如何影响该品种）→ **多空倾向**（明确偏多/偏空/震荡，以资金面与宏观为主要依据，技术位辅助）→ **关键价位**（上方压力/下方支撑具体数字）→ **风险提示**（1 句）。若用户有持仓，快评需兼顾其持仓的应对。"""

    reply = await _llm_text_retry(prompt)
    result = {
        "ok": True,
        "symbol": symbol,
        "name": quote.get("name", ""),
        "last": quote.get("last"),
        "generated_at": now_str,
        "analysis": reply,
    }
    _realtime_cache[symbol] = (loop_now, result)
    return result


# ---------------------------------------------------------------- AI 合约分析：四维上下文

# 品种基本面知识库（按合约前缀匹配，供 AI 参考的背景框架）
VARIETY_PROFILE = {
    "RB": "螺纹钢：需求看地产基建开工与专项债，供给看粗钢压产与电炉利润；旺季3-4月/9-10月；关注表观需求、库存周期与铁矿焦煤成本。",
    "HC": "热卷：制造业与出口（机电、汽车、家电）驱动，卷螺价差反映需求切换；关注出口接单与制造业PMI。",
    "I": "铁矿石：供给看澳巴发运与天气，需求看钢厂铁水产量；港口库存与钢厂可用天数是核心指标；宏观定价属性强。",
    "CU": "铜：全球宏观定价（美元、中美PMI），矿端紧张与冶炼加工费约束供给，需求看电网/新能源/地产；LME库存与持仓敏感。",
    "AU": "黄金：实际利率与美元定价核心，避险与央行购金驱动；关注美联储政策路径、非农/CPI、地缘风险；国内溢价反映消费需求。",
    "AG": "白银：金融属性同黄金+工业属性（光伏），波动大于黄金；金银比走阔/收敛是常用策略视角。",
    "SC": "原油：OPEC+产量政策、地缘（中东/俄乌）、全球需求三因子；EIA库存与月差结构是高频核心指标；国内SC另受仓单运费影响。",
    "FU": "燃料油：跟随原油，发电与航运需求（低硫）季节性明显。",
    "M": "豆粕：美豆/南美产量与天气、进口到港与油厂开机、生猪存栏三链条；关注USDA报告与油厂库存。",
    "RM": "菜粕：与豆粕高度联动，水产养殖旺季（5-9月）需求弹性大。",
    "Y": "豆油 / P:棕榈油：产地（马来印尼）库存（MPOB）、生柴政策、大豆供给；油脂间价差活跃。",
    "OI": "菜油：跟随油脂板块，加拿大菜籽供给与国内进口为边际变量。",
    "TA": "PTA：油价成本+PX供给+聚酯需求；加工费与开工率是核心指标。",
    "EG": "乙二醇：油煤双路线成本，港口库存与聚酯需求。",
    "MA": "甲醇：煤炭成本+港口库存+下游（MTO/传统化工）需求；内地-港口价差反映区域平衡。",
    "FG": "玻璃：地产竣工链条，日熔量与厂内库存为核心；纯碱成本联动。",
    "SA": "纯碱：光伏与浮法玻璃日熔量决定需求，供给看新产能投放；玻璃-纯碱价差策略常用。",
    "L": "塑料 / V:PVC / PP:聚丙烯：油价煤价成本+下游（农膜/地产/包装）需求季节性；PVC 与地产竣工相关度高。",
    "C": "玉米：临储政策与进口替代、小麦价差、饲用需求；丰产季（10-11月）压力。",
    "CF": "棉花：种植面积与天气（新疆）、下游纺织订单与内需；金九银十旺季。",
    "SR": "白糖：国内产量与进口配额、巴西印度泰国供给；季度性明显。",
    "IF": "沪深300股指：盈利（PMI/工业利润）与流动性（利率/汇率）双轮驱动；期货贴水结构反映对冲需求。",
    "IM": "中证1000 / IH:上证50 / IC:中证500：风格与中小盘弹性差异，雪球与量化对冲影响贴水。",
    "T": "国债：货币政策和资金面定价，经济数据走弱利多；久期属性。",
}

# 消息面：品种相关的要闻关键词（用于从快讯流过滤）
VARIETY_NEWS_KW = {
    "AU": ["黄金", "金价", "期金", "贵金属", "美联储", "降息", "加息", "非农", "cpi", "美元"],
    "AG": ["白银", "银价", "贵金属", "黄金", "光伏"],
    "SC": ["原油", "油价", "opec", "欧佩克", "石油", "炼厂", "中东", "霍尔木兹"],
    "FU": ["燃料油", "原油", "油价", "航运"],
    "RB": ["螺纹", "钢材", "钢铁", "地产", "基建", "专项债"],
    "HC": ["热卷", "钢材", "钢铁", "制造业", "出口"],
    "I": ["铁矿石", "铁矿", "钢铁", "粗钢", "铁水"],
    "CU": ["铜", "铜价", "电网", "智利", "秘鲁"],
    "M": ["豆粕", "大豆", "美豆", "生猪", "usda", "南美"],
    "RM": ["菜粕", "豆粕", "水产"],
    "P": ["棕榈油", "MPOB".lower(), "生柴", "印尼", "马来"],
    "Y": ["豆油", "油脂", "大豆"],
    "OI": ["菜油", "菜籽", "油脂"],
    "TA": ["pta", "聚酯", "px", "纺织"],
    "MA": ["甲醇", "煤炭", "mto", "港口库存"],
    "FG": ["玻璃", "竣工", "地产"],
    "SA": ["纯碱", "玻璃", "光伏"],
    "C": ["玉米", "小麦", "饲料"],
    "CF": ["棉花", "纺织", "新疆"],
    "SR": ["白糖", "糖", "巴西"],
    "IF": ["股市", "A股", "沪指", "流动性", "利率", "pmi"],
    "IM": ["股市", "A股", "中小盘", "中证"],
    "IH": ["股市", "A股", "蓝筹", "利率"],
    "IC": ["股市", "A股", "中证"],
    "T": ["国债", "债市", "利率", "货币政策", "央行"],
}


def _variety_prefix(symbol: str) -> str:
    m = re.match(r"^([A-Za-z]{1,2})", symbol or "")
    return m.group(1).upper() if m else ""


# ---------------------------------------------------------------- 国际期货行情（外盘参考）

# 新浪外盘代码 → 展示配置（CL/OIL/GC/S 实测可用；美元指数走 hq.sinajs）
INTL_SYMBOLS = {
    "CL":  {"name": "WTI 原油", "kind": "sina"},
    "OIL": {"name": "布伦特原油", "kind": "sina"},
    "GC":  {"name": "COMEX 黄金", "kind": "sina"},
    "XAU": {"name": "伦敦金", "kind": "sina"},
    "S":   {"name": "CBOT 美豆", "kind": "sina"},
    "HG":  {"name": "COMEX 铜", "kind": "sina"},
    "DINIW": {"name": "美元指数", "kind": "hq"},
}

_intl_cache: dict = {"ts": 0.0, "items": []}
INTL_TTL = 20.0


async def _fetch_intl_one(code: str, conf: dict) -> dict:
    if conf["kind"] == "hq":
        # 新浪 hq 接口（美元指数）：时间,现价,买价,卖价,?,昨收...名称,日期
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                f"https://hq.sinajs.cn/list={code}",
                headers={"Referer": "https://finance.sina.com.cn/futures/"},
            )
        m = re.search(r'"([^"]+)"', r.text)
        if not m:
            return {"symbol": code, "name": conf["name"], "error": "无数据"}
        f = m.group(1).split(",")
        last = float(f[1])
        prev_close = float(f[5]) if len(f) > 5 and f[5] else None  # f[5]=昨收（f[8] 是现价重复）
        chg = round((last / prev_close - 1) * 100, 2) if prev_close else None
        return {"symbol": code, "name": conf["name"], "last": last,
                "prev_close": prev_close, "change_pct": chg, "time": f[0], "date": f[10] if len(f) > 10 else ""}
    # 新浪外盘期货（AkShare）
    df = await call_ak(ak.futures_foreign_commodity_realtime, symbol=code)
    r0 = df.iloc[0]
    return {"symbol": code, "name": str(r0["名称"]), "last": _num(r0["最新价"]),
            "prev_close": _num(r0["昨日结算价"]), "change_pct": _num(r0["涨跌幅"]),
            "open": _num(r0["开盘价"]), "high": _num(r0["最高价"]), "low": _num(r0["最低价"]),
            "cny": _num(r0["人民币报价"]), "time": str(r0["行情时间"]), "date": str(r0["日期"])}


async def get_intl_quotes(force: bool = False) -> list[dict]:
    loop_now = asyncio.get_event_loop().time()
    prev_map = ({q["symbol"]: q for q in _intl_cache["items"] if not q.get("error")}
                if _intl_cache["items"] else {})
    if not force and loop_now - _intl_cache["ts"] < INTL_TTL:
        return _intl_cache["items"]
    async def safe_fetch(code, conf):
        # 单项 6 秒封顶：最慢的外网请求不拖累整批（失败者下轮重试）
        try:
            return await asyncio.wait_for(_fetch_intl_one(code, conf), timeout=8)
        except asyncio.TimeoutError:
            return {"symbol": code, "name": conf["name"], "error": "超时"}
        except Exception:
            return {"symbol": code, "name": conf["name"], "error": "获取失败"}

    items = list(await asyncio.gather(*(safe_fetch(c, cf) for c, cf in INTL_SYMBOLS.items())))
    _intl_cache["items"] = items
    _intl_cache["ts"] = loop_now

    # 外盘异动检测：与上次抓取比较，超阈值即入事件流 + 推送飞书
    for q in items:
        pp = prev_map.get(q.get("symbol"))
        if not pp or not pp.get("last") or not q.get("last"):
            continue
        delta = (q["last"] / pp["last"] - 1) * 100
        thr = 0.25 if q["symbol"] == "DINIW" else 0.5
        if abs(delta) < thr:
            continue
        direction = "up" if delta > 0 else "down"
        now_ts = asyncio.get_event_loop().time()
        if now_ts - _MONITOR["cooldown"].get((q["symbol"], direction), 0) < MONITOR_COOLDOWN:
            continue
        _MONITOR["cooldown"][(q["symbol"], direction)] = now_ts
        event = {
            "id": f"{q['symbol']}-{direction}-{int(now_ts)}",
            "ts": int(datetime.now().timestamp() * 1000),
            "symbol": q["symbol"], "name": q["name"], "dir": direction,
            "chg5": round(delta, 2), "chg15": delta, "day_chg": None,
            "price": q["last"], "from": pp["last"], "pos_chg": None,
            "threshold": thr, "intl": True, "time_str": f"{q.get('date', '')} {q.get('time', '')}",
            "ai": None,
        }
        _MONITOR["events"].append(event)
        if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
            _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
        asyncio.create_task(_feishu_push(
            f"🌍 外盘异动\n{q['name']} {'急涨' if delta > 0 else '急跌'} {delta:+.2f}% → {q['last']}"
            f"\n（{q.get('date', '')} {q.get('time', '')}）"
        ))
    return items


@app.get("/api/intl-quotes")
async def intl_quotes():
    return {"ok": True, "items": await get_intl_quotes()}


# 国内品种 → 关联外盘（AI 上下文联动）
DOMESTIC_TO_INTL = {
    "SC": ["CL", "OIL"], "FU": ["CL", "OIL"], "LU": ["CL", "OIL"], "NR": ["OIL"], "TA": ["OIL"], "MA": ["OIL"], "EG": ["OIL"], "PP": ["OIL"], "L": ["OIL"], "V": ["OIL"], "BU": ["OIL"], "PG": ["OIL"],
    "AU": ["GC", "XAU", "DINIW"], "AG": ["XAU", "DINIW"],
    "M": ["S"], "Y": ["S", "BO"], "P": ["BO"], "A": ["S"], "RM": ["S"], "OI": ["S"],
    "C": ["C"], "RB": ["DINIW"], "HC": ["DINIW"], "I": ["DINIW"], "CU": ["HG", "DINIW"], "AL": ["DINIW"], "ZN": ["DINIW"], "NI": ["DINIW"], "SN": ["DINIW"],
    "IF": ["DINIW"], "IH": ["DINIW"], "IC": ["DINIW"], "IM": ["DINIW"], "T": ["DINIW"],
}


async def _intl_context_for(symbol: str) -> str:
    """为国内品种生成关联外盘行情上下文"""
    related = DOMESTIC_TO_INTL.get(_variety_prefix(symbol))
    if not related:
        return ""
    try:
        quotes = await get_intl_quotes()
        by_code = {q["symbol"]: q for q in quotes}
        lines = []
        for code in related:
            q = by_code.get(code if code in INTL_SYMBOLS else "DINIW")
            if q and not q.get("error") and q.get("last") is not None:
                pct = f"{q['change_pct']:+.2f}%" if q.get("change_pct") is not None else "--"
                cny = f"（人民币 {q['cny']:.0f}）" if q.get("cny") else ""
                lines.append(f"- {q['name']}：{q['last']}{cny}，{pct}（{q.get('date', '')} {q.get('time', '')}）")
        if lines:
            return "【关联外盘行情（定价锚）】\n" + "\n".join(lines)
    except Exception:
        pass
    return ""


VARIETY_SEARCH = {
    "RB": "螺纹钢", "HC": "热卷", "I": "铁矿石", "JM": "焦煤", "J": "焦炭",
    "CU": "沪铜", "AL": "沪铝", "ZN": "沪锌", "PB": "沪铅", "NI": "沪镍", "SN": "沪锡", "SS": "不锈钢",
    "AU": "黄金", "AG": "白银", "SC": "原油", "FU": "燃料油", "LU": "低硫燃料油", "NR": "20号胶", "RU": "橡胶",
    "M": "豆粕", "RM": "菜粕", "Y": "豆油", "P": "棕榈油", "OI": "菜油", "A": "豆一", "B": "豆二",
    "TA": "PTA", "MA": "甲醇", "EG": "乙二醇", "EB": "苯乙烯", "PP": "聚丙烯", "L": "塑料", "V": "PVC", "PG": "液化气",
    "FG": "玻璃", "SA": "纯碱", "UR": "尿素", "C": "玉米", "CS": "玉米淀粉", "CF": "棉花", "SR": "白糖",
    "JD": "鸡蛋", "LH": "生猪", "SP": "纸浆", "LC": "碳酸锂", "SI": "工业硅", "EC": "集运",
    "IF": "沪深300", "IH": "上证50", "IC": "中证500", "IM": "中证1000", "T": "国债",
}

# SHMET 金属快讯对非金属品种的通用宏观过滤词
_MACRO_KW = ["黄金", "金价", "原油", "油价", "美元", "美联储", "央行", "降息", "加息", "通胀",
             "地缘", "伊朗", "中东", "霍尔木兹", "智利", "秘鲁", "新能源", "光伏", "环保", "关税", "贸易"]


def _variety_search_word(symbol: str) -> str:
    p = _variety_prefix(symbol)
    if p in VARIETY_SEARCH:
        return VARIETY_SEARCH[p]
    # 兜底：从主连名称提取核心词（如"螺纹钢连续"→"螺纹钢"）
    try:
        name = asyncio.run(get_directory()).get(symbol, {}).get("name", "")
        return name.replace("连续", "").replace("期货", "").strip() or p
    except Exception:
        return p


# 缓存：品种深研（东财，10 分钟）+ SHMET 快讯（90 秒）
_deep_news_cache: dict[str, tuple[float, list]] = {}
_shmet_cache: dict = {"ts": 0.0, "items": []}
DEEP_TTL = 600.0
SHMET_TTL = 90.0


async def _variety_news_deep(symbol: str, limit: int = 6) -> list[dict]:
    """东财品种聚焦新闻：产业/供需/库存深度报道（期货日报等），10 分钟缓存"""
    word = _variety_search_word(symbol)
    loop_now = asyncio.get_event_loop().time()
    cached = _deep_news_cache.get(word)
    if cached and loop_now - cached[0] < DEEP_TTL:
        return cached[1][:limit]
    try:
        df = await call_ak(ak.stock_news_em, symbol=word)
        items = [
            {
                "time": str(r.get("发布时间", ""))[:16],
                "title": str(r.get("新闻标题", ""))[:70],
                "summary": str(r.get("新闻内容", ""))[:150],
                "source": str(r.get("文章来源", "")),
                "link": str(r.get("新闻链接", "")),
            }
            for r in df.to_dict("records")
            if not _is_stock_noise(str(r.get("新闻标题", "")) + " " + str(r.get("新闻内容", ""))[:80])
        ]
        _deep_news_cache[word] = (loop_now, items)
        return items[:limit]
    except Exception as e:
        logging.getLogger("uvicorn.error").info(f"[deep-news] {word} 失败：{e}")
        return []


async def _shmet_news(symbol: str = "", limit: int = 6) -> list[dict]:
    """SHMET 上海有色网金属快讯（秒级，覆盖金属+宏观地缘），90 秒缓存"""
    loop_now = asyncio.get_event_loop().time()
    if loop_now - _shmet_cache["ts"] > SHMET_TTL:
        try:
            df = await call_ak(ak.futures_news_shmet)
            _shmet_cache["items"] = [
                {"time": str(r.get("发布时间", ""))[5:16], "title": str(r.get("内容", ""))[:90]}
                for r in df.to_dict("records")
            ]
            _shmet_cache["ts"] = loop_now
        except Exception as e:
            logging.getLogger("uvicorn.error").info(f"[shmet] 失败：{e}")
            return []
    items = _shmet_cache["items"]
    if symbol:
        p = _variety_prefix(symbol)
        if p in ("CU", "AL", "ZN", "PB", "NI", "SN", "SS", "AU", "AG", "SC", "FU", "LU", "BR", "AO", "LC", "SI"):
            return items[:limit]  # 金属/能源品种：快讯直接全给
        # 其他品种：过滤出宏观/共性因子相关条目
        hit = [it for it in items if any(k in it["title"] for k in _MACRO_KW)]
        return hit[:limit]
    return items[:limit]
# ---------------------------------------------------------------- 品种专项基本面量化数据（库存 + 现货基差）

_fund_cache: dict[str, tuple[float, str, float]] = {}  # 品种前缀 -> (loop_ts, 文本, ttl)
FUND_TTL = 3600.0  # 数据日更，1 小时缓存足够
FUND_EMPTY_TTL = 600.0  # 无数据品种（能源中心/国际盘等）短负缓存，防每次分析重试打爆源


def _nearby_trading_days(n: int = 5) -> list[str]:
    """最近的 n 个工作日（YYYYMMDD，今天在前）——现货基差表按交易日发布"""
    from datetime import date, timedelta
    d = date.today()
    out = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
        d -= timedelta(days=1)
    return out


async def _spot_basis_row(prefix: str) -> Optional[dict]:
    """最近交易日的现货价与主力基差（全品种单表按代码过滤；找不到返回 None）"""
    for d in _nearby_trading_days():
        try:
            df = await call_ak(ak.futures_spot_price, date=d)
        except Exception:
            continue
        if df is None or df.empty:
            continue
        hit = df[df["symbol"].astype(str).str.upper() == prefix.upper()]
        if len(hit):
            return hit.iloc[-1].to_dict()
    return None


async def _variety_fundamentals(symbol: str) -> str:
    """品种专项基本面量化数据：交易所库存趋势（东财）+ 现货价/主力/基差。
    开工率、周产量、日熔量等无免费公开源（隆众/卓创付费），有库存与基差
    两个核心供需晴雨表即可支撑量化结论。任一源失败静默跳过。"""
    prefix = _variety_prefix(symbol)
    if not prefix:
        return ""
    key = prefix.upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _fund_cache.get(key)
    if cached and loop_now - cached[0] < cached[2]:
        return cached[1]
    lines = []
    # ① 交易所库存：最新值 + 近两周变化（em 品种代码=大写交易所代码，少数小写）
    try:
        df = None
        for code in (key, key.lower()):
            try:
                df = await call_ak(ak.futures_inventory_em, symbol=code)
                break
            except ValueError:
                continue
        if df is not None and len(df) >= 6:
            latest = df.iloc[-1]
            base = df.iloc[max(0, len(df) - 11)]  # 约两周前
            chg = float(latest["库存"]) - float(base["库存"])
            chg_pct = chg / float(base["库存"]) * 100 if float(base["库存"]) else 0.0
            lines.append(
                f"- 交易所库存（{latest['日期']}）：{latest['库存']}，近两周 {chg:+.0f}（{chg_pct:+.1f}%），最新增减 {latest['增减']}"
            )
    except Exception:
        pass
    # ② 现货价与主力基差（正=现货升水，负=贴水）
    try:
        row = await _spot_basis_row(prefix)
        if row:
            def _n(v):
                try:
                    return round(float(v), 2)
                except (TypeError, ValueError):
                    return v
            lines.append(
                f"- 现货 {_n(row.get('spot_price'))}，主力 {row.get('dominant_contract')} {_n(row.get('dominant_contract_price'))}，"
                f"基差 {_n(row.get('dom_basis'))}（口径=主力-现货，{float(row.get('dom_basis_rate') or 0) * 100:+.1f}%；负值=现货升水/盘面贴水，正值=期货升水）"
            )
    except Exception:
        pass
    text = "\n".join(lines)
    _fund_cache[key] = (loop_now, text, FUND_TTL if text else FUND_EMPTY_TTL)
    return text


# ---------------------------------------------------------------- 多品种识别：问题提到谁，就把谁的数据带上

_INTL_CN = {"WTI": "WTI", "布伦特": "BRENT", "黄金": "GOLD", "美元指数": "DXY"}
# 静态品种名映射（前缀→中文常用名）——识别不依赖目录网络（新浪限流时目录为空，
# 此前问"纯碱/玻璃"识别不到的根因）；名称取日常叫法，匹配"包含"即可
_PREFIX_CN = {
    "RB": "螺纹钢", "HC": "热卷", "I": "铁矿石", "J": "焦炭", "JM": "焦煤",
    "CU": "铜", "AL": "铝", "ZN": "锌", "PB": "铅", "NI": "镍", "SN": "锡", "SS": "不锈钢",
    "AU": "黄金", "AG": "白银", "SC": "原油", "FU": "燃油", "LU": "低硫燃油", "BU": "沥青", "RU": "橡胶", "NR": "20号胶", "SP": "纸浆",
    "M": "豆粕", "RM": "菜粕", "Y": "豆油", "P": "棕榈油", "OI": "菜油", "A": "豆一", "B": "豆二",
    "TA": "PTA", "MA": "甲醇", "EG": "乙二醇", "EB": "苯乙烯", "PP": "聚丙烯", "L": "塑料", "V": "PVC", "PG": "液化气",
    "FG": "玻璃", "SA": "纯碱", "UR": "尿素", "C": "玉米", "CS": "淀粉", "CF": "棉花", "SR": "白糖",
    "JD": "鸡蛋", "LH": "生猪", "LC": "碳酸锂", "SI": "工业硅", "EC": "集运欧线",
    "IF": "沪深300", "IH": "上证50", "IC": "中证500", "IM": "中证1000", "T": "国债",
}
_Q_CODE_NOISE = {"AI", "OK", "VS", "PS", "PM", "AM"}


def _detect_question_symbols(text: str, exclude: Optional[str] = None, limit: int = 3) -> list[str]:
    """从问题文本识别提及的品种（合约代码 SA0/FG 或中文名 纯碱/玻璃/黄金…），
    返回主力合约符号列表（排除 exclude，最多 limit 个）。
    数字位 1-2 位的跳过（MA5/MA20 等指标词与合约前缀 MA 冲突）。"""
    raw = text or ""
    t = raw.upper()
    found: list[str] = []

    def _add(sym: str):
        sym = sym.upper()
        if sym and sym != (exclude or "").upper() and sym not in found:
            found.append(sym)

    for m in re.finditer(r"\b([A-Z]{1,2})(\d{0,4})\b", t):
        pfx, digits = m.group(1), m.group(2)
        if pfx in _Q_CODE_NOISE:
            continue
        if pfx == "MA" and digits in ("5", "10", "20", "30", "60", "120", "250"):
            continue  # MA5/MA20 均线指标 ≠ 甲醇 MA0/MA605 合约
        if pfx in _PREFIX_CN:
            _add(f"{pfx}0")
        elif m.group(0) in _dir_cache.get("data", {}):
            _add(m.group(0))
    for cn, sym in _INTL_CN.items():
        if cn in raw or cn in t:
            _add(sym)
    for pfx, cn in _PREFIX_CN.items():
        if cn and cn in raw:
            _add(f"{pfx}0")
    return found[:limit]


async def _symbol_snapshot_block(symbol: str) -> str:
    """多品种问题的紧凑快照（每品种约 300 字）：最新价/涨跌、持仓量与增减仓方向、
    日内结构（含高低点出现时间）、资金情绪评分、库存/现货/基差、技术指标要点。
    任一段失败静默跳过——把"空头主动打压还是多头踩踏、情绪还是现舱在塌"
    这类问题的判据全部交给 AI。"""
    lines = []
    try:
        q = await fetch_quote(symbol)
        if q and q.get("last") is not None:
            pct = f"{q['change_pct']:+.2f}%" if q.get("change_pct") is not None else "--"
            oi_txt = f"，持仓 {q.get('position')}" if q.get("position") is not None else ""
            try:
                daily = await get_daily(symbol)
                holds = [_num(d.get("hold")) for d in daily[-2:]]
                if holds[0] and holds[1]:
                    dif = holds[1] - holds[0]
                    oi_txt = (f"，持仓 {q.get('position')}（昨日 {holds[0]:.0f}，"
                              f"{'增仓' if dif >= 0 else '减仓'} {abs(dif):.0f}——"
                              f"{'空头主动进场或多头反手打压' if dif >= 0 else '多头离场或空头回补'}需结合价格方向判读）")
            except Exception:
                pass
            lines.append(f"- 最新 {q['last']}（{pct}）{oi_txt}")
    except Exception:
        pass
    try:
        intra = await _intraday_summary(symbol)
        if intra:
            lines.append(f"- 日内：{intra}")
    except Exception:
        pass
    try:
        fs = fund_sentiment(symbol, await get_daily(symbol))
        if fs:
            lines.append(f"- 资金情绪：{_fund_text(fs)}")
    except Exception:
        pass
    try:
        fund_txt = await _variety_fundamentals(symbol)
        if fund_txt:
            lines.append("- 基本面：" + fund_txt.replace("\n", "；"))
    except Exception:
        pass
    try:
        ind = await get_indicators(symbol)
        v = ind["values"]
        sigs = "、".join(s["name"] for s in ind["signals"][:3]) or "无"
        lines.append(
            f"- 指标：收 {v.get('close')}，MA5 {v.get('ma5')}/MA20 {v.get('ma20')}，"
            f"MACD 柱 {v.get('macd_hist')}，RSI6 {v.get('rsi6')}，KDJ {v.get('k')}/{v.get('d')}/{v.get('j')}，"
            f"BOLL {v.get('boll_low')}~{v.get('boll_up')}；信号：{sigs}"
        )
    except Exception:
        pass
    return "\n".join(lines)


# ---------------------------------------------------------------- 国际盘监控（WTI/布伦特/黄金/美元指数）

# 新浪 hq 实时接口（字面量 URL，固定四品种，一次请求全部返回）
_INTL_HQ_URL = "https://hq.sinajs.cn/list=hf_CL,hf_OIL,hf_GC,DINIW"
_INTL_DEFS = [
    {"symbol": "WTI", "name": "WTI 原油", "threshold": 1.0},
    {"symbol": "BRENT", "name": "布伦特原油", "threshold": 1.0},
    {"symbol": "GOLD", "name": "COMEX 黄金", "threshold": 0.6},
    {"symbol": "DXY", "name": "美元指数", "threshold": 0.3},
]
_intl_cache: dict = {"ts": 0.0, "items": [], "by_sym": {}}
INTL_TTL = 30.0


def _parse_hf(fields: list) -> dict:
    """新浪 hf_ 外盘格式：[0]最新 [2]买 [3]卖 [4]高 [5]低 [6]时间 [7]昨收 [8]开 [12]日期 [13]名称"""
    def f(i):
        try:
            return float(fields[i])
        except (ValueError, IndexError):
            return None
    last, prev = f(0), f(7)
    chg = round(last - prev, 3) if last is not None and prev else None
    pct = round(chg / prev * 100, 2) if chg is not None and prev else None
    return {
        "last": last, "open": f(8), "high": f(4), "low": f(5),
        "prev_settle": prev, "chg": chg, "chg_pct": pct,
        "time": fields[6] if len(fields) > 6 else "",
        "date": fields[12] if len(fields) > 12 else "",
    }


def _parse_diniw(fields: list) -> dict:
    """新浪 DINIW 美元指数格式：[0]时间 [1]最新 [3]昨收 [5]开 [6]高 [7]低 [9]名称 [10]日期"""
    def f(i):
        try:
            return float(fields[i])
        except (ValueError, IndexError):
            return None
    last, prev = f(1), f(3)
    chg = round(last - prev, 3) if last is not None and prev else None
    pct = round(chg / prev * 100, 2) if chg is not None and prev else None
    return {
        "last": last, "open": f(5), "high": f(6), "low": f(7),
        "prev_settle": prev, "chg": chg, "chg_pct": pct,
        "time": fields[0] if fields else "",
        "date": fields[10] if len(fields) > 10 else "",
    }


async def fetch_intl(force: bool = False) -> list[dict]:
    """四国际品种实时快照（新浪 hq 单请求，30 秒缓存）"""
    loop_now = asyncio.get_event_loop().time()
    if not force and _intl_cache["items"] and loop_now - _intl_cache["ts"] < INTL_TTL:
        return _intl_cache["items"]
    import requests
    r = await asyncio.to_thread(
        requests.get, _INTL_HQ_URL,
        headers={"Referer": "https://finance.sina.com.cn"}, timeout=10,
    )
    r.encoding = "gbk"
    by_code = {}
    for line in r.text.strip().splitlines():
        if '="' not in line:
            continue
        code = line.split("hq_str_")[1].split("=")[0].strip()
        raw = line.split('="', 1)[1].rstrip('";')
        by_code[code] = [x for x in raw.split(",")]
    code_of = {0: "hf_CL", 1: "hf_OIL", 2: "hf_GC", 3: "DINIW"}
    rows = []
    for i, d in enumerate(_INTL_DEFS):
        row = {**d}
        raw_fields = by_code.get(code_of[i])
        if raw_fields:
            parsed = _parse_diniw(raw_fields) if d["symbol"] == "DXY" else _parse_hf(raw_fields)
            row.update(parsed)
        else:
            row.update({"last": None, "chg_pct": None})
        rows.append(row)
    _intl_cache["items"] = rows
    _intl_cache["by_sym"] = {r["symbol"]: r for r in rows}
    _intl_cache["ts"] = loop_now
    return rows


@app.get("/api/intl")
async def intl(force: int = 0):
    """国际盘监控：WTI / 布伦特 / 国际黄金 / 美元指数 实时快照"""
    items = await fetch_intl(force=bool(force))
    return {"ok": True, "items": items}

def _variety_profile(symbol: str) -> str:
    p = _variety_prefix(symbol)
    return VARIETY_PROFILE.get(p, "")





def _variety_news(symbol: str, limit: int = 8) -> list[dict]:
    """从要闻缓存中过滤与品种相关的条目"""
    kws = VARIETY_NEWS_KW.get(_variety_prefix(symbol))
    if not kws or not _news_cache.get("items"):
        return []
    hits = []
    for it in _news_cache["items"]:
        text = (it.get("title", "") + " " + it.get("summary", "")[:100]).lower()
        if any(k.lower() in text for k in kws):
            hits.append(it)
        if len(hits) >= limit:
            break
    return hits


async def _call_ai_simple(messages: list[dict], max_tokens: int = 2048) -> str:
    """供盯盘等内部功能调用的轻量 AI 接口（主服务商失败时自动兜底下一家）。

    注意：推理型模型（如 deepseek-v4-pro）会先消耗大量 token 生成思维链，
    max_tokens 给足才能保证正文（content）非空。
    全部失败时抛出的错误包含**每家服务商的具体原因**——盯盘事件里会原样展示，
    用户一眼看出该修哪个 Key（此前笼统的"调用失败"无法定位）。
    """
    import logging
    logger = logging.getLogger("uvicorn.error")
    cfg = load_config()
    candidates = _llm_candidates(cfg)
    if not candidates:
        raise RuntimeError("未配置任何 API Key（⚙ 设置 → AI 服务配置）")
    problems: list[str] = []
    for idx, cand in enumerate(candidates):
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                resp = await client.post(
                    f"{cand['base_url']}/chat/completions",
                    headers={"Authorization": f"Bearer {cand['api_key']}"},
                    json={
                        "model": cand["model"],
                        "messages": messages,
                        "temperature": 0.4,
                        "max_tokens": min(2048, max_output_for(cand["model"])),
                    },
                )
        except httpx.HTTPError as e:
            problems.append(f"{cand['provider']} 网络异常({type(e).__name__})")
            continue
        if resp.status_code == 200:
            try:
                content = (resp.json()["choices"][0]["message"].get("content") or "").strip()
            except Exception:
                content = ""
            if content:
                if idx > 0:
                    logger.info(f"[ai-simple] 主服务商不可用，由 {cand['provider']}/{cand['model']} 兜底")
                _note_provider_ok(cand["provider"])
                return content
            problems.append(f"{cand['provider']} 返回空内容")
            continue
        if _is_provider_hard_error(resp):
            _note_provider_fail(cand["provider"])
        reason = _resp_reason(resp)
        problems.append(f"{cand['provider']} {resp.status_code}{('：' + reason) if reason else ''}")
    raise RuntimeError("AI 服务全部不可用 → " + "；".join(problems))

async def _call_ai_with_fallback(messages: list[dict], max_tokens: int = 4096) -> str:
    """主模型优先；返回空或失败时自动切换到另一家已配置的服务商重试"""
    cfg = load_config()
    errors = []
    for p in [cfg["provider"]] + [x for x in PROVIDERS if x != cfg["provider"]]:
        if not cfg["api_keys"].get(p):
            continue
        try:
            out = await _call_ai_simple(messages, max_tokens=max_tokens, provider=p)
            if out:
                return out
            errors.append(f"{p}: 空输出")
        except Exception as e:
            errors.append(f"{p}: {type(e).__name__}")
    raise RuntimeError("AI 无有效输出（" + "；".join(errors) + "）")


async def _ai_comment_for_event(event: dict):
    """异动事件的 AI 一句话解读（异步补充到事件上）"""
    name = event.get("name") or ""
    if not name:
        try:
            directory = await get_directory()
            name = directory.get(event["symbol"], {}).get("name", "")
        except Exception:
            name = ""
    pos = event.get("pos_chg")
    pos_line = f"，近 15 分钟持仓{'增加' if pos > 0 else '减少'} {abs(pos):.0f} 手" if pos else ""
    prompt = (
        f"你是期货盯盘助手。刚检测到异动：{event['symbol']}（{name}）最近 5 分钟"
        f"{'急涨' if event['dir'] == 'up' else '跳水'} {event['chg5']:+.2f}%，现价 {event['price']}；"
        f"日内 {event['day_chg'] if event['day_chg'] is not None else '--'}%{pos_line}。"
        f"请用一两句话点出可能的驱动因素和需要关注的价位/风险，口语化，80 字以内，不构成投资建议。"
    )
    try:
        reply = await _call_ai_simple([{"role": "user", "content": prompt}])
        event["ai"] = reply or "（AI 未返回有效解读，可稍后重试）"
    except Exception as e:
        # 展示具体原因（哪家 Key 失效/哪家限流），而不是笼统的"调用失败"
        event["ai"] = f"（AI 解读失败：{str(e)[:220]}）"
    # 推送飞书群（配置了 webhook 时；上游整合）
    c15 = event.get("chg15")
    await _feishu_push(
        f"🤖 盯盘异动\n"
        f"{event['symbol']}（{name}）5分钟{'急涨' if event['dir'] == 'up' else '跳水'} {event['chg5']:+.2f}%，"
        f"现价 {event['price']}\n"
        f"日内 {event['day_chg'] if event['day_chg'] is not None else '--'}%{pos_line}\n\n"
        f"💡 {str(event['ai'])[:600]}"
    )


async def _check_symbol(sym: str, mult: float):
    try:
        rows = await get_minute(sym, "1")
    except Exception:
        return
    if len(rows) < 3:
        return
    last = rows[-1]
    ref5 = rows[-6] if len(rows) >= 6 else rows[0]
    ref15 = rows[-16] if len(rows) >= 16 else rows[0]
    if not last.get("close") or not ref5.get("close"):
        return
    chg5 = (last["close"] / ref5["close"] - 1) * 100
    chg15 = (last["close"] / ref15["close"] - 1) * 100 if ref15.get("close") else 0.0
    threshold = _monitor_threshold(sym, mult)
    if abs(chg5) < threshold:
        return

    direction = "up" if chg5 > 0 else "down"
    now_ts = asyncio.get_event_loop().time()
    if now_ts - _MONITOR["cooldown"].get((sym, direction), 0) < MONITOR_COOLDOWN:
        return
    _MONITOR["cooldown"][(sym, direction)] = now_ts

    quote = _quote_cache.get(sym, (0, {}))[1]
    directory = await get_directory()
    pos_chg = (last["close"] and last.get("position") and ref15.get("position")
               and last["position"] - ref15["position"]) or None
    event = {
        "id": f"{sym}-{direction}-{int(now_ts)}",
        "ts": int(datetime.now().timestamp() * 1000),
        "symbol": sym,
        "name": directory.get(sym, {}).get("name", ""),
        "dir": direction,
        "chg5": round(chg5, 2),
        "chg15": round(chg15, 2),
        "day_chg": quote.get("change_pct"),
        "price": last["close"],
        "from": ref5["close"],
        "pos_chg": pos_chg,
        "threshold": round(threshold, 2),
        "ai": None,
    }
    _MONITOR["events"].append(event)
    if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
        _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
    asyncio.create_task(_ai_comment_for_event(event))


async def monitor_loop():
    """AI 盯盘双轨：
    - 国际品种（WTI/布伦特/黄金/美元指数）：24 小时监控（采样对比 5 分钟急涨急跌）
    - 国内品种（自选 + 持仓）：仅国内交易时段监控（1 分钟线检测）"""
    await asyncio.sleep(20)  # 等待预热与首轮行情
    hist: list[tuple[float, dict]] = []  # [(loop_ts, {sym: last})]
    while True:
        try:
            mon_cfg = (load_config().get("monitor") or DEFAULT_CONFIG["monitor"])
            if mon_cfg.get("enabled", True):
                # 轨道 1：国际品种 24 小时
                try:
                    items = await fetch_intl()
                except Exception:
                    items = _intl_cache.get("items") or []
                now_ts = asyncio.get_event_loop().time()
                prices = {it["symbol"]: it.get("last") for it in items if it.get("last") is not None}
                if prices:
                    hist.append((now_ts, prices))
                    hist = hist[-40:]  # 保留 ~20 分钟采样
                    _check_intl(hist, mon_cfg.get("sensitivity", 1.0))
                # 轨道 2：国内品种按各自交易时段（SC/AU/AG 夜盘至 02:30，金属至 01:00，多数至 23:00）
                if is_trading_time():
                    symbols = set(_MONITOR["watch"])
                    try:
                        symbols |= {
                            str(e["symbol"]).upper()
                            for e in _load_discipline_log()
                            if e.get("allowed") and e.get("status") == "open"
                        }
                    except Exception:
                        pass
                    for sym in sorted(symbols):
                        if domestic_session_active(_variety_prefix(sym)):
                            await _check_symbol(sym, mon_cfg.get("sensitivity", 1.0))
                _MONITOR["last_check"] = datetime.now().strftime("%H:%M:%S")
        except Exception:
            pass
        await asyncio.sleep(MONITOR_INTERVAL)


TRAIL_TEXT = {
    "arm": "🎯 {sym} {d}浮盈 +{pnl:.0f} 点，移动止盈激活：峰值 {peak} 回撤 {points:.0f} 点即离场（当前追踪线 {line}）",
    "partial": "📍 {sym} {d}浮盈 +{pnl:.0f} 点已达目标位：建议减仓 1/2，剩余改用移动止盈（追踪线 {line}）",
    "trigger": "✅ {sym} {d}移动止盈触发：{verb}追踪线 {line}，建议离场锁盈（当前浮盈 {pnl:+.0f} 点）",
}


async def trail_loop():
    """动态止盈巡检：对交易日志中的持仓单每 30 秒更新追踪止盈状态，触发提示进异动流 + 飞书"""
    await asyncio.sleep(25)
    while True:
        try:
            now = datetime.now()
            if is_trading_time(now) or (now.weekday() < 5 and 20 <= now.hour < 24):
                trades = _load_trades()
                open_trades = [t for t in trades if t.get("status") == "open" and t.get("trail")]
                if open_trades:
                    loop_now = asyncio.get_event_loop().time()
                    prices: dict[str, float] = {}
                    for sym in {t["symbol"] for t in open_trades}:
                        ts, q = _quote_cache.get(sym, (0, {}))
                        price = (q or {}).get("last")
                        if not price or loop_now - ts > 10:
                            try:
                                price = (await fetch_quote(sym)).get("last")
                            except Exception:
                                price = None
                        if price:
                            prices[sym] = price
                    changed = False
                    for t in open_trades:
                        price = prices.get(t["symbol"])
                        if not price:
                            continue
                        events = _trail_state(t, price)
                        if events:
                            changed = True
                            d = "多" if t["direction"] == "long" else "空"
                            for ev in events:
                                text = TRAIL_TEXT[ev["etype"]].format(
                                    sym=t["symbol"], d=d, pnl=ev["pnl"],
                                    peak=round(t["trail"]["peak"], 1), points=t["trail"]["points"],
                                    line=ev["line"], verb="跌破" if t["direction"] == "long" else "升破",
                                )
                                _MONITOR["events"].append({
                                    "id": f"{t['symbol']}-trail-{ev['etype']}-{t['id']}",
                                    "ts": int(datetime.now().timestamp() * 1000),
                                    "kind": "trail", "etype": ev["etype"],
                                    "symbol": t["symbol"], "dir": "up" if t["direction"] == "long" else "down",
                                    "price": price, "line": ev["line"], "pnl": ev["pnl"],
                                    "text": text,
                                    # 兼容字段：旧版前端按普通异动事件渲染时不显示 undefined
                                    "chg5": 0.0, "chg15": 0.0, "threshold": 0.0, "intl": True, "ai": "",
                                })
                                asyncio.create_task(_feishu_push(text))
                    if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
                        _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
                    if changed:
                        _save_trades(trades)
        except Exception:
            pass
        await asyncio.sleep(30)
def _check_intl(hist: list, sensitivity: float):
    """用历史采样检测四国际品种 5 分钟急涨急跌（阈值 = 品种基准 × 灵敏度）"""
    now_ts = hist[-1][0]
    cur = hist[-1][1]
    ref5 = next((p for t, p in reversed(hist) if now_ts - t >= 280), None)
    if not ref5 or not cur:
        return
    for d in _INTL_DEFS:
        sym = d["symbol"]
        last, base = cur.get(sym), ref5.get(sym)
        if not last or not base:
            continue
        chg5 = (last / base - 1) * 100
        threshold = d["threshold"] * sensitivity
        if abs(chg5) < threshold:
            continue
        direction = "up" if chg5 > 0 else "down"
        if now_ts - _MONITOR["cooldown"].get((sym, direction), 0) < MONITOR_COOLDOWN:
            continue
        _MONITOR["cooldown"][(sym, direction)] = now_ts
        snap = _intl_cache["by_sym"].get(sym, {})
        event = {
            "id": f"{sym}-{direction}-{int(now_ts)}",
            "ts": int(datetime.now().timestamp() * 1000),
            "symbol": sym,
            "name": d["name"],
            "dir": direction,
            "chg5": round(chg5, 2),
            "chg15": None,
            "day_chg": snap.get("chg_pct"),
            "price": last,
            "from": base,
            "pos_chg": None,
            "threshold": round(threshold, 2),
            "ai": None,
        }
        _MONITOR["events"].append(event)
        if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
            _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
        asyncio.create_task(_ai_comment_for_event(event))

@app.get("/api/monitor/events")
async def monitor_events(limit: int = 30):
    mon_cfg = (load_config().get("monitor") or DEFAULT_CONFIG["monitor"])
    return {
        "ok": True,
        "enabled": mon_cfg.get("enabled", True),
        "focus": mon_cfg.get("focus", []),
        "sensitivity": mon_cfg.get("sensitivity", 1.0),
        "last_check": _MONITOR["last_check"],
        "events": list(reversed(_MONITOR["events"]))[:limit],
    }


class MonitorCfgIn(BaseModel):
    enabled: bool = True
    sensitivity: float = 1.0


@app.post("/api/monitor/config")
async def set_monitor_config(body: MonitorCfgIn):
    cfg = load_config()
    mon = cfg.get("monitor") or dict(DEFAULT_CONFIG["monitor"])
    mon["enabled"] = body.enabled
    mon["sensitivity"] = round(min(max(body.sensitivity, 0.25), 3.0), 2)
    cfg["monitor"] = mon
    save_config(cfg)
    return {"ok": True}


@app.api_route("/api/monitor/test", methods=["GET", "POST"])
async def monitor_test():
    """构造一条模拟异动事件，用于端到端验证盯盘提醒链路。

    支持 GET：浏览器地址栏直接打开该地址即可触发测试。
    """
    directory = await get_directory()
    sym = "SC0"
    try:
        rows = await get_minute(sym, "1")
        last_close = rows[-1]["close"] or 585.0
    except Exception:
        last_close = 585.0
    event = {
        "id": f"{sym}-test-{int(asyncio.get_event_loop().time() * 1000)}",
        "ts": int(datetime.now().timestamp() * 1000),
        "symbol": sym,
        "name": directory.get(sym, {}).get("name", "上海原油连续"),
        "dir": "up",
        "chg5": 0.85,
        "chg15": 1.2,
        "day_chg": 1.5,
        "price": last_close,
        "from": round(last_close / 1.0085, 1),
        "pos_chg": 1234,
        "threshold": 0.5,
        "ai": None,
        "simulated": True,
    }
    _MONITOR["events"].append(event)
    asyncio.create_task(_ai_comment_for_event(event))
    return {"ok": True, "id": event["id"]}


# ---------------------------------------------------------------- 交易纪律（开仓前检查与许可）

DISCIPLINE_FILE = BASE_DIR / "discipline_log.json"


async def _symbol_closes(symbol: str) -> dict:
    """单品种 {日期: 收盘价}（国内 sina 日线 / 国际 foreign_hist 自动分流）"""
    if symbol in INTL_SYMBOLS:
        df = await call_ak(ak.futures_foreign_hist, symbol=symbol)
        return {str(r["date"])[:10]: _num(r["close"]) for r in df.to_dict("records") if _num(r.get("close"))}
    daily = await get_daily(symbol)
    return {str(r["date"]): r["close"] for r in daily if r.get("close")}


async def _aligned_closes(syms: list[str], limit: int) -> tuple[list[str], dict]:
    """多品种日线收盘价按日期对齐（支持国内+国际混合），返回（公共日期列表, {sym: {date: close}}）"""
    closes = {}
    for s in syms:
        closes[s] = await _symbol_closes(s)
    common = sorted(set.intersection(*[set(c) for c in closes.values()]))[-limit:]
    return common, closes
def _load_discipline_log() -> list[dict]:
    if DISCIPLINE_FILE.exists():
        try:
            return json.loads(DISCIPLINE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []

def _save_discipline_log(log: list[dict]) -> None:
    try:
        DISCIPLINE_FILE.write_text(
            json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass


def _iso_week(dt: datetime) -> str:
    """ISO 周标识（用于周交易次数统计）"""
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


def discipline_stats(log: list[dict]) -> dict:
    """从交易日志统计今日/本周次数、日内盈亏、各品种未平仓加仓数、
    连续纪律天数与情绪归因（哪种情绪下最容易被拒绝）"""
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    week = _iso_week(now)
    today_trades = week_trades = 0
    today_pnl = 0.0
    open_adds: dict[str, int] = {}
    mood_total: dict[str, int] = {}
    mood_rejected: dict[str, int] = {}
    for e in log:
        ts = str(e.get("ts", ""))
        d = ts[:10]
        try:
            w = _iso_week(datetime.fromisoformat(ts))
        except Exception:
            w = ""
        if e.get("allowed") and d == today:
            today_trades += 1
        if e.get("allowed") and w == week:
            week_trades += 1
        if d == today:
            pnl = e.get("pnl_pct")
            if isinstance(pnl, (int, float)):
                today_pnl += float(pnl)
        if e.get("allowed") and e.get("status") == "open":
            key = f'{e.get("symbol")}:{e.get("side")}'
            open_adds[key] = open_adds.get(key, 0) + (1 if e.get("is_add") else 0)
        mood = e.get("mood") or "calm"
        mood_total[mood] = mood_total.get(mood, 0) + 1
        if not e.get("allowed"):
            mood_rejected[mood] = mood_rejected.get(mood, 0) + 1

    # 连续纪律天数：从今天往回数；被拒绝=系统拦截成功不断链，
    # 只有"通过但带违反（无视警告硬开）"才断链。
    by_day: dict[str, list[dict]] = {}
    for e in log:
        by_day.setdefault(str(e.get("ts", ""))[:10], []).append(e)
    streak = 0
    day = now.date()
    from datetime import timedelta as _td
    for _ in range(365):
        ds = day.strftime("%Y-%m-%d")
        entries = by_day.get(ds, [])
        if entries:
            forced = [e for e in entries if e.get("allowed") and e.get("violations")]
            if forced:
                break  # 带违反强行开仓，纪律链断裂
            streak += 1
        day = day - _td(days=1)
    # 已平仓深度统计：胜率 / 累计已实现 / 平均盈亏 / 最大单笔亏 / 实际 R 倍数
    closed = [e for e in log if e.get("status") == "closed" and isinstance(e.get("pnl_pct"), (int, float))]
    pnls = [float(e["pnl_pct"]) for e in closed]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    rs = [float(e["r_multiple"]) for e in closed if isinstance(e.get("r_multiple"), (int, float))]
    perf = {
        "closed_count": len(closed),
        "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else None,
        "realized_total": round(sum(pnls), 2) if pnls else None,
        "avg_win": round(sum(wins) / len(wins), 2) if wins else None,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else None,
        "max_loss": round(min(pnls), 2) if pnls else None,
        "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
    }
    # AI 评审价值统计：当初 AI 判"值得执行"且已平仓的实际表现；
    # 反事实验证：AI 判"不值得"被拦的申请，若执行按当前价的假想盈亏（负=拦得值）
    ai_ok = [e for e in closed if (e.get("ai_review") or {}).get("decision_correct")]
    ai_pnls = [float(x["pnl_pct"]) for x in ai_ok]
    perf["ai_approved"] = {
        "count": len(ai_ok),
        "win_rate": round(sum(1 for p in ai_pnls if p > 0) / len(ai_ok) * 100, 1) if ai_ok else None,
        "avg_pnl": round(sum(ai_pnls) / len(ai_pnls), 2) if ai_pnls else None,
    }
    hypo_pts = []
    for e in log:
        if e.get("allowed"):
            continue  # 只看被拒的
        ai_r = e.get("ai_review") or {}
        if ai_r.get("decision_correct") is not False:
            continue  # 且是 AI 否决的（R014）
        cached = _quote_cache.get(str(e.get("symbol")))
        last = cached[1].get("last") if cached else None
        if last is None or not e.get("entry"):
            continue
        hypo_pts.append((float(last) - float(e["entry"])) * (1 if e.get("side") == "long" else -1))
    if hypo_pts:
        perf["ai_rejected_hypothetical"] = {
            "count": len(hypo_pts),
            "avg_points": round(sum(hypo_pts) / len(hypo_pts), 1),
            "would_lose": sum(1 for p in hypo_pts if p < 0),
        }
    return {
        "today_trades": today_trades,
        "week_trades": week_trades,
        "today_pnl": round(today_pnl, 2),
        "open_adds": open_adds,
        "open_count": sum(
            1 for e in log if e.get("allowed") and e.get("status") == "open"
        ),
        "discipline_streak": streak,
        "perf": perf,
        "mood_stat": {
            m: {"total": t, "rejected": mood_rejected.get(m, 0)}
            for m, t in sorted(mood_total.items(), key=lambda kv: -kv[1])
        },
    }


class DisciplineCheckIn(BaseModel):
    symbol: str
    side: str                    # long / short
    entry: float                 # 计划入场价
    sl: float                    # 止损价
    tp: Optional[float] = None   # 目标价
    # 全客观化：加仓由日志自动推导、理由由 AI 生成、情绪由 AI 检测、风险由 ATR 口径自动评估


async def _llm_json(prompt: str, max_tokens: int = 0) -> dict:
    """调用已配置的 LLM 输出结构化 JSON（纪律 AI 审查用）。
    temperature 低以稳定格式；容错提取 JSON 块（模型可能加 ```json 包裹）。
    推理型模型思维链会消耗大量 token，max_tokens 按模型上限给足。"""
    cfg = load_config()
    candidates = _llm_candidates(cfg)
    if not candidates:
        raise HTTPException(status_code=400, detail="尚未配置 API Key——主观项已全部改为 AI 判定，请先在「⚙ AI 设置」中配置")
    import logging
    logger = logging.getLogger("uvicorn.error")
    import time as _time
    t0 = _time.time()
    for idx, cand in enumerate(candidates):
        base_url, api_key, model = cand["base_url"], cand["api_key"], cand["model"]
        max_tokens = max(max_tokens or 0, max_output_for(model))
        async with httpx.AsyncClient(timeout=180) as client:
            def build(mt: int):
                return client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.2,
                        "max_tokens": mt,
                    },
                )
            resp = await build(max_tokens)
            if resp.status_code == 400 and "max_tokens" in resp.text.lower() and max_tokens > 4096:
                max_tokens = 4096
                resp = await build(max_tokens)
        if _is_provider_hard_error(resp) and idx < len(candidates) - 1:
            logger.info(f"[discipline-ai] {cand['provider']} 硬错误 {resp.status_code}，切换兜底")
            _note_provider_fail(cand["provider"])
            continue
        if resp.status_code == 401:
            raise HTTPException(status_code=401, detail="API Key 无效，请检查 AI 设置")
        if resp.status_code == 429:
            raise HTTPException(status_code=429, detail="AI 服务限流，请稍后重试")
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"AI 服务返回 {resp.status_code}")
        try:
            choice = resp.json()["choices"][0]
            content = (choice["message"].get("content") or "").strip()
        except Exception:
            raise HTTPException(status_code=502, detail="AI 返回内容无法解析")
        if not content:
            finish = choice.get("finish_reason", "?")
            raise HTTPException(
                status_code=502,
                detail=f"AI 返回空内容（finish_reason={finish}，max_tokens={max_tokens} 可能被思维链耗尽，请重试或换轻量模型）",
            )
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            raise HTTPException(status_code=502, detail=f"AI 未按 JSON 输出：{content[:120]}")
        try:
            out = json.loads(m.group(0))
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail=f"AI 的 JSON 无法解析：{content[:120]}")
        logger.info(f"[discipline-ai] {cand['provider']}/{model} 判定完成，耗时 {_time.time() - t0:.0f}s"
                    + ("（兜底）" if idx > 0 else ""))
        _note_provider_ok(cand["provider"])
        return out
    raise HTTPException(status_code=502, detail="AI 调用失败")


def _rule(rid, name, severity, ok, detail):
    return {
        "id": rid,
        "name": name,
        "severity": severity,
        "status": "pass" if ok else "violation",
        "detail": detail,
    }


@app.post("/api/discipline/check")
async def discipline_check(body: DisciplineCheckIn):
    """开仓前纪律检查 v2：客观数据规则 + AI 主观审查。
    趋势基础/信号计数/次数/间距/盈亏比由数据判定；
    反转确认、品种认知、冲动检测、决策评估全部由 AI 判定（无自评勾选）。
    AI 具有否决权（R014），任何致命违反即禁止开仓。"""
    cfg = load_config()["discipline"]
    symbol = body.symbol.strip().upper()
    side = "long" if body.side.lower().startswith("l") else "short"
    log = _load_discipline_log()
    stats = discipline_stats(log)
    rule_map: dict[str, dict] = {}

    # R001 大周期趋势（客观基础：位置与斜率；反转豁免由 AI 判定）
    try:
        records = (await get_daily(symbol))[-25:]
        closes = [float(r["close"]) for r in records if r.get("close")]
        ma20_now = sum(closes[-20:]) / 20
        ma20_prev = sum(closes[-23:-3]) / 20
        slope_up = ma20_now > ma20_prev
        above = closes[-1] > ma20_now
        if side == "long":
            right_side = above
            trendy = above and slope_up
        else:
            right_side = not above
            trendy = (not above) and (not slope_up)
        trend_detail = (
            f"收盘 {closes[-1]:.1f} {'>' if above else '<'} MA20 {ma20_now:.1f}，"
            f"MA20 三日{'上行' if slope_up else '走平/下行'}"
        )
    except Exception as e:
        right_side = trendy = None
        trend_detail = f"日线数据获取失败：{e}"

    # ATR(14) 与参考收盘价（R002 力度参考 + 头寸建议共用）
    atr14: Optional[float] = None
    ref_close: Optional[float] = None
    try:
        recs_atr = (await get_daily(symbol))[-15:]
        trs = []
        for i in range(1, len(recs_atr)):
            h, l, pc = float(recs_atr[i]["high"]), float(recs_atr[i]["low"]), float(recs_atr[i - 1]["close"])
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
        atr14 = sum(trs[-14:]) / min(14, len(trs))
        ref_close = float(recs_atr[-1]["close"])
    except Exception:
        pass

    # R002 入场信号（客观基础：同向技术信号计数；反转豁免由 AI 判定）
    confirms: list[str] = []
    ind_signals: list[dict] = []
    try:
        ind = await get_indicators(symbol)
        ind_signals = ind["signals"]
        dirkey = "bull" if side == "long" else "bear"
        confirms = [s["name"] for s in ind_signals if s.get("dir") == dirkey]
    except Exception:
        pass

    # R003 品种在自选池内
    universe = [u.strip().upper() for u in cfg.get("universe", []) if str(u).strip()]
    rule_map["R003"] = _rule(
        "R003", "品种在自选池内", "严重",
        not universe or symbol in universe,
        f"自选池：{('、'.join(universe) if universe else '未限制')}",
    )

    # 加仓自动判定：存在同品种同方向未平仓记录 → 本次为加仓（客观推导，无需勾选）
    open_same = [
        e for e in log
        if e.get("allowed") and e.get("status") == "open"
        and e.get("symbol") == symbol and e.get("side") == side
    ]
    is_add = bool(open_same)

    # R005 梯度建仓间距：加仓时与最近一笔同方向未平仓入场价间距 ≥ 最小间距
    if is_add:
        last_entry = float(open_same[-1].get("entry") or 0)
        spacing = abs(body.entry - last_entry) / last_entry * 100 if last_entry else 0.0
        ok = spacing >= float(cfg.get("min_grid_spacing", 1.5))
        detail = f"检测到同方向未平仓位（自动判定为加仓），与上一档入场价 {last_entry:.1f} 间距 {spacing:.2f}%（要求 ≥ {cfg.get('min_grid_spacing')}%）"
    else:
        ok, detail = True, "无同方向未平仓位（首仓，间距规则不适用）"
    rule_map["R005"] = _rule("R005", "梯度建仓最小间距", "致命", ok, detail)

    # R006 加仓次数上限
    open_adds = stats["open_adds"].get(f"{symbol}:{side}", 0)
    max_adds = int(cfg.get("max_adds", 2))
    rule_map["R006"] = _rule(
        "R006", "同方向加仓次数上限", "致命",
        (not is_add) or open_adds < max_adds,
        f"当前未平仓加仓 {open_adds}/{max_adds} 次" + ("（本次为首仓）" if not is_add else ""),
    )

    # R007 日内止损线：今日已实现盈亏达到 -daily_stop% 即停手
    daily_stop = float(cfg.get("daily_stop", 3.0))
    rule_map["R007"] = _rule(
        "R007", "日内止损线（当日停手线）", "致命",
        stats["today_pnl"] > -daily_stop,
        f"今日已实现盈亏 {stats['today_pnl']:+.2f}%，止损线 -{daily_stop}%",
    )

    # R008 日内交易次数上限
    daily_max = int(cfg.get("daily_max_trades", 3))
    rule_map["R008"] = _rule(
        "R008", "日内交易次数上限", "致命",
        stats["today_trades"] < daily_max,
        f"今日已交易 {stats['today_trades']}/{daily_max} 次",
    )

    # R009 周交易次数上限
    weekly_max = int(cfg.get("weekly_max_trades", 5))
    rule_map["R009"] = _rule(
        "R009", "周交易次数上限", "致命",
        stats["week_trades"] < weekly_max,
        f"本周已交易 {stats['week_trades']}/{weekly_max} 次",
    )

    # R011 冷静期（客观部分：距上一笔申请间隔；冲动检测由 AI 判定）
    cooling = int(cfg.get("cooling_min", 30))
    last_ts = str(log[-1].get("ts", "")) if log else ""
    gap_ok = True
    gap_min = None
    if last_ts:
        try:
            gap_min = (datetime.now() - datetime.fromisoformat(last_ts)).total_seconds() / 60
            gap_ok = gap_min >= cooling
        except Exception:
            pass

    # R012 风险收益比 + 单笔风险自动评估（ATR 1N 口径：建议手数对应风险 ≤ 上限）
    risk_pct = None
    acct = float(cfg.get("account_size") or 0)
    mult = CONTRACT_MULTIPLIER.get(symbol[:2]) or CONTRACT_MULTIPLIER.get(symbol[:1])
    if acct > 0 and atr14 and mult:
        risk_amt = acct * float(cfg.get("risk_per_trade", 1.0)) / 100
        per_lot = atr14 * mult
        lots = int(risk_amt // per_lot) if per_lot > 0 else 0
        risk_pct = round(lots * per_lot / acct * 100, 2)  # 建议仓位的实际风险占比
    if body.tp and body.sl and body.entry:
        risk = abs(body.entry - body.sl)
        reward = abs(body.tp - body.entry)
        rr = reward / risk if risk else 0.0
        ok = rr >= float(cfg.get("min_rr", 2.0))
        detail = f"盈亏比 {rr:.2f}:1（要求 ≥ {cfg.get('min_rr')}:1）"
        if risk_pct is not None:
            cap = float(cfg.get("risk_per_trade", 1.0))
            detail += f"；按 ATR 建议仓位（≤{lots} 手）风险约 {risk_pct}%（上限 {cap}%）"
            if risk_pct > cap:
                ok = False
                detail = detail.replace("；按 ATR", "；⛔ 按 ATR")
        elif acct > 0:
            detail += "；未配置合约乘数，单笔上限未校验"
        else:
            detail += "；未设账户权益，单笔上限未校验（到风控参数填写后可自动评估）"
    else:
        rr, ok, detail = None, False, "未填写目标价，无法计算盈亏比"
    rule_map["R012"] = _rule("R012", "风险收益比与单笔风险上限", "致命", ok, detail)

    # R013 多时间框架共振：60 分钟 MA20 方向应与日线方向一致（铁律：ATR + 多时间框架验证）。
    # 60m 数据不可用时仅警告不拦单（数据源偶发失败不应真金白银买单）。
    try:
        minute = await get_minute(symbol, "60")
        closes60 = [float(r["close"]) for r in minute if r.get("close") is not None][-21:]
        if len(closes60) >= 21:
            ma60_now = sum(closes60[-20:]) / 20
            ma60_prev = sum(closes60[-21:-1]) / 20  # 滑动窗口：前 20 根
            m_up = ma60_now > ma60_prev
            side_ok = m_up if side == "long" else not m_up
            detail = f"60分钟 MA20 {ma60_now:.1f}（{'上行' if m_up else '下行'}）；共振{'一致' if side_ok else '背离'}"
            rule_map["R013"] = _rule("R013", "多时间框架共振（60分钟方向验证）", "严重", side_ok, detail)
        else:
            rule_map["R013"] = _rule("R013", "多时间框架共振（60分钟方向验证）", "严重", True,
                                     f"60分钟K线不足（{len(closes60)} 根），本次跳过共振验证")
    except Exception as e:
        rule_map["R013"] = _rule("R013", "多时间框架共振（60分钟方向验证）", "严重", True,
                                 f"60分钟数据不可用：{type(e).__name__}，本次跳过共振验证")

    # ---- 第二阶段：AI 主观审查（反转确认 / 品种认知 / 冲动检测 / 决策评估）----
    # token 优化：不再注入完整市场上下文（10 天 OHLC 明细/基本面框架等与纪律判定无关），
    # 只用实时快照（现价/盘口/日内结构/30m 节奏/指标/宏观要闻）——与快照内容不重复
    try:
        rt = await _realtime_snapshot(symbol)
        rt_lines = [
            f"【实时盘面（{rt['now']}）】",
            f"现价 {rt['quote']['last']}（涨跌 {rt['quote'].get('change_pct')}%），计划入场 {body.entry} "
            f"距现价 {(body.entry - rt['quote']['last']) / rt['quote']['last'] * 100:+.2f}%",
            f"盘口：{rt['book']}",
            f"日内结构：{rt['intra'] or '数据不足'}",
            f"30分钟节奏（近12根）：{rt['m30'] or '数据不足'}",
            f"日线指标：{rt['ind_txt']}",
            f"宏观要闻（特朗普/中东）：{rt['news']}",
        ]
        rt_block = "\n".join(rt_lines)
    except Exception:
        rt_block = "实时盘面不可用"
    sig_txt = "；".join(f"{s['name']}（{s.get('detail', '')}）" for s in ind_signals) or "无"
    today_pnl_txt = f"{stats['today_pnl']:+.2f}%"
    ai_prompt = f"""你是严格客观的期货交易纪律审查官。禁止迎合用户，只依据数据判定，证据不足即为 false。
交易者只提交了纯客观计划参数（品种/方向/入场/止损/目标），无任何自评或理由陈述——
你既要审查计划，也要**代为生成交易计划说明**（核心矛盾与关键价位）并**推断其情绪状态**。

{rt_block}

【该品种最新日线技术信号】
{sig_txt}

【规则引擎客观判定】
- 趋势：{trend_detail}（价格在正确一侧：{right_side}，均线顺势：{trendy}）
- 同向技术信号 {len(confirms)} 条：{'、'.join(confirms) or '无'}
- ATR14：{round(atr14, 1) if atr14 else '未知'}{f'（约 {atr14 / ref_close * 100:.2f}%）' if atr14 and ref_close else ''}
- 次数状态：今日 {stats['today_trades']}/{daily_max}、本周 {stats['week_trades']}/{weekly_max}，今日已实现 {today_pnl_txt}
- 距上笔申请间隔：{f'{gap_min:.0f} 分钟' if gap_min is not None else '无记录'}（冷静期要求 ≥ {cooling} 分钟）

【交易者提交的计划（纯客观参数）】
品种 {symbol} {'做多' if side == 'long' else '做空'}{'（自动判定为加仓）' if is_add else ''}，入场 {body.entry}，止损 {body.sl}，目标 {body.tp if body.tp else '未设'}，计划盈亏比 {round(rr, 2) if rr else '--'}

【判定任务】只输出一个 JSON 对象，不要输出任何其他文字：
{{
  "reversal_confirmed": <bool，从指标与行情数据判断趋势反转是否有≥2条客观依据（MACD金叉/KDJ低位金叉/站回MA20/均线拐头等），证据不足为 false>,
  "reversal_evidence": "<依据，分号分隔；无则写'证据不足'>",
  "knows_variety": <bool，该品种当前是否存在清晰可交易的核心矛盾与关键价位、且本计划与之一致（有明确的供需/技术逻辑，入场止损位与结构位匹配）；逻辑混乱或位置明显错配为 false>,
  "variety_comment": "<一句话：本计划对应的品种核心矛盾与关键位是否成立>",
  "plan_summary": "<100 字内：代为生成的交易计划说明——核心矛盾、关键价位（具体数字）、本笔入场的逻辑定位。将存入交易许可单作为第 5 项>",
  "detected_mood": "calm|hesitant|fomo|revenge，从计划特征客观推断：入场价远追现价/间隔极短/今日已亏损后申请→fomo 或 revenge；止损目标与结构匹配、间隔正常→calm；信号不足仍提交→hesitant",
  "impulse_detected": <bool，综合推断的情绪与计划特征判断是否存在冲动交易（追涨杀跌/报复/怕错过/无逻辑支撑）>,
  "impulse_comment": "<一句话>",
  "decision_correct": <bool，综合以上全部与行情结构：这笔交易计划是否值得执行——趋势/位置/逻辑/风险报酬任一方面有硬伤即为 false>,
  "decision_assessment": "<80 字内直接说明为什么值得/不值得执行>",
  "confidence": "high|medium|low"
}}"""
    ai = await _llm_json(ai_prompt)
    reversal = bool(ai.get("reversal_confirmed"))
    knows = bool(ai.get("knows_variety"))
    impulse = bool(ai.get("impulse_detected"))
    decision_ok = bool(ai.get("decision_correct"))
    mood = str(ai.get("detected_mood", "calm"))
    if mood not in ("calm", "hesitant", "fomo", "revenge"):
        mood = "calm"
    mood_cn = {"calm": "😌冷静", "hesitant": "🤔犹豫", "fomo": "🔥FOMO", "revenge": "😡报复"}[mood]

    # R001（组装）：顺势，或价格在正确侧 + AI 反转确认豁免
    if right_side is None:
        r1_ok, r1_detail = False, trend_detail
    else:
        r1_ok = trendy or (right_side and reversal)
        r1_detail = trend_detail
        if not trendy and right_side and reversal:
            r1_detail += f"；均线未顺势，AI 判定反转成立豁免（依据：{ai.get('reversal_evidence', '')}）"
        elif not trendy and right_side and not reversal:
            r1_detail += "；均线未顺势且 AI 未确认反转（" + str(ai.get("reversal_evidence", "")) + "）"
    rule_map["R001"] = _rule("R001", "大周期趋势方向确认，不与趋势对抗", "致命", r1_ok, r1_detail)

    # R002（组装）：同向信号 ≥2，或 AI 反转确认 + ≥1 信号
    r2_ok = len(confirms) >= 2 or (reversal and len(confirms) >= 1)
    r2_detail = f"同方向信号 {len(confirms)} 条：{('、'.join(confirms) or '无')}"
    if reversal and len(confirms) < 2:
        r2_detail += f"；AI 判定反转成立（{ai.get('reversal_evidence', '')}）"
    if atr14 and ref_close:
        r2_detail += f"；ATR14 {atr14:.1f}（约 {atr14 / ref_close * 100:.2f}%，止损距离宜 ≥1 倍 ATR）"
    rule_map["R002"] = _rule("R002", "入场信号 ≥ 2 条客观确认", "致命", r2_ok, r2_detail)

    # R004 品种逻辑（AI 判定：市场当前是否存在与计划一致的可交易逻辑）
    rule_map["R004"] = _rule(
        "R004", "品种存在清晰核心矛盾与关键价位（AI 判定，与计划一致性）", "致命", knows,
        f"AI：{ai.get('variety_comment', '')}",
    )

    # R010 交易许可单（客观四项表单 + AI 生成第 5 项计划说明）
    form_ok = bool(body.entry and body.sl and body.tp)
    plan_summary = str(ai.get("plan_summary", "")).strip() or "（AI 未生成）"
    rule_map["R010"] = _rule(
        "R010", "交易许可单完整（四项客观参数 + AI 生成计划说明）", "致命", form_ok,
        "四项参数（品种/方向/入场/止损）" + ("完整" if form_ok else "缺失（目标价也建议填写）")
        + f"；第 5 项由 AI 生成：{plan_summary[:80]}",
    )

    # R011 冷静期（客观间隔 + AI 冲动检测，情绪亦由 AI 推断）
    r11_ok = gap_ok and not impulse
    r11_detail = f"要求 ≥ {cooling} 分钟"
    if gap_min is not None:
        r11_detail += f"，距上笔申请 {gap_min:.0f} 分钟"
    r11_detail += f"；AI 推断情绪 {mood_cn}，冲动检测：{'⚠ ' + str(ai.get('impulse_comment', '')) if impulse else '未检出冲动'}"
    rule_map["R011"] = _rule("R011", "冲动冷静期（AI 情绪推断与冲动检测）", "严重", r11_ok, r11_detail)

    # R014 AI 决策评估（否决权：AI 判决策错误即禁止）
    rule_map["R014"] = _rule(
        "R014", "AI 决策评估（计划是否值得执行）", "致命", decision_ok,
        f"{ai.get('decision_assessment', '')}（置信度 {ai.get('confidence', 'unknown')}）",
    )

    rules = [rule_map[k] for k in sorted(rule_map)]
    fatal = [r for r in rules if r["status"] == "violation" and r["severity"] == "致命"]
    warns = [r for r in rules if r["status"] == "violation" and r["severity"] == "严重"]
    allowed = not fatal

    # ATR 头寸建议（海龟 1N 法则）：按"止损 1 倍 ATR"口径，
    # 每手风险 = ATR14 × 合约乘数，建议手数 = 账户 × 单笔风险% ÷ 每手风险。
    position_hint = None
    acct = float(cfg.get("account_size") or 0)
    mult = CONTRACT_MULTIPLIER.get(symbol[:2]) or CONTRACT_MULTIPLIER.get(symbol[:1])
    if acct > 0 and atr14 and mult:
        risk_amt = acct * float(cfg.get("risk_per_trade", 1.0)) / 100
        per_lot = atr14 * mult
        lots = int(risk_amt // per_lot) if per_lot > 0 else 0
        position_hint = {
            "lots": lots,
            "atr": round(atr14, 1),
            "multiplier": mult,
            "per_lot_risk": round(per_lot, 0),
            "risk_budget": round(risk_amt, 0),
            "basis": f"按止损=1×ATR14（{atr14:.1f}）口径：每手风险 {per_lot:,.0f} 元，单笔预算 {risk_amt:,.0f} 元 → 建议 ≤ {lots} 手",
        }
        if lots == 0:
            position_hint["basis"] += "（预算不足 1 手：风险上限过小或波动过大，建议放弃或放宽上限）"

    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "symbol": symbol,
        "side": side,
        "entry": body.entry,
        "sl": body.sl,
        "tp": body.tp,
        "is_add": is_add,
        "allowed": allowed,
        "violations": [r["id"] for r in rules if r["status"] == "violation"],
        "status": "open" if allowed else "rejected",
        "pnl_pct": None,
        "mood": mood,                      # AI 推断情绪
        "note": plan_summary[:200],        # AI 生成的交易计划说明（许可单第 5 项）
        "rr": round(rr, 2) if rr else None,
        "ai_review": {
            "reversal_confirmed": reversal,
            "reversal_evidence": str(ai.get("reversal_evidence", ""))[:120],
            "knows_variety": knows,
            "impulse_detected": impulse,
            "decision_correct": decision_ok,
            "assessment": str(ai.get("decision_assessment", ""))[:160],
            "confidence": str(ai.get("confidence", "")),
        },
    }
    # AI 审查期间日志可能已被平仓/删除等操作修改——保存点重读，只追加本条，防覆盖
    fresh = _load_discipline_log()
    fresh.append(entry)
    _save_discipline_log(fresh)
    return {
        "ok": True,
        "allowed": allowed,
        "verdict": "允许开仓" if allowed else "禁止开仓",
        "fatal_count": len(fatal),
        "warn_count": len(warns),
        "rules": rules,
        "stats": discipline_stats(log),
        "position_hint": position_hint,
        "ai_review": entry["ai_review"],
        "log_entry": entry,
    }


@app.get("/api/discipline/log")
async def discipline_log_get():
    log = _load_discipline_log()
    return {"ok": True, "items": log[-100:], "stats": discipline_stats(log)}


class DisciplineSettleIn(BaseModel):
    ts: str                    # 日志条目的时间戳（定位）
    pnl_pct: float             # 平仓盈亏（占账户权益百分比，亏为负）
    exit: Optional[float] = None  # 实际出场价（选填；填了计算实际 R 倍数）


@app.post("/api/discipline/settle")
async def discipline_settle(body: DisciplineSettleIn):
    log = _load_discipline_log()
    for e in log:
        if str(e.get("ts")) == body.ts:
            e["status"] = "closed"
            e["pnl_pct"] = round(float(body.pnl_pct), 2)
            if body.exit and e.get("entry") and e.get("sl"):
                risk = abs(float(e["entry"]) - float(e["sl"]))
                if risk > 0:
                    move = (float(body.exit) - float(e["entry"])) * (1 if e.get("side") == "long" else -1)
                    e["exit"] = float(body.exit)
                    e["r_multiple"] = round(move / risk, 2)
            _save_discipline_log(log)
            return {"ok": True, "stats": discipline_stats(log)}
    raise HTTPException(status_code=404, detail="未找到该笔记录")


class DisciplineDeleteIn(BaseModel):
    ts: str


@app.post("/api/discipline/delete")
async def discipline_delete(body: DisciplineDeleteIn):
    """删除一条记录（误录兜底）"""
    log = _load_discipline_log()
    before = len(log)
    log = [e for e in log if str(e.get("ts")) != body.ts]
    if len(log) == before:
        raise HTTPException(status_code=404, detail="未找到该笔记录")
    _save_discipline_log(log)
    return {"ok": True, "stats": discipline_stats(log)}


@app.post("/api/discipline/holding-review")
async def discipline_holding_review(body: DisciplineDeleteIn):
    """持仓 AI 体检：这笔仓还该拿着吗——原计划 vs 当前行情 vs 执行偏差"""
    log = _load_discipline_log()
    e = next(
        (x for x in log if str(x.get("ts")) == body.ts and x.get("status") == "open"),
        None,
    )
    if not e:
        raise HTTPException(status_code=404, detail="未找到该持仓（可能已平仓）")
    symbol = e["symbol"]
    try:
        quote = await fetch_quote(symbol)
        last = quote.get("last")
    except Exception:
        last = None
    # token 优化：用轻量实时快照替代完整市场上下文（体检只需指标/日内/要闻，无需 OHLC 明细）
    try:
        rt = await _realtime_snapshot(symbol)
        context = "\n".join([
            f"【实时盘面（{rt['now']}）】现价 {rt['quote']['last']}",
            f"日内结构：{rt['intra'] or '数据不足'}",
            f"日线指标：{rt['ind_txt']}",
            f"60分钟趋势：{rt['m60_dir']}",
            f"宏观要闻（特朗普/中东）：{rt['news']}",
        ])
    except Exception:
        context = ""
    ai0 = e.get("ai_review") or {}
    floating = None
    if last:
        floating = round((last - e["entry"]) * (1 if e["side"] == "long" else -1), 1)
    prompt = f"""你是交易持仓审查官。用户持有一笔期货仓位，请基于当前行情判断该继续持有、减仓还是离场，并指出执行偏差。禁止迎合，数据说话。

【原交易计划（{str(e['ts'])[:16]} 申请，已通过全部 14 项纪律检查）】
{symbol} {'做多' if e['side'] == 'long' else '做空'}{'（加仓）' if e.get('is_add') else ''}：入场 {e['entry']}，止损 {e['sl']}，目标 {e.get('tp') or '未设'}，计划盈亏比 {e.get('rr') or '--'}
当时交易理由：{e.get('note') or '无'}
当时 AI 评审：{'值得执行' if ai0.get('decision_correct') else '不值得（但客观规则通过）'} —— {ai0.get('assessment', '')}

【当前状态】
最新价 {last if last else '未知'}，浮动 {floating if floating is not None else '未知'} 点（正为盈利方向）

【市场上下文】
{context}

【判定任务】只输出一个 JSON 对象，不要输出其他文字：
{{
  "action": "continue|reduce|exit",
  "assessment": "<100 字内：当前应继续持有/减仓/离场的直接理由，引用具体价位与指标>",
  "deviation": "<80 字内：当前执行与原计划的偏差（是否提前恐高/是否移损/浮盈是否达计划进度），无偏差则写'按计划执行中'",
  "suggested_sl": <数字或 null：基于当前结构建议的止损价（原止损明显不合理时才改，否则保持原值）>,
  "key_levels": "<该仓位的生死价位：上方压力与下方支撑，具体数字>"
}}"""
    ai = await _llm_json(prompt)
    review = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "action": ai.get("action"),
        "assessment": str(ai.get("assessment", ""))[:200],
        "deviation": str(ai.get("deviation", ""))[:160],
        "suggested_sl": ai.get("suggested_sl"),
        "key_levels": str(ai.get("key_levels", ""))[:120],
        "last": last,
        "floating": floating,
    }
    # AI 体检期间日志可能被其它操作修改——保存点重读定位原记录，防覆盖
    log = _load_discipline_log()
    tgt = next((x for x in log if str(x.get("ts")) == body.ts and x.get("status") == "open"), None)
    if tgt is None:
        raise HTTPException(status_code=404, detail="该持仓刚被平仓或删除，请刷新后重试")
    tgt["holding_review"] = review
    _save_discipline_log(log)
    return {"ok": True, "review": review}


@app.post("/api/discipline/trade-review")
async def discipline_trade_review(body: DisciplineDeleteIn):
    """平仓后单笔 AI 复盘：计划 vs 实际对照，校验 AI 当初判定，提炼教训"""
    log = _load_discipline_log()
    e = next(
        (x for x in log if str(x.get("ts")) == body.ts and x.get("status") == "closed"),
        None,
    )
    if not e:
        raise HTTPException(status_code=404, detail="未找到已平仓记录")
    if e.get("pnl_pct") is None:
        raise HTTPException(status_code=400, detail="该记录未回填盈亏，请先平仓")
    ai0 = e.get("ai_review") or {}
    plan_rr = e.get("rr")
    real_r = e.get("r_multiple")
    exit_price = e.get("exit")
    prompt = f"""你是交易复盘教练。对这笔已平仓交易做单笔复盘，重点：计划执行质量与当初 AI 判定的准确性。直接了当，不奉承。

【原计划】{e['symbol']} {'做多' if e['side'] == 'long' else '做空'}：入场 {e['entry']}，止损 {e['sl']}，目标 {e.get('tp') or '未设'}，计划盈亏比 {plan_rr or '--'}
理由：{e.get('note') or '无'}；当时 AI 评审：{'值得执行' if ai0.get('decision_correct') else '不值得执行'} —— {ai0.get('assessment', '')}

【实际结果】已实现盈亏 {e['pnl_pct']:+.2f}%（账户权益口径）{f'，出场价 {exit_price}，实际 {real_r}R（计划 {plan_rr}:1）' if exit_price and real_r is not None else '（未填出场价，无法计算实际R）'}

【复盘任务】只输出一个 JSON 对象，不要输出其他文字：
{{
  "plan_followed": <bool，是否按计划执行（出场位/盈亏与计划止损目标是否一致，无出场价按盈亏推断）>,
  "execution_grade": "<A|B|C|D：执行质量评级，A=严格按计划，D=严重偏离>",
  "ai_verdict_check": "<正确|偏差|无法判断：当初 AI 评审与实际结果是否相符>",
  "lesson": "<60 字内：这笔交易最值得记住的一条教训或经验>",
  "summary": "<80 字内：一句话总评>"
}}"""
    ai = await _llm_json(prompt)
    review = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "plan_followed": bool(ai.get("plan_followed")),
        "execution_grade": str(ai.get("execution_grade", ""))[:2],
        "ai_verdict_check": str(ai.get("ai_verdict_check", ""))[:10],
        "lesson": str(ai.get("lesson", ""))[:120],
        "summary": str(ai.get("summary", ""))[:160],
    }
    # AI 复盘期间日志可能被其它操作修改——保存点重读定位原记录，防覆盖
    log = _load_discipline_log()
    tgt = next((x for x in log if str(x.get("ts")) == body.ts and x.get("status") == "closed"), None)
    if tgt is None:
        raise HTTPException(status_code=404, detail="该记录刚被修改或删除，请刷新后重试")
    tgt["review"] = review
    _save_discipline_log(log)
    return {"ok": True, "review": review}


@app.get("/api/discipline/config")
async def discipline_config_get():
    return {"ok": True, "discipline": load_config()["discipline"]}


@app.post("/api/discipline/config")
async def discipline_config_post(body: dict):
    cfg = load_config()
    d = cfg["discipline"]
    for k in (
        "account_size", "risk_per_trade", "daily_stop", "weekly_max_trades",
        "daily_max_trades", "min_grid_spacing", "max_adds", "min_rr", "cooling_min",
    ):
        if k in body and isinstance(body[k], (int, float)):
            d[k] = float(body[k])
    if isinstance(body.get("universe"), list):
        d["universe"] = [str(u).strip().upper() for u in body["universe"] if str(u).strip()]
    save_config(cfg)
    return {"ok": True, "discipline": d}


# ---------------------------------------------------------------- 交易心得

NOTES_FILE = BASE_DIR / "notes.json"


def _load_notes() -> list[dict]:
    if NOTES_FILE.exists():
        try:
            return json.loads(NOTES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_notes(notes: list[dict]) -> None:
    try:
        NOTES_FILE.write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


@app.get("/api/notes")
async def get_notes():
    return {"ok": True, "items": list(reversed(_load_notes()))}  # 新的在前


class NoteIn(BaseModel):
    title: str = ""
    content: str
    symbol: Optional[str] = None
    tags: str = ""
    date: str = ""  # YYYY-MM-DD，留空取当天


@app.post("/api/notes")
async def add_note(body: NoteIn):
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="心得内容不能为空")
    notes = _load_notes()
    note = {
        "id": f"n{int(datetime.now().timestamp() * 1000)}",
        "ts": int(datetime.now().timestamp() * 1000),
        "title": body.title.strip() or content[:24],
        "date": body.date.strip() or datetime.now().strftime("%Y-%m-%d"),
        "symbol": (body.symbol or "").upper() or None,
        "tags": body.tags.strip(),
        "content": content,
        "synced": False,  # 是否已同步到飞书
    }
    notes.append(note)
    _save_notes(notes)
    return {"ok": True, "item": note}


@app.delete("/api/notes/{note_id}")
async def del_note(note_id: str):
    notes = _load_notes()
    remain = [n for n in notes if n["id"] != note_id]
    if len(remain) == len(notes):
        raise HTTPException(status_code=404, detail="心得不存在")
    _save_notes(remain)
    return {"ok": True}


# ---------------------------------------------------------------- AI 复盘分析（对话存档 + 心得）

class AiReviewIn(BaseModel):
    chats: list[dict] = []   # {role, content, ts?, sym?} 前端已按时间段/品种过滤
    notes: list[dict] = []   # {date, title, symbol, tags, content}
    symbols: list[str] = []
    since: str = ""          # YYYY-MM-DD 闭区间
    until: str = ""


def _clip_txt(s, n: int) -> str:
    s = str(s or "").strip().replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


@app.post("/api/ai/review")
async def ai_review(body: AiReviewIn):
    chats = [c for c in (body.chats or []) if str(c.get("content", "")).strip()][:60]
    notes = [n for n in (body.notes or []) if str(n.get("content", "")).strip()][:50]
    if not chats and not notes:
        raise HTTPException(status_code=400, detail="所选范围内没有可分析的记录，请调整时间段或品种")

    parts = []
    scope = f"（品种：{'、'.join(body.symbols) if body.symbols else '全部'}；时间：{body.since or '最早'} ~ {body.until or '今天'}）"
    if notes:
        lines = [
            f"- [{n.get('date', '')}]{('[' + str(n['symbol']) + ']') if n.get('symbol') else ''}"
            f"{_clip_txt(n.get('title', ''), 30)}：{_clip_txt(n.get('content', ''), 220)}"
            f"{(' ' + str(n['tags'])) if n.get('tags') else ''}"
            for n in notes
        ]
        parts.append(f"【交易心得 {len(notes)} 条】（用户亲手记录的判断/教训/反思，最能代表本人视角）\n" + "\n".join(lines))
    if chats:
        lines = []
        for c in chats:
            when = "时间未知"
            try:
                ts = float(c.get("ts") or 0)
                if ts > 0:
                    when = datetime.fromtimestamp(ts / 1000).strftime("%m-%d %H:%M")
            except (TypeError, ValueError, OSError, OverflowError):
                pass
            sym = str(c.get("sym") or "")
            ask = c.get("role") == "user"
            lines.append(f"- [{when}{(' ' + sym) if sym else ''}]{'问' if ask else '答'}："
                         f"{_clip_txt(c.get('content', ''), 100 if ask else 380)}")
        parts.append(f"【AI 对话 {len(chats)} 条】（用户提问与 AI 助手当时的分析）\n" + "\n".join(lines))

    prompt = f"""以下是这位期货交易者的存档{scope}。请基于且仅基于这些内容，生成一份针对性复盘分析报告：

一、品种关注与观点演化：主要关注哪些品种？观点如何随时间演变（指出转折点）？
二、判断质量：用户心得与提问体现的判断，哪些被存档中后续内容验证？哪些被证伪？（不得臆造存档外的行情）
三、行为模式：提问频率、关注点切换、情绪状态（急躁/恐惧/追涨杀跌）反映的交易行为特征。
四、重复性问题：反复出现的错误或思维陷阱。
五、值得保留：存档中体现的好习惯，明确肯定。
六、改进建议：3~5 条可执行建议，逐条对应上述发现。

用中文输出 Markdown（## 分节），关键论断引用存档原句；信息不足时如实说明，不编造。

""" + "\n\n".join(parts)

    report = await _llm_text_retry(prompt, max_tokens=2400)
    return {"ok": True, "report": report, "stats": {"chats": len(chats), "notes": len(notes)}}


class ReviewSaveIn(BaseModel):
    report: str
    since: str = ""
    until: str = ""
    symbols: list[str] = []
    stats: dict = {}


async def _feishu_review_doc_id():
    """确保《AI 复盘报告》文档存在并返回 doc_id；失败返回 None（不抛异常）"""
    import logging
    cfg = load_config()
    doc_id = (cfg.get("feishu") or {}).get("review_doc_id") or ""
    if doc_id:
        return doc_id
    try:
        token = await _feishu_get_token()
        async with httpx.AsyncClient(timeout=20) as _client:
            r = await _client.post(
                f"{FEISHU_BASE}/docx/v1/documents",
                headers={"Authorization": f"Bearer {token}"},
                json={"title": "AI 复盘报告"},
            )
        data = r.json()
        if data.get("code") == 0 and data.get("data", {}).get("document"):
            doc_id = data["data"]["document"]["document_id"]
            cfg = load_config()  # 重读：创建文档期间 config 可能已被修改
            cfg.setdefault("feishu", {})["review_doc_id"] = doc_id
            save_config(cfg)
    except Exception as e:
        logging.getLogger("uvicorn.error").info(f"[review-save] 创建文档异常：{type(e).__name__} {e}")
    return doc_id or None


@app.post("/api/ai/review-save")
async def ai_review_save(body: ReviewSaveIn):
    """把生成的复盘报告追加到飞书《AI 复盘报告》文档（刷新不丢、手机可看）"""
    cfg = load_config()
    fs = cfg.get("feishu") or {}
    if not fs.get("app_id") or not fs.get("app_secret"):
        raise HTTPException(status_code=400, detail="未配置飞书应用凭证（⚙ 设置 → 飞书同步）")
    if not body.report.strip():
        raise HTTPException(status_code=400, detail="报告内容为空")
    doc_id = await _feishu_review_doc_id()
    if not doc_id:
        raise HTTPException(status_code=502, detail="飞书文档创建失败，请稍后重试")
    rng = f"{body.since or '最早'}~{body.until or '今天'}" if (body.since or body.until) else "全部时间"
    st = body.stats or {}
    head = (
        f"# 复盘报告 {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
        f"- 范围：{rng} · 品种：{'、'.join(body.symbols) or '全部'}"
        f" · 对话 {st.get('chats', 0)} 条 + 心得 {st.get('notes', 0)} 条\n"
    )
    await _feishu_append(doc_id, _md_to_feishu_blocks(head + body.report))
    return {"ok": True}


# ---------------------------------------------------------------- 飞书云文档同步

FEISHU_BASE = "https://open.feishu.cn/open-apis"
_feishu_token = {"token": "", "expire_at": 0.0}


async def _feishu_push(text: str) -> bool:
    """飞书群机器人 webhook 推送（未配置时静默跳过；上游 18f7652 整合）"""
    cfg = load_config()
    url = (cfg.get("feishu") or {}).get("webhook_url")
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json={"msg_type": "text", "content": {"text": text[:3900]}})
        ok = r.status_code == 200 and r.json().get("code", 0) == 0
        if not ok:
            import logging
            logging.getLogger("uvicorn.error").info(f"[feishu-push] 失败：{r.text[:120]}")
        return ok
    except Exception as e:
        import logging
        logging.getLogger("uvicorn.error").info(f"[feishu-push] 异常：{e}")
        return False


def _feishu_cfg(cfg: dict) -> dict:
    return cfg.get("feishu") or {}


async def _feishu_get_token(force: bool = False) -> str:
    now = asyncio.get_event_loop().time()
    if not force and _feishu_token["token"] and now < _feishu_token["expire_at"] - 60:
        return _feishu_token["token"]
    cfg = _feishu_cfg(load_config())
    if not cfg.get("app_id") or not cfg.get("app_secret"):
        raise HTTPException(status_code=400, detail="未配置飞书应用凭证（App ID / App Secret），请先在 AI 设置中填写")
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal",
            json={"app_id": cfg["app_id"], "app_secret": cfg["app_secret"]},
        )
    data = r.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=400, detail=f"飞书认证失败：{data.get('msg')}")
    _feishu_token["token"] = data["tenant_access_token"]
    _feishu_token["expire_at"] = now + data.get("expire", 7200)
    return _feishu_token["token"]


def _md_to_feishu_blocks(md_text: str) -> list[dict]:
    """极简 Markdown -> 飞书 docx 块（标题3/正文/列表）；失败由调用方降级"""
    blocks = []
    for line in md_text.split("\n"):
        s = line.rstrip()
        if not s.strip():
            blocks.append({"block_type": 2, "text": {"elements": [{"text_run": {"content": ""}}], "style": {}}})
            continue
        text_el = [{"text_run": {"content": s, "text_element_style": {}}}]
        if s.startswith("### "):
            blocks.append({"block_type": 5, "heading3": {"elements": text_el}})
        elif s.startswith("## "):
            blocks.append({"block_type": 4, "heading2": {"elements": text_el}})
        elif s.startswith("# "):
            blocks.append({"block_type": 3, "heading1": {"elements": text_el}})
        elif s.lstrip().startswith(("- ", "* ")):
            blocks.append({"block_type": 12, "bullet": {"elements": [{"text_run": {"content": s.lstrip()[2:], "text_element_style": {}}}]}})
        else:
            blocks.append({"block_type": 2, "text": {"elements": text_el, "style": {}}})
    return blocks


async def _feishu_append(doc_id: str, blocks: list[dict]) -> None:
    token = await _feishu_get_token()
    async with httpx.AsyncClient(timeout=20) as client:
        # 追加到文档根 block（document_id 即页面 block）
        r = await client.post(
            f"{FEISHU_BASE}/docx/v1/documents/{doc_id}/blocks/{doc_id}/children",
            headers={"Authorization": f"Bearer {token}"},
            json={"children": blocks[:90]},  # 单次上限约 100 块
        )
    data = r.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=502, detail=f"飞书写入失败：{data.get('msg')}")


async def _feishu_ensure_doc() -> str:
    """获取配置中的文档 ID；没有则创建《期货交易心得》文档"""
    cfg = load_config()
    fs = _feishu_cfg(cfg)
    doc_id = fs.get("doc_id") or ""
    if doc_id:
        return doc_id
    token = await _feishu_get_token()
    title = fs.get("doc_title") or "期货交易心得"
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"{FEISHU_BASE}/docx/v1/documents",
            headers={"Authorization": f"Bearer {token}"},
            json={"title": title},
        )
    data = r.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=502, detail=f"飞书创建文档失败：{data.get('msg')}（请确认应用已开通「云文档」读写权限）")
    doc_id = data["data"]["document"]["document_id"]
    cfg = load_config()  # 重读：创建文档期间 config 可能已被修改
    cfg.setdefault("feishu", {})
    cfg["feishu"]["doc_id"] = doc_id
    save_config(cfg)
    return doc_id


def _note_to_md(note: dict) -> str:
    title = note.get("title") or (note.get("content") or "")[:24]
    t = datetime.fromtimestamp(note["ts"] / 1000)
    meta_parts = [note.get("date") or t.strftime("%Y-%m-%d")]
    if note.get("symbol"):
        meta_parts.append(note["symbol"])
    if note.get("tags"):
        meta_parts.append(f"#{note['tags']}")
    meta_parts.append(t.strftime("%H:%M"))
    return f"### {title}\n- {' · '.join(meta_parts)}\n{note['content']}\n"


class ChatExportIn(BaseModel):
    content: str
    title: str = "AI 对话记录"


async def _feishu_chat_doc_id():
    """确保《AI 对话记录》文档存在并返回 doc_id；失败返回 None（不抛异常）"""
    import logging
    cfg = load_config()
    doc_id = (cfg.get("feishu") or {}).get("chat_doc_id") or ""
    if doc_id:
        return doc_id
    try:
        token = await _feishu_get_token()
        async with httpx.AsyncClient(timeout=20) as _client:
            r = await _client.post(
                f"{FEISHU_BASE}/docx/v1/documents",
                headers={"Authorization": f"Bearer {token}"},
                json={"title": "AI 对话记录"},
            )
        data = r.json()
        logging.getLogger("uvicorn.error").info(
            f"[chat-export] 创建文档：code={data.get('code')} msg={data.get('msg')}")
        if data.get("code") == 0 and data.get("data", {}).get("document"):
            doc_id = data["data"]["document"]["document_id"]
            cfg = load_config()  # 重读：创建文档期间 config 可能已被修改
            cfg.setdefault("feishu", {})["chat_doc_id"] = doc_id
            save_config(cfg)
    except Exception as e:
        logging.getLogger("uvicorn.error").info(f"[chat-export] 创建文档异常：{type(e).__name__} {e}")
    if not doc_id:
        doc_id = await _feishu_ensure_doc()  # 兜底：追加到心得文档
    return doc_id or None


async def _feishu_log_chat_round(symbol, question: str, answer: str):
    """每轮 AI 对话自动追加到飞书文档（品种+时间+问答）；失败静默不影响对话"""
    import logging
    try:
        doc_id = await _feishu_chat_doc_id()
        if not doc_id:
            return
        name = ""
        if symbol:
            try:
                name = (await get_directory()).get(symbol, {}).get("name", "")
            except Exception:
                pass
        head = f"【{datetime.now().strftime('%Y-%m-%d %H:%M')}】{symbol or '未关联品种'}{('（' + name + '）') if name else ''}"
        text = f"{head}\n【问】{question[:500]}\n【AI 答】{answer[:1500]}\n"
        blocks = [
            {"block_type": 2, "text": {"elements": [{"text_run": {"content": text[i:i + 900], "text_element_style": {}}}], "style": {}}}
            for i in range(0, len(text), 900)
        ]
        await _feishu_append(doc_id, blocks)
    except Exception as e:
        logging.getLogger("uvicorn.error").info(f"[chat-log] 自动记录失败：{type(e).__name__} {e}")


@app.post("/api/chat-export")
async def chat_export(body: ChatExportIn):
    """将 AI 对话历史导出追加到飞书云文档《AI 对话记录》（上游 38d03d2 整合）"""
    cfg = load_config()
    fs = cfg.get("feishu") or {}
    if not fs.get("app_id") or not fs.get("app_secret"):
        raise HTTPException(status_code=400, detail="未配置飞书应用凭证（App ID / App Secret）")
    text = body.content.strip()
    if not text:
        raise HTTPException(status_code=400, detail="对话内容为空")

    doc_id = await _feishu_chat_doc_id()
    if not doc_id:
        raise HTTPException(status_code=502, detail="创建对话文档失败，请检查飞书配置")
    blocks = [
        {"block_type": 2, "text": {"elements": [{"text_run": {"content": text[i:i + 900], "text_element_style": {}}}], "style": {}}}
        for i in range(0, len(text), 900)
    ]
    await _feishu_append(doc_id, blocks)
    return {"ok": True, "doc_id": doc_id}


@app.post("/api/notes/feishu-sync")
async def notes_feishu_sync(note_id: str = "", all_unsynced: bool = True):
    """同步心得到飞书云文档：单条（note_id）或全部未同步（all_unsynced）"""
    notes = _load_notes()
    targets = [n for n in notes if n["id"] == note_id] if note_id else \
              [n for n in notes if not n.get("synced") and (all_unsynced or n["id"] == note_id)]
    if not targets:
        return {"ok": True, "synced": 0, "msg": "没有待同步的心得"}

    doc_id = await _feishu_ensure_doc()
    blocks = []
    for n in targets:
        blocks.extend(_md_to_feishu_blocks(_note_to_md(n)))
    try:
        await _feishu_append(doc_id, blocks)
    except HTTPException as e:
        # 块结构不被接受时降级为纯文本块（分段）重试一次
        plain = "\n".join(_note_to_md(n) for n in targets)
        plain_blocks = [
            {"block_type": 2, "text": {"elements": [{"text_run": {"content": plain[i:i + 900], "text_element_style": {}}}], "style": {}}}
            for i in range(0, len(plain), 900)
        ]
        try:
            await _feishu_append(doc_id, plain_blocks)
        except Exception:
            raise e
    ids = {n["id"] for n in targets}
    # 飞书上传期间心得可能被增删——保存点重读，只回写 synced 标记，防覆盖
    fresh = _load_notes()
    hit = 0
    for n in fresh:
        if n["id"] in ids:
            n["synced"] = True
            hit += 1
    _save_notes(fresh)
    return {"ok": True, "synced": len(targets), "doc_id": doc_id}


class FeishuCfgIn(BaseModel):
    app_id: str = ""
    app_secret: str = ""
    doc_title: str = "期货交易心得"
    webhook_url: str = ""   # 群机器人 webhook（盯盘异动/晨报主动推送）    clear: bool = False


@app.post("/api/feishu/config")
async def set_feishu_config(body: FeishuCfgIn):
    cfg = load_config()
    fs = cfg.setdefault("feishu", {})
    if body.clear:
        cfg["feishu"] = {}
        save_config(cfg)
        return {"ok": True}
    if body.app_id.strip():
        fs["app_id"] = body.app_id.strip()
    if body.app_secret.strip():
        fs["app_secret"] = body.app_secret.strip()
    if body.doc_title.strip():
        fs["doc_title"] = body.doc_title.strip()
    if body.webhook_url.strip():
        fs["webhook_url"] = body.webhook_url.strip()
    # 凭证变更后重建文档关联
    if body.app_id.strip() or body.app_secret.strip():
        fs.pop("doc_id", None)
    save_config(cfg)
    return {"ok": True}


@app.post("/api/feishu/push-test")
async def feishu_push_test():
    """发送测试消息验证 webhook 配置（上游整合）"""
    ok = await _feishu_push("✅ 期货助手推送测试：配置成功，盯盘异动与晨报将推送到本群。")
    if not ok:
        cfg = load_config()
        if not (cfg.get("feishu") or {}).get("webhook_url"):
            raise HTTPException(status_code=400, detail="未配置 webhook URL")
        raise HTTPException(status_code=502, detail="推送失败，请检查 webhook 地址与群机器人设置")
    return {"ok": True}


# ---------------------------------------------------------------- 主题要闻

NEWS_TOPICS = {
    # 原油/黄金及宏观驱动
    "oilgold": [
        "原油", "油价", "wti", "布伦特", "brent", "opec", "欧佩克", "石油", "炼厂", "燃料油", "燃油",
        "黄金", "金价", "期金", "白银", "银价", "贵金属", "comex",
        "美联储", "fed", "加息", "降息", "利率决议", "非农", "cpi", "通胀", "美元指数",
        "避险", "关税",
    ],
    # 美伊冲突：核心方言论与动作
    "usiran": [
        # 美方
        "特朗普", "川普", "白宫", "美国国务院", "五角大楼", "美国国防部", "美军", "美国中央司令部",
        "美国官员", "华盛顿号",
        # 伊朗方
        "伊朗", "德黑兰", "哈梅内伊", "伊朗总统", "伊朗外长", "革命卫队", "伊朗核",
        "铀浓缩", "国际原子能机构", "iaea",
        # 冲突动作与关联方（保持聚焦，泛词如"地缘/俄乌"归 oilgold 主题）
        "空袭", "霍尔木兹", "红海", "胡塞", "停火谈判", "以色列", "沙特遇袭", "对伊制裁",
    ],
    # 特朗普表态专项监控（言论/动作，独立通知）
    "trump": ["特朗普", "川普", "白宫", "美国总统", "特朗普政府", "椭圆形办公室", "truth social"],
}

# 增强版白名单分组（国际盘聚焦：仅特朗普 + 中东重大动向）
_NEWS_GROUPS = {
    "trump": [
        "特朗普", "trump", "白宫", "美国国务院", "五角大楼", "美国财政部",
        "贝森特", "关税", "对等关税",
    ],
    "mideast": [
        "伊朗", "德黑兰", "哈梅内伊", "革命卫队", "伊朗核", "铀浓缩", "对伊制裁",
        "以色列", "空袭", "袭击", "霍尔木兹", "红海", "胡塞", "停火", "加沙",
        "哈马斯", "真主党", "黎巴嫩", "中东", "导弹", "石油设施", "沙特",
        "opec", "欧佩克", "美国中央司令部",
    ],
}

_news_cache: dict = {"ts": 0.0, "items": []}
_news_ai: dict = {"ts": 0.0, "running": False, "tags": {}}  # AI 筛选结果：{过滤后索引: 类别}
NEWS_TTL = 120.0
NEWS_AI_TTL = 300.0   # AI 筛选结果缓存 5 分钟
NEWS_AI_LIMIT = 60    # 只筛最新 60 条

_AI_FILTER_PROMPT = """你是国内期货资讯筛选器，判定标准严格。下面是财经快讯（已去除股市行情与公司财报类噪音）。请判断每条是否与【国内期货交易】直接相关：
【判定为相关】：直接涉及期货品种的供需/价格/库存/产量（如 OPEC、EIA、USDA、港口库存、开工率）、宏观货币政策直接影响资产定价（央行/利率决议/通胀/非农/美元指数）、地缘冲突直接冲击商品供给或避险（战争/制裁/袭击产油设施/霍尔木兹）。
【判定为不相关】：政府机构一般动态、公司融资/人事/股权变动、科技产品、社会民生、文体、医疗、教育、旅游、他国国内政治、间接沾边的泛产业新闻。拿不准的一律判不相关。
输出严格 JSON 数组，只列出【相关】的条目，每个元素形如 {"i": 序号, "tag": "类别"}，tag 从以下选一个：原油/能源、贵金属、黑色金属、农产品、化工、油脂、宏观利率、美元、地缘、产业数据、天气。不要输出任何其它文字。

条目列表：
"""


async def _ai_filter_news(items: list) -> dict:
    """批量调用 AI 判定相关性，返回 {索引: 类别}；失败自动对半重试，最终失败降级"""
    import logging
    logger = logging.getLogger("uvicorn.error")
    tags: dict = {}
    sentiment_map: dict = {}
    cfg = load_config()
    if not cfg["api_keys"].get(cfg["provider"]):
        return tags, sentiment_map

    async def ask_chunk(base: int, chunk: list) -> None:
        lines = [
            f"{i}. {(it.get('title') or '')[:70]} {(it.get('summary') or '')[:80]}".replace("\n", " ")
            for i, it in enumerate(chunk)
        ]
        raw = await _call_ai_simple(
            [{"role": "user", "content": _AI_FILTER_PROMPT + "\n".join(lines)}],
            max_tokens=min(8192, max_output_for(cfg["model"] or "")),
        )
        arr = json.loads(raw[raw.find("["): raw.rfind("]") + 1])
        for item in arr:
            if isinstance(item, dict) and "i" in item:
                idx = base + int(item["i"])
                if 0 <= idx < len(items):
                    tags[idx] = str(item.get("tag", ""))[:8]

    async def ask_with_retry(base: int, chunk: list, depth: int = 0) -> None:
        try:
            await ask_chunk(base, chunk)
        except Exception as e:
            # 推理模型偶发输出超限：对半拆分重试（最小 3 条）
            if depth < 2 and len(chunk) > 3:
                logger.info(f"[ai-news] 块 {base} 失败（{type(e).__name__}），对半重试")
                mid = len(chunk) // 2
                await ask_with_retry(base, chunk[:mid], depth + 1)
                await ask_with_retry(base + mid, chunk[mid:], depth + 1)
            else:
                logger.info(f"[ai-news] 块 {base} 放弃：{type(e).__name__} {str(e)[:60]}")

    chunk_size = 10
    for start in range(0, len(items), chunk_size):
        chunk = items[start:start + chunk_size]
        await ask_with_retry(start, chunk)
    logger.info(f"[ai-news] 全部完成：相关 {len(tags)} 条")
    return tags, sentiment_map


async def _ai_filter_job():
    _news_ai["running"] = True
    try:
        items = _news_cache["items"][:NEWS_AI_LIMIT]
        tags, sents = await _ai_filter_news(items)
        _news_ai["tags"] = tags
        _news_ai["sentiments"] = sents
        _news_ai["ts"] = asyncio.get_event_loop().time()
    except Exception:
        pass
    finally:
        _news_ai["running"] = False


# 股市噪音词：命中即剔除（只保留与期货相关的大宗/能源/贵金属/宏观资讯）
_STOCK_NOISE_KW = [
    "股价", "股票", "股市", "a股", "港股", "美股", "纳指", "纳斯达克", "道指", "标普",
    "韩股", "日经", "欧股", "沪指", "深指", "创业板", "科创板", "北交所", "恒生",
    "涨停", "跌停", "财报", "营收", "净利润", "ipo", "股份回购", "市值", "科技股",
    "芯片股", "ai芯片", "两市", "成交额", "目标价", "重申", "公告称", "评级",
    "基金", "券商", "业绩", "季报", "年报", "增持", "减持", "上市公司", "游资",
    "家电", "游戏", "流水", "服务器", "晶圆", "pcbs", "存储芯片", "半导体设备",
    "银行股", "保险股", "券商股", "龙头股", "概念股", "题材股", "翻倍", "套牢",
]


def _is_stock_noise(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _STOCK_NOISE_KW)


# 品种关联词（新闻 → 涉及的期货品种）
NEWS_SYMBOL_KW = {
    "RB0": ["螺纹钢", "螺纹", "建材钢"], "HC0": ["热卷", "热轧"], "I0": ["铁矿石", "铁矿", "PB粉"],
    "J0": ["焦炭"], "JM0": ["焦煤"], "CU0": ["铜", "沪铜", "电解铜", "LME铜"],
    "AL0": ["铝", "电解铝", "氧化铝"], "ZN0": ["锌", "沪锌"], "NI0": ["镍", "沪镍"],
    "AU0": ["黄金", "金价", "COMEX金", "伦敦金", "现货金"], "AG0": ["白银", "银价", "COMEX银"],
    "SC0": ["原油", "油价", "WTI", "布伦特", "SC", "燃料油"], "FU0": ["燃料油", "低硫"],
    "M0": ["豆粕", "美豆", "大豆"], "Y0": ["豆油", "植物油"], "P0": ["棕榈油"],
    "RM0": ["菜粕", "菜籽"], "OI0": ["菜油", "油菜籽"],
    "TA0": ["PTA", "PX"], "MA0": ["甲醇"], "EG0": ["乙二醇", "MEG"],
    "PP0": ["聚丙烯", "PP粒"], "L0": ["塑料", "聚乙烯", "LLDPE"], "V0": ["PVC"],
    "FG0": ["玻璃", "浮法玻璃"], "SA0": ["纯碱", "重质纯碱"],
    "C0": ["玉米", "谷物"], "CF0": ["棉花", "棉价", "郑棉"], "SR0": ["白糖", "原糖"],
    "IF0": ["沪深300", "股指", "A股指数"], "EC0": ["集运", "欧线", "运价"],
    "DINIW": ["美元指数", "美元汇率", "DXY"],
}


def _detect_news_symbols(title: str, summary: str = "") -> list[str]:
    """从新闻标题/摘要自动检测涉及的期货品种"""
    text = title + " " + summary[:100]
    hits = []
    for sym, kws in NEWS_SYMBOL_KW.items():
        if any(k in text for k in kws):
            hits.append(sym)
    return hits[:4]  # 最多标 4 个


def _news_topics(text: str) -> list[str]:
    """返回文本命中的全部主题（不区分大小写）"""
    t = text.lower()
    return [topic for topic, kws in NEWS_TOPICS.items() if any(k in t for k in kws)]
NEWS_MAX = 60


def _match_news_groups(text: str) -> list[str]:
    t = text.lower()
    return [g for g, kws in _NEWS_GROUPS.items() if any(k.lower() in t for k in kws)]

async def _refresh_news() -> None:
    """拉取快讯流（新浪+东财），去重/去股市噪音/标主题与品种，写缓存"""
    loop_now = asyncio.get_event_loop().time()
    if loop_now - _news_cache["ts"] <= NEWS_TTL:
        return
    items, seen = [], set()

    def _add(time_s: str, title: str, summary: str, link: str, source: str):
        key = (title or summary)[:30]
        if not key or key in seen:
            return
        text = title + " " + summary
        if _is_stock_noise(text):
            return  # 只保留与期货相关（大宗/能源/贵金属/宏观），剔除纯股市与公司新闻
        seen.add(key)
        hit = _news_topics(text)
        items.append({
            "time": str(time_s),
            "title": title or (summary[:40] if summary else ""),
            "summary": summary,
            "link": link,
            "source": source,
            "matched": "oilgold" in hit,   # 兼容字段：原油/黄金主题
            "topics": hit,
            "symbols": _detect_news_symbols(title or "", summary or ""),
        })

    try:
        df = await call_ak(ak.stock_info_global_sina)
        for _, r in df.iterrows():
            content = str(r.get("内容", ""))
            _add(r.get("时间", ""), content, content, "", "新浪")
    except Exception:
        pass
    try:
        df = await call_ak(ak.stock_info_global_em)
        for _, r in df.iterrows():
            _add(r.get("发布时间", ""), str(r.get("标题", "")), str(r.get("摘要", "")),
                 str(r.get("链接", "")), "东财")
    except Exception:
        pass

    items.sort(key=lambda x: x["time"], reverse=True)
    _news_cache["items"] = items[:80]
    _news_cache["ts"] = loop_now


@app.get("/api/news")
async def news(topic: str = ""):
    """宏观要闻监控：单源新浪全球快讯，严格白名单过滤——
    只保留【特朗普发言/动作】与【中东重大动向】两类，其余一律丢弃。"""
    loop_now = asyncio.get_event_loop().time()
    await _refresh_news()
    if _news_cache["items"]:
        asyncio.create_task(_check_trump_news())

    result_items = _news_cache["items"]
    if topic in NEWS_TOPICS:
        result_items = [it for it in result_items if topic in it["topics"]]

    # AI 语义筛选状态：首次请求时异步触发，前端轮询拿到 ready
    ai_stale = loop_now - _news_ai["ts"] > NEWS_AI_TTL
    if ai_stale and not _news_ai["running"]:
        _news_ai["tags"] = {}
        asyncio.create_task(_ai_filter_job())
    ai_tags = _news_ai["tags"] if not ai_stale else {}
    return {
        "ok": True,
        "items": result_items,
        "topics": NEWS_TOPICS,
        "ai": {
            "status": "ready" if ai_tags else ("filtering" if _news_ai["running"] else "off"),
            "tags": {str(k): v for k, v in ai_tags.items()},
            "sentiments": {str(k): v for k, v in (_news_ai.get("sentiments") or {}).items()},
        },
    }


# ---------------------------------------------------------------- 特朗普表态监控

_trump_seen: set = set()
_trump_first = {"done": False}


async def _check_trump_news():
    """扫描快讯流中的特朗普相关新条目 → 事件流 + 飞书推送（首次扫描只建档不推送）"""
    items = [it for it in _news_cache["items"] if "trump" in (it.get("topics") or [])]
    if not _trump_first["done"]:
        for it in items:
            _trump_seen.add(it["title"])
        _trump_first["done"] = True
        return
    new_items = [it for it in items if it["title"] not in _trump_seen]
    for it in new_items:
        if it["title"] in _trump_seen:  # 并发调用防重（循环内有 await 挂起点）
            continue
        _trump_seen.add(it["title"])
        event = {
            "id": f"trump-{abs(hash(it['title'])) % 10 ** 10}",
            "ts": int(datetime.now().timestamp() * 1000),
            "symbol": "TRUMP", "name": "特朗普表态", "dir": "trump",
            "chg5": 0, "chg15": 0, "day_chg": None, "price": "", "from": "",
            "pos_chg": None, "threshold": 0,
            "text": it["title"], "summary": (it.get("summary") or "")[:150],
            "source": it.get("source", ""), "link": it.get("link", ""),
            "ai": None,
        }
        _MONITOR["events"].append(event)
        if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
            _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
        await _feishu_push(f"🇺🇸 特朗普表态监控\n{it['title']}\n[{it['time'][5:16]}] {it.get('source', '')}")


# ---------------------------------------------------------------- 突发资讯监控（日内作战流）

# 直接影响日内盘面的强事件词（品种关联或宏观主题命中时才算突发）
_FLASH_KW = [
    "空袭", "袭击", "爆炸", "导弹", "无人机", "打击", "封锁", "霍尔木兹", "红海",
    "制裁", "战争", "冲突", "停火", "opec", "欧佩克", "减产", "增产", "出口管制",
    "罢工", "断供", "港口", "库存", "eia", "api", "非农", "降息", "加息",
    "利率决议", "cpi", "关税", "紧急", "突发", "熔断", "减半", "招标",
]

_flash_seen: set = set()
_flash_first = {"done": False}


def _is_flash(it: dict) -> bool:
    """突发判定：美伊冲突专题直推；否则需（品种关联或宏观主题）+ 强事件词"""
    topics = it.get("topics") or []
    if "trump" in topics:
        return False  # 特朗普走专项推送，避免重复
    text = (it.get("title", "") + " " + (it.get("summary") or "")).lower()
    if "usiran" in topics:
        return True
    if not any(k in text for k in _FLASH_KW):
        return False
    return bool(it.get("symbols")) or "oilgold" in topics


async def _check_flash_news() -> None:
    """扫描快讯流中的突发条目 → 事件流 + 飞书推送（首轮建档不推，每轮最多 2 条防轰炸）"""
    items = _news_cache["items"]
    if not _flash_first["done"]:
        for it in items:
            _flash_seen.add(it["title"])
        _flash_first["done"] = True
        return
    pushed = 0
    for it in items:
        if pushed >= 2:
            break
        if it["title"] in _flash_seen:
            continue
        _flash_seen.add(it["title"])
        if not _is_flash(it):
            continue
        pushed += 1
        syms = it.get("symbols") or []
        sym_tag = " ".join(syms) if syms else "宏观/地缘"
        event = {
            "id": f"flash-{abs(hash(it['title'])) % 10 ** 10}",
            "ts": int(datetime.now().timestamp() * 1000),
            "kind": "flash", "etype": "news",
            "symbol": sym_tag, "dir": "news",
            "topics": it.get("topics") or [],
            "text": it["title"], "summary": (it.get("summary") or "")[:150],
            "source": it.get("source", ""), "link": it.get("link", ""),
            "time_str": str(it.get("time", ""))[5:16],
            # 兼容字段：旧版前端按普通异动事件渲染时不显示 undefined
            "chg5": 0.0, "chg15": 0.0, "threshold": 0.0,
            "price": "", "intl": True, "ai": "",
        }
        _MONITOR["events"].append(event)
        if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
            _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
        asyncio.create_task(_feishu_push(f"⚡ 突发资讯 [{sym_tag}]\n{it['title']}\n[{event['time_str']}] {it.get('source', '')}"))
    if len(_flash_seen) > 2000:  # 防内存膨胀
        _flash_seen.clear()


async def news_watch_loop():
    """突发资讯后台监控：60 秒刷新快讯流并检测突发（用户不打开资讯页也有推送）"""
    await asyncio.sleep(35)
    while True:
        try:
            now = datetime.now()
            # 交易时段+周末外盘时段监控（新闻源全天生效，夜间外盘事件对次日开盘重要）
            if now.weekday() < 6 and (is_trading_time(now) or 7 <= now.hour):
                await _refresh_news()
                if _news_cache["items"]:
                    await _check_flash_news()
                    await _check_trump_news()
        except Exception:
            pass
        await asyncio.sleep(60)


# ---------------------------------------------------------------- 超短雷达异变监控

_radar_prev: dict[str, dict] = {}   # 上轮快照关键字段（sym -> {score, grade, ir_state, flow}）
_radar_cool: dict[tuple, float] = {}  # (sym, 变化类型) -> loop time，10 分钟冷却


def _grade_of(score: int) -> str:
    return "活跃" if score >= 65 else ("一般" if score >= 40 else "清淡")


async def _radar_check(sym: str) -> None:
    """单品种雷达异变检测：评分跨档 / IR 突破 / 量价定性翻转 → 作战流（IR 突破加推飞书）"""
    try:
        snap = await _scalp_snapshot(sym)
    except Exception:
        return
    cur = {
        "score": snap["score"], "grade": snap["grade"],
        "ir_state": snap["ir_state"], "flow": snap["flow"] or "",
    }
    prev = _radar_prev.get(sym)
    _radar_prev[sym] = cur
    if not prev:
        return  # 首轮建档
    loop_now = asyncio.get_event_loop().time()
    name = snap.get("name") or sym

    def _emit(ctype: str, text: str, feishu: bool = False, level: str = "info"):
        key = (sym, ctype)
        if loop_now - _radar_cool.get(key, -1e9) < 600:
            return
        _radar_cool[key] = loop_now
        _MONITOR["events"].append({
            "id": f"radar-{sym}-{ctype}-{int(loop_now)}",
            "ts": int(datetime.now().timestamp() * 1000),
            "kind": "radar", "etype": ctype, "level": level,
            "symbol": sym, "name": name, "dir": "up",
            "price": snap["last"], "text": text,
            # 兼容字段：旧版前端按普通异动事件渲染时不显示 undefined
            "chg5": 0.0, "chg15": 0.0, "threshold": 0.0, "intl": True, "ai": "",
        })
        if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
            _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
        if feishu:
            asyncio.create_task(_feishu_push(f"📡 超短雷达 · {sym}（{name}）\n{text}\n现价 {snap['last']}"))

    # IR 突破/跌回（超短关键结构事件）
    if prev["ir_state"] != cur["ir_state"]:
        if "上破" in cur["ir_state"]:
            _emit("ir", f"{sym} 上破开盘区间（IR {snap['ir_low']:g}~{snap['ir_high']:g}），现价 {snap['last']}——真突破跟进或防假突破回抽", feishu=True, level="warn")
        elif "跌破" in cur["ir_state"]:
            _emit("ir", f"{sym} 跌破开盘区间（IR {snap['ir_low']:g}~{snap['ir_high']:g}），现价 {snap['last']}——日内转弱信号", feishu=True, level="warn")

    # 可交易性跨档（清淡↔一般↔活跃）
    if prev["grade"] != cur["grade"]:
        arrow = "↑" if cur["score"] > prev["score"] else "↓"
        _emit("grade", f"{sym} 可交易性 {prev['grade']}→{cur['grade']}（{prev['score']}→{cur['score']}{arrow}）"
              + ("，波动启动可关注" if cur["score"] > prev["score"] else "，波动衰减建议观望"))

    # 量价定性翻转
    if prev["flow"] and cur["flow"] and prev["flow"] != cur["flow"]:
        _emit("flow", f"{sym} 量价定性翻转：{prev['flow'].split('（')[0]} → {cur['flow'].split('（')[0]}")


async def radar_loop():
    """超短雷达异变监控：盯盘品种（自选+持仓+画像）每 60 秒对比快照，关键变化进作战流"""
    await asyncio.sleep(45)
    while True:
        try:
            now = datetime.now()
            if is_trading_time(now) or (now.weekday() < 5 and 20 <= now.hour < 24):
                syms = ({s.upper() for s in _MONITOR["watch"]}
                        | {t["symbol"] for t in _load_trades() if t.get("status") == "open"}
                        | set(_load_profile().get("symbols") or []))
                for sym in sorted(syms)[:8]:
                    await _radar_check(sym)
        except Exception:
            pass
        await asyncio.sleep(60)


# ---------------------------------------------------------------- AI 记忆画像

PROFILE_FILE = BASE_DIR / "trader_profile.json"

_profile_cache: dict = {"data": None}


def _load_profile() -> dict:
    if _profile_cache["data"] is not None:
        return _profile_cache["data"]
    if PROFILE_FILE.exists():
        try:
            _profile_cache["data"] = json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
            return _profile_cache["data"]
        except Exception:
            pass
    return {"style": "", "lessons": [], "symbols": [], "risk_preference": "", "updated": ""}


def _save_profile(p: dict) -> None:
    p["updated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    PROFILE_FILE.write_text(json.dumps(p, ensure_ascii=False, indent=2), encoding="utf-8")
    _profile_cache["data"] = p


def _profile_context() -> str:
    """交易者画像 → 注入 system prompt（空画像返回空）"""
    p = _load_profile()
    lines = []
    if p.get("style"):
        lines.append(f"交易风格：{p['style']}")
    if p.get("risk_preference"):
        lines.append(f"风险偏好：{p['risk_preference']}")
    if p.get("symbols"):
        lines.append(f"常交易品种：{','.join(p['symbols'][:8])}")
    if p.get("lessons"):
        lines.append("历史教训（注意避免重复）：")
        for les in p["lessons"][-5:]:
            lines.append(f"  - {les[:120]}")
    for r in p.get("rules", []):
        lines.append(f"体系规则 {r.get('id','')}（必须遵守）：{r.get('rule','')}")
        if r.get("reason"):
            lines.append(f"  原因：{r['reason'][:80]}")
    if not lines:
        return ""
    return "\n【交易者画像（AI 记忆，分析时个性化适配）】\n" + "\n".join(lines)


def _position_context() -> str:
    """当前持仓 + 近期盈亏 → 注入 AI 上下文（让分析感知仓位状态）"""
    trades = _load_trades()
    open_trades = [t for t in trades if t["status"] == "open"]
    recent_closed = [t for t in trades if t["status"] == "closed" and t.get("result_pts") is not None][-5:]

    if not open_trades and not recent_closed:
        return ""

    lines = []
    if open_trades:
        lines.append("当前持仓（分析时请注意仓位风险提示）：")
        for t in open_trades:
            d = "多" if t["direction"] == "long" else "空"
            lines.append(
                f"  {t['symbol']} {d} @{t['entry']}，SL {t['stop_points']}点 TP {t['target_points']}点 "
                f"{t['lots']}手（{t['date']}开仓，AI评级:{t.get('ai_grade','--')}）"
            )
    if recent_closed:
        pts = [t["result_pts"] for t in recent_closed]
        wins = sum(1 for x in pts if x > 0)
        lines.append(f"近5笔盈亏：{'/'.join(f'{x:+.0f}' for x in pts)}（胜率{wins}/{len(pts)}）")
    return "\n【仓位状态（AI 上下文）】\n" + "\n".join(lines)


class ProfileUpdate(BaseModel):
    style: str = ""
    risk_preference: str = ""
    add_lesson: str = ""
    add_symbol: str = ""
    remove_lesson: int = -1


@app.get("/api/profile")
async def get_profile():
    return {"ok": True, "profile": _load_profile()}


@app.post("/api/profile")
async def update_profile(body: ProfileUpdate):
    p = _load_profile()
    changed = False
    if body.style.strip():
        p["style"] = body.style.strip()[:100]
        changed = True
    if body.risk_preference.strip():
        p["risk_preference"] = body.risk_preference.strip()[:50]
        changed = True
    if body.add_lesson.strip():
        p.setdefault("lessons", []).append(body.add_lesson.strip()[:150])
        p["lessons"] = p["lessons"][-20:]
        changed = True
    if body.add_symbol.strip():
        syms = p.setdefault("symbols", [])
        s = body.add_symbol.strip().upper()
        if s not in syms:
            syms.append(s)
            p["symbols"] = syms[:15]
        changed = True
    if body.remove_lesson >= 0 and body.remove_lesson < len(p.get("lessons", [])):
        p["lessons"].pop(body.remove_lesson)
        changed = True
    if changed:
        _save_profile(p)
    return {"ok": True, "profile": p}


# ---------------------------------------------------------------- 定期自检

_health = {"ts": 0, "results": [], "running": False}
_APP_STARTED = datetime.now()


async def _selfcheck_run(ping_ai: bool = False) -> list:
    """并发执行全部自检项，结果写入 _health（单项超时 12s，总耗时≈最慢项）"""
    import time as _time
    results = []

    async def probe_quote():
        q = await fetch_quote("RB0")
        if q.get("error"):
            raise RuntimeError(q["error"])
        return f"RB0 {q.get('last')}"

    async def probe_kline():
        d = await get_daily("RB0")
        return f"{len(d)} 根日线"

    async def probe_minute():
        rows = await get_minute("RB0", "1")
        return f"{len(rows)} 根分钟线"

    async def probe_intl():
        items = await get_intl_quotes()
        bad = [q["symbol"] for q in items if q.get("error")]
        base = f"{len(items) - len(bad)}/{len(items)} 品种正常"
        return base + (f"（异常：{','.join(bad)}）" if bad else "")

    async def probe_news():
        d = await news()
        return f"{len(d.get('items', []))} 条缓存"

    async def probe_deep():
        items = await _variety_news_deep("RB0")
        if not items:
            raise RuntimeError("无结果")
        return f"{len(items)} 条"

    async def probe_shmet():
        items = await _shmet_news()
        if not items:
            raise RuntimeError("无结果")
        return f"{len(items)} 条"

    async def probe_calendar():
        items = await get_calendar()
        if not items:
            raise RuntimeError("无结果")
        return f"{len(items)} 个事件"

    async def probe_monitor():
        lc = _MONITOR.get("last_check")
        if not lc:
            uptime = (datetime.now() - _APP_STARTED).total_seconds()
            if uptime < 90:
                return f"启动初始化中（{int(uptime)}s，首轮巡检未完成）"
            raise RuntimeError("盯盘循环尚未运行")
        return f"最近巡检 {lc}"

    async def probe_feishu():
        fs = load_config().get("feishu") or {}
        if not fs.get("app_id"):
            return "未配置（跳过）"
        await _feishu_get_token(force=True)
        return "token 正常"

    async def probe_ai():
        cfg = load_config()
        p = cfg["provider"]
        if not cfg["api_keys"].get(p):
            raise RuntimeError("未配置 Key")
        if not ping_ai:
            return f"已配置 {PROVIDERS[p]['label']}（未实测调用）"
        out = await _call_ai_simple([{"role": "user", "content": "只回复两个字：正常"}], max_tokens=2048)
        if not out:
            raise RuntimeError("空输出")
        return f"{PROVIDERS[p]['label']} 调用正常"

    async def probe_disk():
        for f in ("config.json", "notes.json", "trades.json"):
            fp = BASE_DIR / f
            if fp.exists():
                json.loads(fp.read_text(encoding="utf-8"))
        return "数据文件完整"

    async def probe_scalp():
        snap = await _scalp_snapshot("RB0")
        return f"可交易性 {snap['score']}/100（{snap['grade']}）"

    async def probe_radar_loop():
        if not _radar_prev:
            uptime = (datetime.now() - _APP_STARTED).total_seconds()
            if uptime < 120:
                return f"启动初始化中（{int(uptime)}s，首轮快照未完成）"
            raise RuntimeError("雷达监控尚未建档")
        return f"监控 {len(_radar_prev)} 个品种"

    async def probe_flash():
        if not _flash_first["done"]:
            uptime = (datetime.now() - _APP_STARTED).total_seconds()
            if uptime < 120:
                return "启动初始化中（首轮建档未完成）"
            raise RuntimeError("突发监控尚未建档")
        return f"已建档 {len(_flash_seen)} 条"

    checks = [
        ("国内实时行情", probe_quote), ("国内日K", probe_kline),
        ("国内分钟线", probe_minute), ("国际行情", probe_intl),
        ("快讯流(新浪/东财)", probe_news), ("产业深研(东财)", probe_deep),
        ("金属快讯(SHMET)", probe_shmet), ("宏观日历", probe_calendar),
        ("超短雷达", probe_scalp), ("雷达异变监控", probe_radar_loop),
        ("突发资讯监控", probe_flash), ("盯盘循环", probe_monitor), ("飞书", probe_feishu),
        ("AI 服务", probe_ai), ("本地数据", probe_disk),
    ]

    async def guarded(name, fn):
        t0 = _time.time()
        try:
            detail = await asyncio.wait_for(fn(), timeout=20)
            results.append({"name": name, "ok": True, "detail": str(detail)[:100],
                            "ms": int((_time.time() - t0) * 1000)})
        except Exception as e:
            results.append({"name": name, "ok": False,
                            "detail": f"{type(e).__name__}: {str(e)[:90]}",
                            "ms": int((_time.time() - t0) * 1000)})

    _health["running"] = True
    t0 = _time.time()
    try:
        await asyncio.gather(*(guarded(n, f) for n, f in checks))
    finally:
        _health["running"] = False
        _health["results"] = results
        _health["ts"] = int(datetime.now().timestamp() * 1000)
        import logging
        bad = [r["name"] for r in results if not r["ok"]]
        logging.getLogger("uvicorn.error").info(
            f"[selfcheck] 完成（{int((_time.time() - t0) * 1000)}ms）"
            + (f" 异常：{','.join(bad)}" if bad else " 全部通过"))


async def selfcheck_loop():
    """每 10 分钟自动自检一轮"""
    await asyncio.sleep(60)
    while True:
        try:
            await _selfcheck_run(ping_ai=False)
        except Exception:
            pass
        await asyncio.sleep(600)


@app.get("/api/health")
async def health_get():
    age = int(datetime.now().timestamp() * 1000) - _health["ts"] if _health["ts"] else None
    stale = age is None or age > 30 * 60 * 1000
    if stale and not _health["running"]:
        asyncio.create_task(_selfcheck_run(ping_ai=False))
    return {"ok": True, "running": _health["running"], "ts": _health["ts"],
            "age_ms": age, "results": _health["results"]}


@app.post("/api/health/run")
async def health_run(ping_ai: bool = False):
    if _health["running"]:
        return {"ok": True, "running": True}
    asyncio.create_task(_selfcheck_run(ping_ai=ping_ai))
    return {"ok": True, "running": True}

# ---------------------------------------------------------------- AI 晨报

REPORT_FILE = BASE_DIR / "morning_report.json"
_report_state = {"generating": False}


def _report_slot(now=None) -> str:
    """报告时段：9-21 点为当日晨报(am)，21 点后为当晚夜报(pm)，9 点前归前一晚(pm)"""
    now = now or datetime.now()
    day = now.strftime("%Y-%m-%d")
    if now.hour < 9:
        prev = now.fromordinal(now.toordinal() - 1)
        return f"{prev.strftime('%Y-%m-%d')}-pm"
    if now.hour >= 21:
        return f"{day}-pm"
    return f"{day}-am"


def _load_reports() -> dict:
    if REPORT_FILE.exists():
        try:
            return json.loads(REPORT_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_reports(data: dict) -> None:
    try:
        REPORT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


async def _generate_report() -> str:
    """晨/夜报：宏观要闻（特朗普/中东）+ 国际盘四品种快照 + 持仓与纪律 → AI 汇总"""
    parts = []

    try:
        nd = await news()
        matched = nd.get("items", [])[:12]  # token 优化：12 条已足够覆盖主线
        if matched:
            lines = [
                f"- [{'🇺🇸' if 'trump' in i.get('groups', []) else '🌍'} {i['time'][5:16]}] {i['title'][:60]}"
                for i in matched
            ]
            parts.append("【近期要闻（特朗普发言/中东重大动向）】\n" + "\n".join(lines))
    except Exception:
        pass

    syms = sorted(set(_MONITOR["watch"]) | {"SC0", "AU0"})
    directory = await get_directory()
    lines = []
    for s in syms[:10]:
        q = _quote_cache.get(s, (0, {}))[1]
        if not q:
            try:
                q = await fetch_quote(s)
            except Exception:
                continue
        name = directory.get(s, {}).get("name", "")
        pct = q.get("change_pct")
        line = f"- {s}（{name}）：最新 {q.get('last')}，日内 {'+' if (pct or 0) >= 0 else ''}{pct}%，持仓 {q.get('position')}"
        try:
            ind = await get_indicators(s, "15m")
            sigs = "；".join(x["name"] for x in ind["signals"][:3]) or "无明显信号"
            line += f"；15分信号：{sigs}"
        except Exception:
            pass
        lines.append(line)
    if lines:
        parts.append("【自选品种快照】\n" + "\n".join(lines))
    # 国际盘四品种快照
    try:
        intl_items = await fetch_intl()
        lines = []
        for it in intl_items:
            pct = it.get("chg_pct")
            lines.append(
                f"- {it['name']}：最新 {it.get('last')}，日内 {'+' if (pct or 0) >= 0 else ''}{pct}%"
                f"（高 {it.get('high')} / 低 {it.get('low')}）"
            )
        if lines:
            parts.append("【国际盘快照】\n" + "\n".join(lines))
    except Exception:
        pass

    # 持仓与纪律状态（决策后闭环，供晨报提醒风险与执行情况）
    try:
        dlog = [e for e in _load_discipline_log() if e.get("allowed")]
        holds = [e for e in dlog if e.get("status") == "open"]
        if holds:
            h_lines = []
            for h in holds:
                q = _quote_cache.get(str(h.get("symbol")), (0, {}))[1]
                last = q.get("last") if q else None
                flt = f"，浮动 {((last - h['entry']) * (1 if h['side'] == 'long' else -1)):+.1f} 点" if last and h.get("entry") else ""
                h_lines.append(
                    f"- {h['symbol']} {'多' if h['side'] == 'long' else '空'}{'(加)' if h.get('is_add') else ''}："
                    f"入 {h['entry']} 损 {h['sl']} 目标 {h.get('tp') or '未设'}{flt}"
                    f"（{str(h['ts'])[:10]} 入场，理由：{(h.get('note') or '')[:40]}）"
                )
            parts.append("【当前持仓（今日关注其止损位与关键价位）】\n" + "\n".join(h_lines))
        dstats = discipline_stats(_load_discipline_log())
        d_lines = [
            f"- 连续纪律 {dstats.get('discipline_streak', 0)} 天；今日 {dstats['today_trades']} 笔 / 本周 {dstats['week_trades']} 笔；"
            f"今日已实现 {dstats['today_pnl']:+.2f}%"
        ]
        rejected_today = [
            e for e in _load_discipline_log()
            if not e.get("allowed") and str(e.get("ts", ""))[:10] == datetime.now().strftime("%Y-%m-%d")
        ]
        if rejected_today:
            vio = {}
            for e in rejected_today:
                for r in e.get("violations", []):
                    vio[r] = vio.get(r, 0) + 1
            top = "、".join(f"{k}×{v}" for k, v in sorted(vio.items(), key=lambda x: -x[1])[:4])
            d_lines.append(f"- 昨日至今被拒 {len(rejected_today)} 笔（{top}）——简报中请针对性提醒规避")
        parts.append("【交易纪律状态】\n" + "\n".join(d_lines))
    except Exception:
        pass
    if not parts:
        return "（暂无可用数据，请稍后重新生成）"

    kind = "晨报（日盘前瞻）" if _report_slot().endswith("-am") else "夜报（夜盘前瞻）"
    profile = _profile_context()
    p_syms = set(_load_profile().get("symbols") or [])
    if p_syms:
        lines.sort(key=lambda l: 0 if any(s in l for s in p_syms) else 1)
    prompt = (
        (f"交易者画像（优先覆盖其常做品种）：\n{profile}\n\n" if profile else "")
        + f"你是期货{kind}助手。请基于以下数据生成一份简明交易简报，使用 Markdown。权重导向："
        f"宏观要闻（特朗普/中东）与资金情绪为主要依据，日内结构与技术信号作超短参考：\n"
        f"## 一、市场概览（3-4 句，以特朗普表态/中东局势等要闻主线为主）\n"
        f"## 二、分品种要点（每个品种 1-2 句：资金情绪+日内结构+关键点位，技术信号仅辅助）\n"
        f"## 三、今日关注（3-5 条：要盯的事件/价位/资金动向）\n"
        f"要求：客观精炼、全文 600 字以内、引用具体数值；结尾注明仅供参考。\n\n"
        + "\n\n".join(parts)
    )
    cfg = load_config()
    return await _call_ai_simple(
        [{"role": "user", "content": prompt}],
        max_tokens=min(4096, max_output_for(cfg["model"] or "")),
    )


async def report_push_loop():
    """晨/夜报定时生成并推送飞书：8:50 后生成当日晨报、20:50 后生成夜报（不依赖打开页面；上游整合）"""
    await asyncio.sleep(30)
    while True:
        try:
            now = datetime.now()
            slot = _report_slot(now)
            is_am = slot.endswith("-am")
            due = (is_am and now.hour >= 8 and now.minute >= 50) or \
                  (not is_am and now.hour >= 20 and now.minute >= 50) or \
                  (not is_am and now.hour >= 21)
            reports = _load_reports()
            if due and slot not in reports:
                import logging
                logging.getLogger("uvicorn.error").info(f"[report-push] 定时生成 {slot}")
                text = await _generate_report()
                reports = _load_reports()
                reports[slot] = {"ts": int(datetime.now().timestamp() * 1000), "report": text}
                keep = sorted(reports.keys())[-6:]
                _save_reports({k: reports[k] for k in keep})
                kind = "晨报（日盘前瞻）" if is_am else "夜报（夜盘前瞻）"
                await _feishu_push(f"📋 AI 交易{kind}\n\n{text[:1800]}")
        except Exception as e:
            import logging
            logging.getLogger("uvicorn.error").info(f"[report-push] 异常：{e}")
        await asyncio.sleep(120)


@app.get("/api/report")
async def get_report(force: int = 0):
    """获取当日晨/夜报；未生成则触发异步生成，前端轮询"""
    slot = _report_slot()
    reports = _load_reports()
    entry = reports.get(slot)
    if entry and not force:
        return {"ok": True, "status": "ready", "slot": slot, "ts": entry["ts"], "report": entry["report"]}
    if _report_state["generating"]:
        return {"ok": True, "status": "generating", "slot": slot}

    _report_state["generating"] = True

    async def _job():
        import logging
        try:
            logging.getLogger("uvicorn.error").info(f"[report] 开始生成 {slot}")
            text = await _generate_report()
            reports = _load_reports()
            reports[slot] = {"ts": int(datetime.now().timestamp() * 1000), "report": text}
            keep = sorted(reports.keys())[-6:]  # 只保留最近 6 份
            _save_reports({k: reports[k] for k in keep})
            logging.getLogger("uvicorn.error").info(f"[report] {slot} 生成完成（{len(text)} 字）")
        except Exception as e:
            logging.getLogger("uvicorn.error").info(f"[report] 生成失败：{e}")
        finally:
            _report_state["generating"] = False

    asyncio.create_task(_job())
    return {"ok": True, "status": "generating", "slot": slot}


# ---------------------------------------------------------------- 静态页面

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    # HTML 不允许缓存（协商校验），确保拿到最新版本引用最新静态资源
    return FileResponse(
        BASE_DIR / "static" / "index.html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/enhanced")
async def enhanced_page():
    """深度增强版界面（纪律引擎/资金情绪/TradingView/复盘）"""
    return FileResponse(
        BASE_DIR / "static" / "enhanced.html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )




# ================================================================ main 分支超短线体系（合并补齐）


CONTRACT_MULTIPLIER = {
    "RB": 10, "HC": 10, "I": 100, "J": 100, "JM": 60, "SF": 5, "SM": 5,
    "CU": 5, "AL": 5, "ZN": 5, "PB": 5, "NI": 1, "SN": 1, "SS": 5,
    "AU": 1000, "AG": 15, "SC": 1000, "FU": 10, "BU": 10, "RU": 10, "NR": 10, "LU": 10, "BR": 5,
    "M": 10, "Y": 10, "P": 10, "OI": 10, "RM": 10, "C": 10, "CS": 10, "A": 10, "B": 10,
    "CF": 5, "SR": 10, "AP": 10, "CJ": 5, "PK": 5,
    "TA": 5, "MA": 10, "EG": 10, "EB": 5, "PP": 5, "L": 5, "V": 5, "PG": 20,
    "FG": 20, "SA": 20, "UR": 20, "AO": 20, "SH": 20, "LC": 5, "SI": 5,
    "IF": 300, "IH": 300, "IC": 200, "IM": 200, "T": 10000, "TF": 10000, "TS": 20000, "TL": 10000,
}


class TradeEvalIn(BaseModel):
    symbol: str
    direction: str = "long"  # long / short
    entry: float
    stop_points: float
    target_points: float
    lots: float = 1


# 高相关品种组（P001：同向持仓 = 隐形杠杆，须合并计算）


CORR_GROUPS = {
    "原油系化工": {"MA", "TA", "V", "SC", "PG", "FU", "BU", "EB", "EG", "LU", "NR", "PP", "L"},
    "黑色系": {"RB", "HC", "I", "J", "JM", "SF", "SM"},
    "贵金属": {"AU", "AG"},
    "有色": {"CU", "AL", "ZN", "NI", "PB", "SN", "SS"},
    "油脂油料": {"M", "Y", "P", "OI", "RM"},
}

# 地缘敏感品种（P004：方向可被外生事件一夜逆转）


GEO_PREFIXES = {"MA", "TA", "SC", "PG", "FU", "BU", "LU", "NR", "V", "EB", "EG"}


async def _eval_rule_checks(symbol: str, direction: str, stop_price: float, last: float) -> list[dict]:
    """体系规则 P001-P004 的确定性预检（可计算部分），结果进 AI 上下文与前端徽章"""
    checks: list[dict] = []
    prefix = _variety_prefix(symbol)

    # P001：相关品种组已有同向持仓 → 合并隐形杠杆
    try:
        group = next((g for g, members in CORR_GROUPS.items() if prefix in members), "")
        if group:
            same = [
                t for t in _load_trades()
                if t["status"] == "open" and t["direction"] == direction
                and t["symbol"] != symbol
                and _variety_prefix(t["symbol"]) in CORR_GROUPS[group]
            ]
            if same:
                lst = "、".join(f"{t['symbol']} {t['lots']}手" for t in same)
                checks.append({
                    "rule": "P001", "level": "warn",
                    "text": f"已持有同向 {lst}（同属{group}），与本计划构成加倍仓位——组合保证金须 ≤ 账户净值30%",
                })
    except Exception:
        pass

    # P003：左侧交易判定（做多但现价仍在20日线下方）
    ma20 = low20 = None
    try:
        daily = [d for d in await get_daily(symbol) if d.get("close")]
        closes = [d["close"] for d in daily]
        if len(closes) >= 20:
            ma20 = round(sum(closes[-20:]) / 20, 2)
            low20 = round(min(d.get("low") or d["close"] for d in daily[-20:]), 2)
    except Exception:
        pass
    if direction == "long" and ma20 and last and last < ma20:
        checks.append({
            "rule": "P003", "level": "warn",
            "text": f"现价 {last} 仍在20日线 {ma20} 下方 → 属左侧做多：仓位上限降为正常一半，止损放前低（近20日低 {low20}）下方结构位",
        })

    # P002：止损设在扎堆位（整数关口附近 / 贴近近20日低点）
    if stop_price > 0:
        nearest_round = round(stop_price / 100) * 100
        tol = max(10.0, stop_price * 0.004)
        if abs(stop_price - nearest_round) <= tol:
            checks.append({
                "rule": "P002", "level": "warn",
                "text": f"止损价 {stop_price} 贴近整数关口 {nearest_round:g}——重仓者止损扎堆区，最易被「最后一跌」扫掉；请改用逻辑止损（做多理由被证伪的价位）",
            })
        if low20 and abs(stop_price - low20) / low20 < 0.005:
            checks.append({
                "rule": "P002", "level": "info",
                "text": f"止损价贴着近20日低点 {low20}——恰是扫损高发区，建议放到低点下方留出噪音余量",
            })

    # P004：地缘敏感品种跳空自检
    if prefix in GEO_PREFIXES:
        checks.append({
            "rule": "P004", "level": "info",
            "text": f"{prefix} 属地缘敏感品种：开仓前自答「若中东局势反向突变，仓位能否承受一个跳空？」不能则减仓到能承受",
        })

    return checks


TRADE_EVAL_PROMPT = """你是严格的日内短线交易风险教练（国内期货，T+0 双向交易）。交易者提交了开仓计划，请基于参考数据做开仓前风险体检。

【交易计划】
- 品种：{symbol}（{name}），方向：{dir_cn}
- 开仓价 {entry}（现价 {last}，偏离 {dev_pct}%）
- 止损 {stop_points} 点（{stop_price}），止盈 {target_points} 点（{target_price}）
- 盈亏比 {rr}，手数 {lots}{risk_amt}
- 止损幅度占日内已实现波幅 {stop_vs_range}%，占近5日平均日波幅 {stop_vs_avg}%
- 参考位：今日最高 {day_high} / 最低 {day_low}，日内均价 {day_avg}，昨结 {prev_settle}

【体系规则预检（程序已判定，评估必须逐条回应是否满足）】
{rule_checks}

【日内超短雷达（程序实时计算）】
{scalp_ctx}

【参考数据（实时）】
{context}

请输出（Markdown，600字内，务必引用具体数值）：
1. **方向一致性**：计划方向与日内结构、动能指标（MACD/KDJ/RSI）是否同向，现价位置（相对均价/开收盘）
2. **入场点位质量**：属追价还是回踩位？偏离均价风险
3. **止损合理性**：点数是否小于日内噪音波幅（易被扫）；是否落在关键位（均价/昨结/日内高低/MA）外侧
4. **止盈可达性**：目标对应价位今日是否已触及过/是否越过明显压力支撑
5. **盈亏比评价**：{rr} 的盈亏比在该品种日内波动特征下是否划算
6. **风险评级与建议**：低/中/高 + 明确行动（可执行 / 建议调整为：止损X点止盈Y点入场价Z / 等待某信号再进 / 放弃），给出调整后的具体参数
7. **时机提示**：当前时段（早盘/午盘/尾盘/夜盘）日内短线的注意事项
结尾固定一句：以上为盘面数据推演，不构成投资建议。"""


@app.post("/api/trade-eval")
async def trade_eval(body: TradeEvalIn):
    import logging
    logger = logging.getLogger("uvicorn.error")
    symbol = body.symbol.strip().upper()
    if body.direction not in ("long", "short"):
        raise HTTPException(status_code=400, detail="direction 仅支持 long/short")
    if body.stop_points <= 0 or body.target_points <= 0:
        raise HTTPException(status_code=400, detail="止损/止盈点数必须为正")
    if body.entry <= 0:
        raise HTTPException(status_code=400, detail="开仓价格无效")

    quote = _quote_cache.get(symbol, (0, {}))[1]
    if not quote:
        try:
            quote = await fetch_quote(symbol)
        except Exception:
            raise HTTPException(status_code=400, detail=f"无法获取 {symbol} 实时行情")

    sign = 1 if body.direction == "long" else -1
    stop_price = round(body.entry - sign * body.stop_points, 2)
    target_price = round(body.entry + sign * body.target_points, 2)
    rr = round(body.target_points / body.stop_points, 2)
    last = quote.get("last") or body.entry
    dev_pct = round((body.entry / last - 1) * 100, 2) if last else 0

    # 日内波幅基准
    day_high = day_low = day_avg = None
    try:
        rows = await get_minute(symbol, "1")
        day = rows[-1]["datetime"][:10]
        today = [r for r in rows if r["datetime"].startswith(day)]
        if len(today) >= 5:
            day_high = max(r["high"] or r["close"] or 0 for r in today)
            day_low = min(r["low"] or r["close"] or 9e9 for r in today)
            vsum = sum(r["volume"] or 0 for r in today)
            day_avg = round(sum((r["close"] or 0) * (r["volume"] or 0) for r in today) / max(1e-9, vsum), 2) if vsum else None
    except Exception:
        pass
    day_range = (day_high - day_low) if (day_high and day_low) else None
    stop_vs_range = round(body.stop_points / day_range * 100, 1) if day_range else None

    # 近5日平均日波幅
    avg5 = None
    try:
        daily = [d for d in await get_daily(symbol) if d.get("high") and d.get("low")][-5:]
        if daily:
            avg5 = round(sum(d["high"] - d["low"] for d in daily) / len(daily), 2)
    except Exception:
        pass
    stop_vs_avg = round(body.stop_points / avg5 * 100, 1) if avg5 else None

    mult = CONTRACT_MULTIPLIER.get(_variety_prefix(symbol), 0)
    risk_amt = f"（止损金额约 ¥{body.stop_points * mult * body.lots:,.0f}，止盈金额约 ¥{body.target_points * mult * body.lots:,.0f}）" if mult else ""

    directory = await get_directory()
    name = directory.get(symbol, {}).get("name", "")
    context = await _build_market_context(symbol)

    profile = _profile_context()
    position = _position_context()
    rule_checks = await _eval_rule_checks(symbol, body.direction, stop_price, last)
    rule_checks_text = "\n".join(f"- [{c['rule']}] {c['text']}" for c in rule_checks) or "- （未触发任何规则警示）"
    try:
        snap = await _scalp_snapshot(symbol)
        scalp_ctx = "\n".join(f"- {p}" for p in snap["points"]) + f"\n- 可交易性：{snap['score']}/100（{snap['grade']}）"
    except Exception:
        scalp_ctx = "- （暂不可用）"
    prompt = ((profile + "\n\n" if profile else "")
              + (position + "\n\n" if position else "")
              + TRADE_EVAL_PROMPT.format(
        symbol=symbol, name=name, dir_cn="做多" if body.direction == "long" else "做空",
        entry=body.entry, last=last, dev_pct=dev_pct,
        stop_points=body.stop_points, stop_price=stop_price,
        target_points=body.target_points, target_price=target_price,
        rr=rr, lots=body.lots, risk_amt=risk_amt,
        stop_vs_range=stop_vs_range if stop_vs_range is not None else "--",
        stop_vs_avg=stop_vs_avg if stop_vs_avg is not None else "--",
        day_high=day_high, day_low=day_low, day_avg=day_avg, prev_settle=quote.get("prev_settle"),
        rule_checks=rule_checks_text,
        scalp_ctx=scalp_ctx,
        context=context,
    ))

    logger.info(f"[trade-eval] {symbol} {body.direction} @{body.entry} sl{body.stop_points} tp{body.target_points}")
    try:
        advice = await _call_ai_with_fallback(
            [{"role": "user", "content": prompt}],
            max_tokens=min(4096, max_output_for(load_config()["model"] or "")),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 评估失败：{e}")

    return {
        "ok": True,
        "calc": {
            "stop_price": stop_price, "target_price": target_price, "rr": rr,
            "dev_pct": dev_pct, "day_high": day_high, "day_low": day_low,
            "day_avg": day_avg, "day_range": day_range, "avg5_range": avg5,
            "stop_vs_range": stop_vs_range, "stop_vs_avg": stop_vs_avg,
            "risk_amt": body.stop_points * mult * body.lots if mult else None,
            "reward_amt": body.target_points * mult * body.lots if mult else None,
            "multiplier": mult or None,
            "checks": rule_checks,
        },
        "advice": advice,
    }


# ---------------------------------------------------------------- 日内超短雷达

# 时段判定（超短线不同时段打法不同）


TRADES_FILE = BASE_DIR / "trades.json"


def _load_trades() -> list[dict]:
    if TRADES_FILE.exists():
        try:
            return json.loads(TRADES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_trades(trades: list[dict]) -> None:
    try:
        TRADES_FILE.write_text(json.dumps(trades, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


class TradeIn(BaseModel):
    symbol: str
    direction: str  # long / short
    entry: float
    stop_points: float
    target_points: float
    lots: float = 1
    date: str = ""
    ai_grade: str = ""   # AI 评估时的风险评级快照（低/中/高）
    trail_points: float = 0  # 追踪止盈回撤点数（0=自动：止损距离×0.5）
    trail_arm: float = 0     # 追踪激活所需浮盈点数（0=自动：=止损距离，即盈亏比1:1时启动）


@app.post("/api/trades")
async def add_trade(body: TradeIn):
    if body.direction not in ("long", "short"):
        raise HTTPException(status_code=400, detail="direction 仅支持 long/short")
    trades = _load_trades()
    trade = {
        "id": f"t{int(datetime.now().timestamp() * 1000)}",
        "ts": int(datetime.now().timestamp() * 1000),
        "date": body.date.strip() or datetime.now().strftime("%Y-%m-%d"),
        "symbol": body.symbol.strip().upper(),
        "direction": body.direction,
        "entry": body.entry,
        "stop_points": body.stop_points,
        "target_points": body.target_points,
        "lots": body.lots,
        "ai_grade": body.ai_grade.strip(),
        "status": "open",     # open 待验证 / closed 已了结
        "exit": None,         # 平仓价
        "result_pts": None,   # 结果：盈亏点数（正/负）
        "note": "",
        "trail": _init_trail(body.entry, body.stop_points, body.target_points,
                             body.trail_points, body.trail_arm),
    }
    trades.append(trade)
    _save_trades(trades)
    return {"ok": True, "item": trade}


class TradePatch(BaseModel):
    exit: Optional[float] = None       # 平仓价（与 result_pts 二选一）
    result_pts: Optional[float] = None  # 直接填盈亏点数
    note: Optional[str] = None
    status: Optional[str] = None       # closed / open / 放弃可填 closed 且 result 0？约定：abandoned
    trail_points: Optional[float] = None  # 调整追踪止盈回撤点数


@app.patch("/api/trades/{trade_id}")
async def patch_trade(trade_id: str, body: TradePatch):
    trades = _load_trades()
    for t in trades:
        if t["id"] != trade_id:
            continue
        if body.exit is not None:
            t["exit"] = body.exit
            sign = 1 if t["direction"] == "long" else -1
            t["result_pts"] = round(sign * (body.exit - t["entry"]), 1)
        if body.result_pts is not None:
            t["result_pts"] = body.result_pts
        if body.note is not None:
            t["note"] = body.note
        if body.trail_points is not None and body.trail_points > 0:
            if not t.get("trail"):
                t["trail"] = _init_trail(t["entry"], t["stop_points"], t["target_points"])
            t["trail"]["points"] = round(body.trail_points, 1)
        if body.status:
            if body.status not in ("open", "closed", "abandoned"):
                raise HTTPException(status_code=400, detail="status 仅支持 open/closed/abandoned")
            t["status"] = body.status
        if t.get("result_pts") is not None or t["status"] == "abandoned":
            if t["status"] == "open":
                t["status"] = "closed"
        _save_trades(trades)
        return {"ok": True, "item": t}
    raise HTTPException(status_code=404, detail="交易记录不存在")


@app.delete("/api/trades/{trade_id}")
async def del_trade(trade_id: str):
    trades = _load_trades()
    remain = [t for t in trades if t["id"] != trade_id]
    if len(remain) == len(trades):
        raise HTTPException(status_code=404, detail="交易记录不存在")
    _save_trades(remain)
    return {"ok": True}


@app.get("/api/trades")
async def get_trades():
    items = list(reversed(_load_trades()))  # 新的在前
    # 持仓单附加实时动态止盈状态（只算不落库）
    for t in items:
        if t.get("status") != "open":
            continue
        sym = t["symbol"]
        price = (_quote_cache.get(sym, (0, {}))[1] or {}).get("last")
        if not price:
            try:
                price = (await fetch_quote(sym)).get("last")
            except Exception:
                price = None
        if not price:
            continue
        sign = 1 if t["direction"] == "long" else -1
        tr = t.get("trail") or {}
        t["live"] = {
            "price": price,
            "pnl_pts": round(sign * (price - t["entry"]), 1),
            "peak": tr.get("peak"),
            "active": tr.get("active", False),
            "triggered": tr.get("triggered", False),
            "partial_done": tr.get("partial_done", False),
            "trail_line": round(tr["peak"] - sign * tr["points"], 2) if tr.get("active") and not tr.get("triggered") else None,
        }
    return {"ok": True, "items": items}


@app.get("/api/trades/stats")
async def trades_stats():
    """复盘统计：总览 + 分品种 + AI 评级采纳对比"""
    trades = _load_trades()
    closed = [t for t in trades if t["status"] == "closed" and t.get("result_pts") is not None]
    open_n = sum(1 for t in trades if t["status"] == "open")
    abandoned = sum(1 for t in trades if t["status"] == "abandoned")

    def _summary(items):
        if not items:
            return {"count": 0}
        pts = [t["result_pts"] for t in items]
        wins = [p for p in pts if p > 0]
        losses = [p for p in pts if p < 0]
        plan_rr = [t["target_points"] / t["stop_points"] for t in items if t.get("stop_points")]
        return {
            "count": len(items),
            "win_rate": round(len(wins) / len(items) * 100, 1),
            "total_pts": round(sum(pts), 1),
            "avg_win": round(sum(wins) / len(wins), 1) if wins else 0,
            "avg_loss": round(sum(losses) / len(losses), 1) if losses else 0,
            "avg_plan_rr": round(sum(plan_rr) / len(plan_rr), 2) if plan_rr else None,
            "profit_factor": round(abs(sum(wins) / sum(losses)), 2) if losses and sum(losses) != 0 else None,
        }

    by_symbol = {}
    for t in closed:
        by_symbol.setdefault(t["symbol"], []).append(t)
    by_grade = {}
    for t in closed:
        by_grade.setdefault(t.get("ai_grade") or "未评估", []).append(t)

    return {
        "ok": True,
        "overview": _summary(closed),
        "open_count": open_n,
        "abandoned_count": abandoned,
        "by_symbol": {s: _summary(v) for s, v in sorted(by_symbol.items())},
        "by_grade": {g: _summary(v) for g, v in sorted(by_grade.items())},
    }


# ---------------------------------------------------------------- Tick 逐笔采样（2 秒）


_MONITOR = {
    "events": [],       # 异动事件（新在后，内存保留最近 100 条）
    "cooldown": {},     # (symbol, dir) -> 触发时间（loop time），防轰炸
    "watch": set(),     # 前端自选注册（随行情轮询自动更新）
    "last_check": None,
}


MONITOR_INTERVAL = 30.0    # 巡检周期（秒）


MONITOR_COOLDOWN = 900.0   # 同品种同方向冷却（15 分钟）


MONITOR_MAX_EVENTS = 100


_EQUITY_RE = re.compile(r"^(IF|IH|IC|IM)\d")


_BOND_RE = re.compile(r"^(T|TF|TS|TL)\d")


def _monitor_threshold(symbol: str, mult: float) -> float:
    """5 分钟急涨急跌阈值（%），按品种波动特征适配"""
    if _EQUITY_RE.match(symbol):
        base = 0.2
    elif _BOND_RE.match(symbol):
        base = 0.1
    elif symbol.startswith(("AU", "AG")):
        base = 0.3
    else:
        base = 0.5
    return base * mult


_SESSIONS = [
    ("21:00", "23:00", "夜盘前段", "外盘联动最紧、波动集中；单量给足，严格按触发价进出场"),
    ("23:00", "02:30", "夜盘后段", "流动性下降、点差变宽；超短降频，有利润先落袋"),
    ("09:00", "10:15", "早盘", "日内方向定性窗口：开盘30分钟区间（IR）突破是经典超短打法"),
    ("10:15", "10:30", "小节休息", "停盘间隙，挂单不成交，等待复牌"),
    ("10:30", "11:30", "上午中段", "主趋势延续或震荡消化；只顺早盘定下的方向做"),
    ("13:30", "14:30", "午盘", "二次启动高发时段：关注上午高低点的突破与假突破"),
    ("14:30", "15:00", "尾盘", "减仓时段流动性衰减；超短只平不开，谨防收盘跷跷板"),
]


def _session_info(now: datetime) -> tuple[str, str]:
    hm = now.strftime("%H:%M")
    for start, end, name, tip in _SESSIONS:
        if start <= hm < end:
            return name, tip
    if "02:30" <= hm < "09:00":
        return "休市", "商品期货休市（金融期货 09:30 开盘）"
    if "11:30" <= hm < "13:30":
        return "午休", "午间休市，关注外盘变化与上午结构"
    return "休市", "当前无交易时段"


async def _scalp_snapshot(symbol: str) -> dict:
    """日内超短雷达：结构定位 / 动能 / 量价持仓配合 / 可交易性（纯程序计算，不调 AI）"""
    rows = await get_minute(symbol, "1")
    if len(rows) < 20:
        raise RuntimeError("分钟线数据不足")

    quote = _quote_cache.get(symbol, (0, {}))[1] or {}
    last = rows[-1]["close"] or quote.get("last")
    if not last:
        raise RuntimeError("无有效价格")

    # 当日分钟线（夜盘品种取最后一段连续交易日的数据）
    day = rows[-1]["datetime"][:10]
    today = [r for r in rows if r["datetime"].startswith(day)]
    if len(today) < 5:  # 刚开盘数据太少，改用上一段完整交易日
        day = rows[-len(today) - 1]["datetime"][:10]
        today = [r for r in rows if r["datetime"].startswith(day)]
    if not today:
        raise RuntimeError("当日无分钟数据")

    day_high = max(r["high"] or r["close"] or 0 for r in today)
    day_low = min(r["low"] or r["close"] or 9e12 for r in today)
    vsum = sum(r["volume"] or 0 for r in today)
    vwap = round(sum((r["close"] or 0) * (r["volume"] or 0) for r in today) / max(1e-9, vsum), 2) if vsum else None
    pos_pct = round((last - day_low) / max(1e-9, day_high - day_low) * 100, 1) if day_high > day_low else 50.0
    vwap_dev = round((last / vwap - 1) * 100, 2) if vwap else None

    # 开盘初始区间（前 30 分钟高低点）
    ir_rows = today[:30]
    ir_high = max((r["high"] or r["close"] or 0) for r in ir_rows)
    ir_low = min((r["low"] or r["close"] or 9e12) for r in ir_rows)
    if ir_high > ir_low:
        if last > ir_high:
            ir_state = "已上破开盘区间"
        elif last < ir_low:
            ir_state = "已跌破开盘区间"
        else:
            ir_state = "开盘区间内震荡"
    else:
        ir_state = "区间未形成"

    # 短周期动能
    def _ref(n: int):
        return rows[-n]["close"] if len(rows) >= n else None

    r5, r15, r30 = _ref(6), _ref(16), _ref(31)
    chg = lambda ref: round((last / ref - 1) * 100, 2) if ref else None
    chg5, chg15, chg30 = chg(r5), chg(r15), chg(r30)

    # 连续同向 1 分钟K线
    streak = 0
    if rows[-1]["close"] and rows[-1]["open"]:
        direction = 1 if rows[-1]["close"] >= rows[-1]["open"] else -1
        for r in reversed(rows):
            if not (r["close"] and r["open"]):
                break
            if (1 if r["close"] >= r["open"] else -1) == direction:
                streak += 1
            else:
                break
        streak = streak if direction > 0 else -streak

    # 量能：近15分钟均量 vs 当日均量
    vols_day = [r["volume"] or 0 for r in today]
    avg_day = sum(vols_day) / max(1, len(vols_day))
    vols15 = [r["volume"] or 0 for r in rows[-15:]]
    avg15 = sum(vols15) / max(1, len(vols15))
    vol_ratio = round(avg15 / avg_day, 2) if avg_day > 0 else None

    # 持仓变化（15/30分钟）
    pos_now = rows[-1]["position"]
    pos15 = (round(pos_now - rows[-16]["position"]) if pos_now is not None and len(rows) >= 16 and rows[-16]["position"] is not None else None)
    pos30 = (round(pos_now - rows[-31]["position"]) if pos_now is not None and len(rows) >= 31 and rows[-31]["position"] is not None else None)

    # 量价持仓配合定性
    if chg15 is not None and pos15 is not None:
        up = chg15 > 0.02
        dn = chg15 < -0.02
        if up and pos15 > 0:
            flow = "增仓上行（新资金推动，顺势可跟）"
        elif up and pos15 < 0:
            flow = "减仓上行（空头回补主导，追多需谨慎）"
        elif dn and pos15 > 0:
            flow = "增仓下行（新空压制，勿急接飞刀）"
        elif dn and pos15 < 0:
            flow = "减仓下行（多头止损离场，跌势未完但近尾声区）"
        else:
            flow = "量价均衡（观望或区间思维）"
    else:
        flow = None

    # 噪音：近15分钟平均每分钟振幅%
    amps = [(r["high"] - r["low"]) / r["close"] * 100 for r in rows[-15:] if r["high"] and r["low"] and r["close"]]
    noise = round(sum(amps) / len(amps), 3) if amps else None

    # 可交易性评分（0-100）：量能活跃 + 短时波动足够 + 噪音适中
    prefix = _variety_prefix(symbol)
    threshold = _monitor_threshold(symbol, 1.0)
    s_vol = min(1.0, (vol_ratio or 0.5) / 1.5) * 40
    s_move = min(1.0, abs(chg15 or 0) / (threshold * 1.5)) * 35
    s_noise = (1 - min(1.0, (noise or 0.08) / 0.25)) * 25
    score = round(min(100, max(0, s_vol + s_move + s_noise)))
    grade = "活跃" if score >= 65 else ("一般" if score >= 40 else "清淡")

    session, session_tip = _session_info(datetime.now())

    # 程序结论（3-5条要点，超短视角）
    pts = []
    pos_word = "偏强（区间上沿）" if pos_pct >= 70 else ("偏弱（区间下沿）" if pos_pct <= 30 else "中轴附近")
    if vwap_dev is not None:
        pts.append(f"现价处于日内区间 {pos_pct:.0f}% 分位（{pos_word}），VWAP {'上方' if vwap_dev > 0 else '下方'} {abs(vwap_dev):.2f}%")
    if chg5 is not None:
        arrow = "↑" if chg5 > 0 else "↓"
        pts.append(f"短时动能：5分 {chg5:+.2f}% / 15分 {chg15:+.2f}% / 30分 {chg30:+.2f}%，连续{abs(streak)}根{'阳' if streak > 0 else '阴'}线" if streak else f"短时动能：5分 {chg5:+.2f}% / 15分 {chg15:+.2f}%")
    if vol_ratio is not None:
        pts.append(f"量能：近15分钟 {'放量' if vol_ratio >= 1.3 else ('缩量' if vol_ratio <= 0.7 else '持平')}（{vol_ratio}×日均）" + (f"，持仓15分{'+' if pos15 > 0 else ''}{pos15:.0f} → {flow}" if pos15 is not None and flow else ""))
    elif flow:
        pts.append(f"持仓：{flow}")
    pts.append(f"开盘区间（IR）{ir_low:g}~{ir_high:g}：{ir_state}")
    pts.append(f"时段：{session}——{session_tip}")

    return {
        "symbol": symbol, "name": (await get_directory()).get(symbol, {}).get("name", ""),
        "last": last, "day_high": day_high, "day_low": day_low,
        "vwap": vwap, "vwap_dev": vwap_dev, "pos_pct": pos_pct,
        "ir_high": ir_high, "ir_low": ir_low, "ir_state": ir_state,
        "chg5": chg5, "chg15": chg15, "chg30": chg30, "streak": streak,
        "vol_ratio": vol_ratio, "pos_chg15": pos15, "pos_chg30": pos30, "flow": flow,
        "noise_pct": noise, "score": score, "grade": grade,
        "session": session, "session_tip": session_tip,
        "points": pts, "ts": int(datetime.now().timestamp() * 1000),
    }


@app.get("/api/scalp/{symbol}")
async def scalp_api(symbol: str):
    try:
        snap = await _scalp_snapshot(symbol.strip().upper())
        return {"ok": True, **snap}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"雷达计算失败：{e}")


SCALP_AI_PROMPT = """你是超短线（日内波段）交易教练。以下是程序实时计算的日内超短雷达数据，请给出可直接执行的超短作战建议。

【品种】{symbol}（{name}） 现价 {last}
【结构】日内 {day_low}~{day_high}，现价处 {pos_pct}% 分位；VWAP {vwap}（偏离 {vwap_dev}%）；开盘区间(IR) {ir_low}~{ir_high}，{ir_state}
【动能】5分 {chg5}% / 15分 {chg15}% / 30分 {chg30}%；连续 {streak} 根同向分钟线
【量持仓】近15分钟量能 {vol_ratio}× 日均；持仓15分变化 {pos_chg15}（{flow}）
【环境】可交易性 {score}/100（{grade}）；时段：{session}（{session_tip}）
【程序结论】
{points}

请输出（Markdown，500字内，全部给具体价格；注意 IR 状态描述的是现况——若已上破/跌破，触发价应基于回踩确认位或延伸目标，而非已经过去的突破位）：
1. **当日结构判读**：趋势日 or 震荡日？主方向与关键分水岭（具体价位）
2. **超短计划**：
   - 若顺势：入场触发价、止损价（具体点位，说明逻辑依据）、第一目标、移动止盈启动条件
   - 若逆势/等待：明确"不做"的条件与重新入场的触发价
3. **量价确认要点**：下一根放量/缩量、增仓/减仓分别怎么应对
4. **时段纪律**：结合当前时段（{session}）的执行纪律
5. **风险一句话**：今天最可能打脸的场景
结尾固定一句：以上为盘面推演，不构成投资建议。"""


@app.post("/api/scalp/{symbol}/ai")
async def scalp_ai_api(symbol: str):
    try:
        snap = await _scalp_snapshot(symbol.strip().upper())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"雷达计算失败：{e}")
    prompt = SCALP_AI_PROMPT.format(
        symbol=snap["symbol"], name=snap["name"], last=snap["last"],
        day_low=snap["day_low"], day_high=snap["day_high"], pos_pct=snap["pos_pct"],
        vwap=snap["vwap"], vwap_dev=snap["vwap_dev"],
        ir_low=snap["ir_low"], ir_high=snap["ir_high"], ir_state=snap["ir_state"],
        chg5=snap["chg5"], chg15=snap["chg15"], chg30=snap["chg30"], streak=abs(snap["streak"]),
        vol_ratio=snap["vol_ratio"], pos_chg15=snap["pos_chg15"], flow=snap["flow"] or "--",
        score=snap["score"], grade=snap["grade"], session=snap["session"], session_tip=snap["session_tip"],
        points="\n".join(f"- {p}" for p in snap["points"]),
    )
    profile = _profile_context()
    position = _position_context()
    if profile:
        prompt = profile + "\n\n" + prompt
    if position:
        prompt = position + "\n\n" + prompt
    try:
        advice = await _call_ai_with_fallback(
            [{"role": "user", "content": prompt}],
            max_tokens=min(3072, max_output_for(load_config()["model"] or "")),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 解读失败：{e}")
    return {"ok": True, "snapshot": snap, "advice": advice}


# ---------------------------------------------------------------- 交易日志与复盘统计


def _init_trail(entry: float, stop_points: float, target_points: float,
                trail_points: float = 0, trail_arm: float = 0) -> dict:
    """持仓动态止盈（追踪止盈）初始状态"""
    return {
        "points": round(trail_points or stop_points * 0.5, 1),   # 峰值回撤点数
        "arm": round(trail_arm or stop_points, 1),               # 激活阈值（浮盈点数）
        "target": target_points,
        "peak": entry,          # 持仓期间极值（多=最高 / 空=最低）
        "active": False,        # 是否已激活追踪
        "triggered": False,     # 移动止盈是否已触发（触发后不再重复报）
        "partial_done": False,  # 是否已提示分批止盈
    }


def _trail_state(t: dict, price: float) -> list[dict]:
    """更新单笔持仓的追踪止盈状态；返回本轮产生的提示事件（不落库、不推送，由调用方处理）"""
    tr = t.get("trail")
    if not tr or t.get("status") != "open" or not price:
        return []
    events: list[dict] = []
    sign = 1 if t["direction"] == "long" else -1
    pnl = sign * (price - t["entry"])
    # 更新极值（追踪线随行情上移/下移，只进不退）
    if sign * (price - tr["peak"]) > 0:
        tr["peak"] = price
    # 激活：浮盈达到 arm 点
    if not tr["active"] and pnl >= tr["arm"]:
        tr["active"] = True
        events.append({"etype": "arm", "price": price, "pnl": round(pnl, 1),
                       "line": round(tr["peak"] - sign * tr["points"], 2)})
    # 分批提示：浮盈达到原目标位（一次性）
    if not tr["partial_done"] and pnl >= tr["target"]:
        tr["partial_done"] = True
        events.append({"etype": "partial", "price": price, "pnl": round(pnl, 1),
                       "line": round(tr["peak"] - sign * tr["points"], 2)})
    # 触发：激活后价格回撤到追踪线（一次性，触发后该笔不再监控）
    if tr["active"] and not tr["triggered"]:
        line = round(tr["peak"] - sign * tr["points"], 2)
        if sign * (line - price) >= 0:
            tr["triggered"] = True
            events.append({"etype": "trigger", "price": price, "pnl": round(pnl, 1), "line": line})
    return events


TRAIL_TEXT = {
    "arm": "🎯 {sym} {d}浮盈 +{pnl:.0f} 点，移动止盈激活：峰值 {peak} 回撤 {points:.0f} 点即离场（当前追踪线 {line}）",
    "partial": "📍 {sym} {d}浮盈 +{pnl:.0f} 点已达目标位：建议减仓 1/2，剩余改用移动止盈（追踪线 {line}）",
    "trigger": "✅ {sym} {d}移动止盈触发：{verb}追踪线 {line}，建议离场锁盈（当前浮盈 {pnl:+.0f} 点）",
}


async def trail_loop():
    """动态止盈巡检：对交易日志中的持仓单每 30 秒更新追踪止盈状态，触发提示进异动流 + 飞书"""
    await asyncio.sleep(25)
    while True:
        try:
            now = datetime.now()
            if is_trading_time(now) or (now.weekday() < 5 and 20 <= now.hour < 24):
                trades = _load_trades()
                open_trades = [t for t in trades if t.get("status") == "open" and t.get("trail")]
                if open_trades:
                    loop_now = asyncio.get_event_loop().time()
                    prices: dict[str, float] = {}
                    for sym in {t["symbol"] for t in open_trades}:
                        ts, q = _quote_cache.get(sym, (0, {}))
                        price = (q or {}).get("last")
                        if not price or loop_now - ts > 10:
                            try:
                                price = (await fetch_quote(sym)).get("last")
                            except Exception:
                                price = None
                        if price:
                            prices[sym] = price
                    changed = False
                    for t in open_trades:
                        price = prices.get(t["symbol"])
                        if not price:
                            continue
                        events = _trail_state(t, price)
                        if events:
                            changed = True
                            d = "多" if t["direction"] == "long" else "空"
                            for ev in events:
                                text = TRAIL_TEXT[ev["etype"]].format(
                                    sym=t["symbol"], d=d, pnl=ev["pnl"],
                                    peak=round(t["trail"]["peak"], 1), points=t["trail"]["points"],
                                    line=ev["line"], verb="跌破" if t["direction"] == "long" else "升破",
                                )
                                _MONITOR["events"].append({
                                    "id": f"{t['symbol']}-trail-{ev['etype']}-{t['id']}",
                                    "ts": int(datetime.now().timestamp() * 1000),
                                    "kind": "trail", "etype": ev["etype"],
                                    "symbol": t["symbol"], "dir": "up" if t["direction"] == "long" else "down",
                                    "price": price, "line": ev["line"], "pnl": ev["pnl"],
                                    "text": text,
                                    # 兼容字段：旧版前端按普通异动事件渲染时不显示 undefined
                                    "chg5": 0.0, "chg15": 0.0, "threshold": 0.0, "intl": True, "ai": "",
                                })
                                asyncio.create_task(_feishu_push(text))
                    if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
                        _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
                    if changed:
                        _save_trades(trades)
        except Exception:
            pass
        await asyncio.sleep(30)


_radar_prev: dict[str, dict] = {}   # 上轮快照关键字段（sym -> {score, grade, ir_state, flow}）


_radar_cool: dict[tuple, float] = {}  # (sym, 变化类型) -> loop time，10 分钟冷却


def _grade_of(score: int) -> str:
    return "活跃" if score >= 65 else ("一般" if score >= 40 else "清淡")


async def _radar_check(sym: str) -> None:
    """单品种雷达异变检测：评分跨档 / IR 突破 / 量价定性翻转 → 作战流（IR 突破加推飞书）"""
    try:
        snap = await _scalp_snapshot(sym)
    except Exception:
        return
    cur = {
        "score": snap["score"], "grade": snap["grade"],
        "ir_state": snap["ir_state"], "flow": snap["flow"] or "",
    }
    prev = _radar_prev.get(sym)
    _radar_prev[sym] = cur
    if not prev:
        return  # 首轮建档
    loop_now = asyncio.get_event_loop().time()
    name = snap.get("name") or sym

    def _emit(ctype: str, text: str, feishu: bool = False, level: str = "info"):
        key = (sym, ctype)
        if loop_now - _radar_cool.get(key, -1e9) < 600:
            return
        _radar_cool[key] = loop_now
        _MONITOR["events"].append({
            "id": f"radar-{sym}-{ctype}-{int(loop_now)}",
            "ts": int(datetime.now().timestamp() * 1000),
            "kind": "radar", "etype": ctype, "level": level,
            "symbol": sym, "name": name, "dir": "up",
            "price": snap["last"], "text": text,
            # 兼容字段：旧版前端按普通异动事件渲染时不显示 undefined
            "chg5": 0.0, "chg15": 0.0, "threshold": 0.0, "intl": True, "ai": "",
        })
        if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
            _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
        if feishu:
            asyncio.create_task(_feishu_push(f"📡 超短雷达 · {sym}（{name}）\n{text}\n现价 {snap['last']}"))

    # IR 突破/跌回（超短关键结构事件）
    if prev["ir_state"] != cur["ir_state"]:
        if "上破" in cur["ir_state"]:
            _emit("ir", f"{sym} 上破开盘区间（IR {snap['ir_low']:g}~{snap['ir_high']:g}），现价 {snap['last']}——真突破跟进或防假突破回抽", feishu=True, level="warn")
        elif "跌破" in cur["ir_state"]:
            _emit("ir", f"{sym} 跌破开盘区间（IR {snap['ir_low']:g}~{snap['ir_high']:g}），现价 {snap['last']}——日内转弱信号", feishu=True, level="warn")

    # 可交易性跨档（清淡↔一般↔活跃）
    if prev["grade"] != cur["grade"]:
        arrow = "↑" if cur["score"] > prev["score"] else "↓"
        _emit("grade", f"{sym} 可交易性 {prev['grade']}→{cur['grade']}（{prev['score']}→{cur['score']}{arrow}）"
              + ("，波动启动可关注" if cur["score"] > prev["score"] else "，波动衰减建议观望"))

    # 量价定性翻转
    if prev["flow"] and cur["flow"] and prev["flow"] != cur["flow"]:
        _emit("flow", f"{sym} 量价定性翻转：{prev['flow'].split('（')[0]} → {cur['flow'].split('（')[0]}")


async def radar_loop():
    """超短雷达异变监控：盯盘品种（自选+持仓+画像）每 60 秒对比快照，关键变化进作战流"""
    await asyncio.sleep(45)
    while True:
        try:
            now = datetime.now()
            if is_trading_time(now) or (now.weekday() < 5 and 20 <= now.hour < 24):
                syms = ({s.upper() for s in _MONITOR["watch"]}
                        | {t["symbol"] for t in _load_trades() if t.get("status") == "open"}
                        | set(_load_profile().get("symbols") or []))
                for sym in sorted(syms)[:8]:
                    await _radar_check(sym)
        except Exception:
            pass
        await asyncio.sleep(60)


# ---------------------------------------------------------------- AI 记忆画像


CAL_TTL = 600.0


_calendar_cache: dict = {"date": "", "ts": 0.0, "items": []}


async def get_calendar(date: str = "") -> list[dict]:
    """当日宏观事件日历（百度财经，含公布/预期/前值/重要性）"""
    date = date or datetime.now().strftime("%Y%m%d")
    today = datetime.now().strftime("%Y%m%d")
    loop_now = asyncio.get_event_loop().time()
    if (_calendar_cache["date"] == date and loop_now - _calendar_cache["ts"] < CAL_TTL):
        return _calendar_cache["items"]
    try:
        df = await call_ak(ak.news_economic_baidu, date=date)

        def _cell(r: dict, key: str) -> str:
            v = r.get(key)
            if v is None or (isinstance(v, float) and pd.isna(v)):
                return ""
            return str(v)

        items = []
        for r in df.to_dict("records"):
            event = _cell(r, "事件")
            if not event:
                continue
            try:
                imp = int(float(_cell(r, "重要性") or 1))
            except (TypeError, ValueError):
                imp = 1
            items.append(
                {
                    "date": _cell(r, "日期"),
                    "time": _cell(r, "时间"),
                    "region": _cell(r, "地区"),
                    "event": event,
                    "actual": _cell(r, "公布"),
                    "forecast": _cell(r, "预期"),
                    "previous": _cell(r, "前值"),
                    "importance": imp,
                }
            )
        items.sort(key=lambda x: x["time"])
        _calendar_cache.update({"date": date, "ts": loop_now, "items": items})
        return items
    except Exception as e:
        logging.getLogger("uvicorn.error").info(f"[calendar] {date} 失败：{e}")
        return _calendar_cache["items"] if _calendar_cache["date"] == date else []


def _calendar_context() -> str:
    """今日重要宏观事件（未公布的优先），供 AI 判断时机风险"""
    items = _calendar_cache["items"] if _calendar_cache["date"] == datetime.now().strftime("%Y%m%d") else []
    if not items:
        return ""
    now_hm = datetime.now().strftime("%H:%M")
    key = [it for it in items if it["importance"] >= 2]
    upcoming = [it for it in key if it["time"] > now_hm]
    released = [it for it in key if it["time"] <= now_hm][-5:]
    lines = []
    if upcoming:
        lines.append("即将公布（留意时段风险）：" + "；".join(
            f"{it['time']} {it['region']}{it['event']}（预期{it['forecast'] or '--'}）" for it in upcoming[:6]))
    if released:
        lines.append("已公布：" + "；".join(
            f"{it['time']} {it['event']} 公布{it['actual'] or '--'}预期{it['forecast'] or '--'}" for it in released))
    if not lines:
        return ""
    return "【今日宏观事件日历（重要性≥2）】\n" + "\n".join(lines)


# ---------------------------------------------------------------- AI 盯盘引擎


@app.get("/api/calendar")
async def calendar(date: str = ""):
    items = await get_calendar(date)
    return {"ok": True, "items": items}


@app.get("/api/signal-accuracy/{symbol}")
async def signal_accuracy_api(symbol: str, lookforward: int = 5):
    """各技术信号的历史胜率统计"""
    from indicators import signal_accuracy as calc_acc
    try:
        daily = await get_daily(symbol)
        import pandas as pd
        df = pd.DataFrame(daily[-500:])  # 最近 500 根
        results = {}
        for name in ["MACD 金叉", "MACD 死叉", "站上 MA20", "跌破 MA20", "均线多头排列", "均线空头排列"]:
            results[name] = calc_acc(df, name, lookforward)
        return {"ok": True, "symbol": symbol, "lookforward": lookforward, "results": results}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"统计失败：{e}")


async def _intraday_summary(symbol: str) -> str:
    """日内分时结构摘要：开高低与出现时间、均价偏离、量能分布、尾盘动向"""
    try:
        rows = await get_minute(symbol, "1")
    except Exception:
        return ""
    rows = [r for r in rows if r.get("close")]
    if len(rows) < 10:
        return ""
    day = rows[-1]["datetime"][:10]
    today = [r for r in rows if r["datetime"].startswith(day)]
    if len(today) < 10:
        today = rows[-240:]
    opens = today[0]["open"] or today[0]["close"]
    hi = max(today, key=lambda r: r["high"] or 0)
    lo = min(today, key=lambda r: r["low"] or r["close"] or 0)
    last = today[-1]
    avg = sum(r["close"] * (r["volume"] or 0) for r in today) / max(1e-9, sum(r["volume"] or 0 for r in today))
    dev = (last["close"] / avg - 1) * 100 if avg else 0
    am = sum(r["volume"] or 0 for r in today if r["datetime"][11:13] < "13")
    pm = sum(r["volume"] or 0 for r in today if r["datetime"][11:13] >= "13")
    am_pct = am / max(1, am + pm) * 100
    tail = today[-30:]
    tail_chg = (tail[-1]["close"] / tail[0]["close"] - 1) * 100 if len(tail) >= 2 and tail[0]["close"] else 0
    pos = "上方" if last["close"] >= (opens or last["close"]) else "下方"
    return (
        f"今开 {opens}，最高 {hi['high']}（{hi['datetime'][11:16]}），最低 {lo['low']}（{lo['datetime'][11:16]}），"
        f"现价 {last['close']}（位于今开{pos}，偏离日内加权均价 {dev:+.2f}%）；"
        f"量能：上午占 {am_pct:.0f}%{'（午后放量）' if am_pct < 50 else ''}；尾盘30分钟 {tail_chg:+.2f}%"
    )


def _daily_stats(daily: list) -> str:
    """近 60 日统计：区间分位、持仓变化、量能趋势"""
    rows = [r for r in daily[-60:] if r.get("close")]
    if len(rows) < 20:
        return ""
    closes = [r["close"] for r in rows]
    cur = closes[-1]
    pct = sum(1 for c in closes if c <= cur) / len(closes) * 100
    hold_chg = ""
    if rows[0].get("hold") and rows[-1].get("hold"):
        d = rows[-1]["hold"] - rows[0]["hold"]
        hold_chg = f"，持仓较60日前{'增' if d > 0 else '减'} {abs(d):.0f} 手"
    v_recent = sum(r.get("volume") or 0 for r in rows[-5:]) / 5
    v_before = sum(r.get("volume") or 0 for r in rows[-15:-5]) / 10
    v_ratio = v_recent / max(1e-9, v_before)
    vol_note = "放量" if v_ratio > 1.2 else ("缩量" if v_ratio < 0.8 else "量能平稳")
    return (
        f"近60日区间 {min(closes)}~{max(closes)}，当前处于 {pct:.0f}% 分位{hold_chg}；"
        f"近5日均量/前10日均量 = {v_ratio:.2f}（{vol_note}）"
    )


# ---------------------------------------------------------------- 开仓风险评估（日内短线）

# 主要品种合约乘数（元/点/手），用于风险金额估算；未知品种不计算金额


@app.get("/api/tick/{symbol}")
async def tick_quote(symbol: str):
    """单合约轻量行情（新浪 hq 原始接口，供前端 2 秒 Tick 采样）"""
    symbol = symbol.strip().upper()
    if symbol in INTL_SYMBOLS and symbol != "DINIW":
        # 国际品种：新浪 hf_ 前缀。[0]最新 [2]买 [3]卖 [4]高 [5]低 [6]时间 [7]昨结 [8]开 [11]日期 [12]名称
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                f"https://hq.sinajs.cn/list=hf_{symbol}",
                headers={"Referer": "https://finance.sina.com.cn/futures/"},
            )
        m = re.search(r'"([^"]+)"', r.text)
        if not m:
            raise HTTPException(status_code=502, detail="无数据")
        f = m.group(1).split(",")
        if len(f) < 13 or not f[0]:
            raise HTTPException(status_code=502, detail="行情字段异常")
        return {"ok": True, "symbol": symbol, "intl": True, "name": INTL_SYMBOLS[symbol]["name"],
                "time": f[6], "date": f[11],
                "last": _num(f[0]), "bid": _num(f[2]), "ask": _num(f[3]),
                "high": _num(f[4]), "low": _num(f[5]),
                "open": _num(f[8]), "prev_settle": _num(f[7]),
                "position": _num(f[13]), "volume": None}
    if symbol == "DINIW":
        return await _fetch_intl_one("DINIW", INTL_SYMBOLS["DINIW"])
    async with httpx.AsyncClient(timeout=8) as client:
        r = await client.get(
            f"https://hq.sinajs.cn/list=nf_{symbol}",
            headers={"Referer": "https://finance.sina.com.cn/futures/"},
        )
    m = re.search(r'"([^"]+)"', r.text)
    if not m:
        raise HTTPException(status_code=502, detail="无数据")
    f = m.group(1).split(",")
    if len(f) < 15 or not f[8]:
        raise HTTPException(status_code=502, detail="行情字段异常")
    t = f[1]
    return {"ok": True, "symbol": symbol, "name": f[0],
            "time": f"{t[0:2]}:{t[2:4]}:{t[4:6]}" if re.fullmatch(r"\d{6}", t) else t,
            "last": _num(f[8]), "bid": _num(f[6]), "ask": _num(f[7]),
            "bid_vol": _num(f[11]), "ask_vol": _num(f[12]),
            "position": _num(f[13]), "volume": _num(f[14]),
            "prev_settle": _num(f[10])}


# ---------------------------------------------------------------- 宏观事件日历


@app.get("/api/compare")
async def compare(symbols: str, mode: str = "ratio", limit: int = 120):
    """两品种对比：ratio 比价 / spread 价差 / normalized 归一化走势，附统计与分位"""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:4]
    if len(syms) < 2:
        raise HTTPException(status_code=400, detail="至少需要两个合约")
    if mode not in ("ratio", "spread", "normalized"):
        mode = "ratio"
    limit = min(max(limit, 30), 500)
    try:
        common, closes = await _aligned_closes(syms, limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"日线数据获取失败：{e}")
    if len(common) < 10:
        raise HTTPException(status_code=400, detail="公共交易日不足 10 天，无法对比")

    series = []
    if mode == "normalized":
        base = {s: closes[s][common[0]] for s in syms}
        for d in common:
            series.append({"date": d, "values": [round(closes[s][d] / base[s] * 100, 2) for s in syms]})
        return {"ok": True, "mode": mode, "symbols": syms, "items": series, "stats": None}

    a, b = syms[0], syms[1]
    for d in common:
        v = closes[a][d] / closes[b][d] if mode == "ratio" else closes[a][d] - closes[b][d]
        series.append({"date": d, "values": [round(v, 3)]})

    vals = [x["values"][0] for x in series]
    cur = vals[-1]
    mean = sum(vals) / len(vals)
    std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
    pct = sum(1 for v in vals if v <= cur) / len(vals) * 100
    stats = {
        "current": round(cur, 3),
        "mean": round(mean, 3),
        "std": round(std, 3),
        "min": round(min(vals), 3),
        "max": round(max(vals), 3),
        "percentile": round(pct, 1),
        "upper1": round(mean + std, 3),
        "lower1": round(mean - std, 3),
        "upper2": round(mean + 2 * std, 3),
        "lower2": round(mean - 2 * std, 3),
    }
    return {"ok": True, "mode": mode, "symbols": syms, "items": series, "stats": stats}


@app.get("/api/correlation")
async def correlation(symbols: str, days: int = 60):
    """多品种日收益率相关系数矩阵"""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:8]
    if len(syms) < 2:
        raise HTTPException(status_code=400, detail="至少需要两个合约")
    days = min(max(days, 20), 500)
    try:
        common, closes = await _aligned_closes(syms, days)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"日线数据获取失败：{e}")
    if len(common) < 15:
        raise HTTPException(status_code=400, detail="公共交易日不足，无法计算相关性")
    df = pd.DataFrame({s: [closes[s][d] for d in common] for s in syms})
    corr = df.pct_change().dropna().corr()
    return {
        "ok": True,
        "labels": syms,
        "matrix": [[None if v != v else round(float(v), 2) for v in row] for row in corr.values],
        "days": days,
    }


# ---------------------------------------------------------------- 交易心得


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8300)
