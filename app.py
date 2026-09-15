"""期货心理博弈分析助手 - 后端服务

世界观：价格由四方资金博弈决定——产业（套保）、主力（机构）、投机（热钱）、散户（情绪）。
本应用不做技术指标分析、不做资讯聚合，只回答四个问题：
  1. 四方资金现在各自在做什么（用价、量、持仓推断）？
  2. 散户此刻在想什么、可能怎么操作？
  3. 主力会怎么利用散户的情绪？
  4. 作为散户，如何顺应大势、顺应资金方向，而不是成为对手盘的流动性？

数据来源：AkShare / 新浪行情（价格+成交量+持仓量），免费、约 3~5 秒延迟，仅供研究参考。
AI 对话：OpenAI 兼容接口（智谱 GLM / DeepSeek / 自定义端点），Key 保存在本机 config.json。
"""

import asyncio
import json
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, time as dtime, timedelta
from functools import partial
from pathlib import Path
from typing import Optional

import akshare as ak
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import psychology as psy

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
        "default_model": "deepseek-flash",
    },
    "custom": {
        "label": "自定义 / Coding Plan",
        "base_url": "",  # 由设置页填写（Coding Plan 等 OpenAI 兼容端点）
        "default_model": "glm-5",
    },
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
    """LLM 调用候选（含兜底）：当前服务商在前，其余已存 Key 的按序在后。"""
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
    "custom_base_url": "",
    "api_keys": {},
    "feishu": {},    # 飞书：{app_id, app_secret, doc_title, doc_id, webhook_url}
    "monitor": {
        "enabled": True,
        "sensitivity": 1.0,          # 阈值倍率：0.5 灵敏 / 1 标准 / 2 迟钝
        "focus": ["SC0", "AU0"],
    },
    # 风控参数（诊断引擎的预警阈值，用户按自身账户设定，AI 不代定）
    "discipline": {
        "account_size": 0.0,       # 账户权益（0=未设置，风险类检查跳过）
        "risk_per_trade": 1.0,     # 单笔风险上限（总资金%）
        "daily_stop": 3.0,         # 日内止损线（总资金%，达到即当日停手）
        "daily_max_trades": 3,     # 日内开仓次数上限
        "cooling_min": 30,         # 亏损后的冷静等待期（分钟）
        "universe": [],            # 自选品种池（空 = 不限制）
    },
}

# 合约乘数（元/点/手），用于风险金额估算与仓位预警；未收录品种不计算金额
CONTRACT_MULTIPLIER: dict[str, float] = {
    "RB": 10, "HC": 10, "I": 100, "J": 100, "JM": 60, "SF": 5, "SM": 5,
    "CU": 5, "AL": 5, "ZN": 5, "PB": 5, "NI": 1, "SN": 1, "SS": 5,
    "AU": 1000, "AG": 15, "SC": 1000, "FU": 10, "BU": 10, "RU": 10, "NR": 10, "LU": 10, "BR": 5,
    "M": 10, "Y": 10, "P": 10, "OI": 10, "RM": 10, "C": 10, "CS": 10, "A": 10, "B": 10,
    "CF": 5, "SR": 10, "AP": 10, "CJ": 5, "PK": 5,
    "TA": 5, "MA": 10, "EG": 10, "EB": 5, "PP": 5, "L": 5, "V": 5, "PG": 20,
    "FG": 20, "SA": 20, "UR": 20, "AO": 20, "SH": 20, "LC": 5, "SI": 5,
    "IF": 300, "IH": 300, "IC": 200, "IM": 200, "T": 10000, "TF": 10000, "TS": 20000, "TL": 10000,
}

# 高相关品种组（同向持仓 = 隐形杠杆，诊断引擎合并预警）
CORR_GROUPS = {
    "原油系化工": {"MA", "TA", "V", "SC", "PG", "FU", "BU", "EB", "EG", "LU", "NR", "PP", "L"},
    "黑色系": {"RB", "HC", "I", "J", "JM", "SF", "SM"},
    "贵金属": {"AU", "AG"},
    "有色": {"CU", "AL", "ZN", "NI", "PB", "SN", "SS"},
    "油脂油料": {"M", "Y", "P", "OI", "RM"},
}

# 逆资金方向判定的"空头进攻"阶段（此阶段做多 = 与新空资金对赌）
_BEAR_REGIMES = {"趋势下行", "低位阴跌", "低位恐慌"}
_BEAR_CAPITAL = {"增仓下行"}


_cfg_cache: dict = {"mtime": None, "cfg": None}


def load_config() -> dict:
    """读取配置。高频调用（监控/诊断/LLM 每次都读）——按文件 mtime 缓存已解析结果，
    命中时返回深拷贝（调用方会修改后回存，不能共享引用）；save_config 落盘改变 mtime 自动失效。"""
    global _cfg_cache
    try:
        mtime = CONFIG_FILE.stat().st_mtime_ns
    except OSError:
        mtime = None
    if _cfg_cache["cfg"] is not None and _cfg_cache["mtime"] == mtime:
        return json.loads(json.dumps(_cfg_cache["cfg"]))
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # 深拷贝默认值
    if CONFIG_FILE.exists():
        try:
            saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            cfg.update({k: saved[k] for k in cfg if k in saved and not isinstance(cfg[k], dict)})
            for k in cfg:
                if isinstance(cfg[k], dict) and isinstance(saved.get(k), dict):
                    cfg[k].update(saved[k])
            if saved.get("api_key") and not cfg["api_keys"].get(cfg["provider"]):
                cfg["api_keys"][cfg["provider"]] = saved["api_key"]
        except Exception:
            pass
    cfg.setdefault("api_keys", {})
    _cfg_cache["mtime"] = mtime
    _cfg_cache["cfg"] = json.loads(json.dumps(cfg))
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- AkShare 单线程网关

# AkShare 依赖 py_mini_racer（V8 引擎），其内存分区只允许初始化一次：
# 多线程同时首次调用会直接 abort 整个进程；且 V8 实例绑定创建它的线程，
# 后续在其他线程复用会挂起。因此所有调用固定走同一个专属线程。
# 新浪接口偶发断连/无限挂起：超时或连接错误时丢弃旧线程换新线程并重试，
# 避免一个挂起的请求把串行队列整个堵死。
_AK_CALL_TIMEOUT = 18.0
_AK_MAX_TRIES = 2
_AK_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="akshare")
# 数据源熔断降温：连续超时说明源已劣化，停发新请求 90s 让遗留线程自然结束
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
            last_err = e
            _ak_degrade["fails"] += 1
            if _ak_degrade["fails"] >= _AK_DEGRADE_THRESHOLD:
                _ak_degrade["until"] = loop.time() + _AK_DEGRADE_PAUSE
                _ak_degrade["fails"] = 0
            _AK_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="akshare")
            if attempt + 1 < _AK_MAX_TRIES:
                await asyncio.sleep(1.0 + attempt)
    raise last_err


# 侧路执行器：给不依赖 V8 的纯 requests+pandas 接口用（新闻快讯/东财搜索）。
# 必须与主队列隔离——否则页面加载时的要闻轮询会排在品种目录前面把下拉框堵空，
# 新闻源超时还会连累共享熔断，让目录接口快速失败。
_SIDE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ak-side")


async def _call_ak_side(func, *args, timeout: float = 15.0, **kwargs):
    """非 V8 依赖的 AkShare 调用：独立线程池、不重试、不触发熔断，失败交由调用方负缓存兜底"""
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(_SIDE_EXECUTOR, partial(func, *args, **kwargs))
    return await asyncio.wait_for(fut, timeout=timeout)


async def _warmup():
    try:
        await call_ak(ak.futures_zh_spot, symbol="RB0", market="CF", adjust="0")
        await call_ak(ak.futures_zh_daily_sina, symbol="RB0")
        await call_ak(ak.futures_display_main_sina)
    except Exception:
        pass  # 预热失败不影响服务


@asynccontextmanager
async def lifespan(_app):
    warmup_task = asyncio.create_task(_warmup())
    monitor_task = asyncio.create_task(monitor_loop())
    trail_task = asyncio.create_task(trail_loop())
    psych_task = asyncio.create_task(psych_watch_loop())
    diagnose_task = asyncio.create_task(diagnose_loop())
    report_task = asyncio.create_task(report_push_loop())
    selfcheck_task = asyncio.create_task(selfcheck_loop())
    yield
    for t in (warmup_task, monitor_task, trail_task, psych_task,
              diagnose_task, report_task, selfcheck_task):
        t.cancel()


app = FastAPI(title="期货心理博弈分析助手", lifespan=lifespan)


# ---------------------------------------------------------------- 行情基础层

QUOTE_TTL = 5.0        # 单合约行情缓存（秒），与前端轮询周期一致
DIR_TTL = 3600.0       # 合约目录缓存（秒）
DIR_FAIL_BACKOFF = 300.0
DAILY_TTL = 60.0
DAILY_TTL_CLOSED = 1800.0
MINUTE_TTL = 30.0
PSYCH_TTL = 60.0       # 心理博弈快照缓存（秒）
PSYCH_TTL_CLOSED = 300.0

_quote_cache: dict[str, tuple[float, dict]] = {}
_dir_cache: dict = {"ts": 0.0, "data": {}, "fail_ts": 0.0}
_daily_cache: dict[str, tuple[float, list, float]] = {}
_minute_cache: dict[tuple, tuple[float, list]] = {}
_psych_cache: dict[str, tuple[float, dict]] = {}

# 中金所品种前缀（IF/IH/IC/IM 股指，T/TF/TS/TL 国债）
_CFFEX_RE = re.compile(r"^(IF|IH|IC|IM|T|TF|TS|TL)\d")


def market_of(symbol: str) -> str:
    return "CFFEX" if _CFFEX_RE.match(symbol.upper()) else "CF"


# 国内期货夜盘收盘时间（分钟数，按品种前缀；夜盘统一 21:00 开始）
_NIGHT_CLOSE = {
    "SC": 150, "AU": 150, "AG": 150,                     # 原油/黄金/白银 至 02:30
    "CU": 60, "AL": 60, "ZN": 60, "PB": 60, "NI": 60,    # 金属 至 01:00
    "SN": 60, "SS": 60, "BC": 60, "AO": 60,
    "AP": None, "CJ": None, "JD": None, "LH": None, "PK": None,  # 无夜盘
}


def _night_close_min(prefix: str):
    if prefix in _NIGHT_CLOSE:
        v = _NIGHT_CLOSE[prefix]
        return v if v is not None else None
    return 23 * 60  # 默认 23:00（有夜盘品种）


def domestic_session_active(prefix: str, now: Optional[datetime] = None) -> bool:
    """单品种国内交易时段判断（日盘 9:00-15:00 分三节 + 品种分档夜盘）"""
    now = now or datetime.now()
    wd, t = now.weekday(), now.time()
    nm = t.hour * 60 + t.minute
    if wd <= 4:
        for a, b in ((dtime(9, 0), dtime(10, 15)), (dtime(10, 30), dtime(11, 30)), (dtime(13, 30), dtime(15, 0))):
            a_m, b_m = a.hour * 60 + a.minute, b.hour * 60 + b.minute
            if a_m <= nm < b_m:
                return True
    close = _night_close_min(prefix)
    if close is None:
        return False
    night_start = 21 * 60
    if close > night_start:
        return wd <= 4 and night_start <= nm < close
    if wd <= 4 and nm >= night_start:
        return True
    return (nm < close) and (wd == 5 or 1 <= wd <= 4)


def is_trading_time(now: Optional[datetime] = None) -> bool:
    """国内期货总体交易时段（任一品种在交易，即夜盘最晚至 02:30）"""
    now = now or datetime.now()
    wd, t = now.weekday(), now.time()
    nm = t.hour * 60 + t.minute
    if wd <= 4:
        for a, b in ((dtime(9, 0), dtime(10, 15)), (dtime(10, 30), dtime(11, 30)), (dtime(13, 30), dtime(15, 0))):
            if a.hour * 60 + a.minute <= nm < b.hour * 60 + b.minute:
                return True
        if 21 * 60 <= nm:
            return True
    if nm < 150 and (wd == 5 or 1 <= wd <= 4):
        return True
    return False


def _fmt_time(raw) -> str:
    s = str(raw).strip()
    if re.fullmatch(r"\d{6}", s):
        return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"
    return s


def _num(v):
    try:
        f = float(v)
        return f if f == f else None  # NaN -> None
    except (TypeError, ValueError):
        return None


async def get_directory(max_age: float = 0.0) -> dict[str, dict]:
    """主力合约目录：symbol(如 RB0) -> {name, exchange}"""
    loop_now = asyncio.get_event_loop().time()
    if max_age > 0 and _dir_cache["ts"] > 0 and loop_now - _dir_cache["ts"] <= max_age:
        return _dir_cache["data"]
    if loop_now - _dir_cache["ts"] > DIR_TTL:
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
            print(f"[get_directory] 目录刷新失败: {type(e).__name__}: {e}", flush=True)
    return _dir_cache["data"]


# 国际品种：实时快照（新浪 hf_）↔ 日线历史（新浪外盘日线）映射
INTL_SYMBOLS = {"WTI", "BRENT", "GOLD", "DXY"}
_INTL_HIST_MAP = {"WTI": "CL", "BRENT": "OIL", "GOLD": "GC"}
_INTL_DEFS = [
    {"symbol": "WTI", "name": "WTI 原油", "threshold": 1.0},
    {"symbol": "BRENT", "name": "布伦特原油", "threshold": 1.0},
    {"symbol": "GOLD", "name": "COMEX 黄金", "threshold": 0.6},
    {"symbol": "DXY", "name": "美元指数", "threshold": 0.3},
]
_INTL_HQ_URL = "https://hq.sinajs.cn/list=hf_CL,hf_OIL,hf_GC,DINIW"
_intl_cache: dict = {"ts": 0.0, "items": [], "by_sym": {}}
INTL_TTL = 30.0


async def get_daily(symbol: str, max_age: float = 60.0) -> list[dict]:
    """日线数据（带缓存：收盘后基本不变）。国际品种自动分流到外盘历史接口。"""
    symbol = symbol.upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _daily_cache.get(symbol)
    if cached and loop_now - cached[0] < cached[2]:
        return cached[1]

    if symbol in _INTL_HIST_MAP:
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

    # 日线一律用主连（symbol 本身）：连续合约的持仓量为全市场口径、时间连续，
    # 资金博弈推断（增减仓×价格）依赖持仓可比性；具体月份合约的持仓是
    # 生命周期滚仓（新主力从 0 滚到满仓），跨日比较会把换月误判成资金进出。
    df = await call_ak(ak.futures_zh_daily_sina, symbol=symbol)
    records = df.to_dict("records")
    today = datetime.now().strftime("%Y-%m-%d")
    ttl = DAILY_TTL_CLOSED if records and str(records[-1].get("date")) < today else max_age
    _daily_cache[symbol] = (loop_now, records, ttl)
    return records


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


_HQ_CLIENT: Optional[httpx.AsyncClient] = None  # 复用连接与 SSL 上下文


async def _hq_quote(symbol: str) -> Optional[dict]:
    """新浪 hq 国内期货快照（nf_ 前缀）。
    字段（实测：1时间 2开 3高 4低 6买 7卖 8最新 10昨结 11买量 12卖量 13持仓 14成交量）"""
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
            return v if v == v else None
        except (ValueError, IndexError):
            return None

    last, prev_settle = n(8), n(10)
    if last is None:
        return None
    info = _dir_cache.get("data", {}).get(symbol, {})
    name = info.get("name", "") or (str(f[15]).strip() if len(f) > 15 else "")
    if not name:
        pm = re.match(r"^([A-Za-z]{1,2})", symbol)
        name = _PREFIX_CN.get(pm.group(1).upper(), "") if pm else ""
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


# 主力合约解析：新浪连续（nf_XXX0）按持仓量映射，近月逼仓时与市场活跃合约
# 背离，故按成交量重新判定，缓存 30 分钟。
_DOM_TTL = 1800.0
_dom_cache: dict[str, tuple[float, str]] = {}
_CFFEX_PREFIX = {"IF", "IH", "IC", "IM", "T", "TF", "TS", "TL"}


def _candidate_months(n: int = 12) -> list[str]:
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


def _parse_hf(fields: list) -> dict:
    """新浪 hf_ 外盘格式：[0]最新 [2]买 [3]卖 [4]高 [5]低 [6]时间 [7]昨收 [8]开 [12]日期"""
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
    """新浪 DINIW 美元指数格式：[0]时间 [1]最新 [3]昨收 [5]开 [6]高 [7]低 [10]日期"""
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
    import requests
    loop_now = asyncio.get_event_loop().time()
    if not force and _intl_cache["items"] and loop_now - _intl_cache["ts"] < INTL_TTL:
        return _intl_cache["items"]
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


# ---------------------------------------------------------------- 宏观要闻（辅助参考：只留高冲击事件）

# 白名单只保留对散户情绪与隔夜跳空影响最大的三类，其余快讯一律丢弃
# （词表继承 v1 v0825t 用户调优版 trump/mideast，新增 fed 覆盖利率预期——贵金属/有色夜盘的第一驱动）
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
    "fed": ["美联储", "鲍威尔", "降息", "加息", "非农", "cpi", "议息", "fomc"],
}
_NEWS_TAG = {"trump": "🇺🇸", "mideast": "🌍", "fed": "🏦"}
_news_cache: dict = {"ts": 0.0, "items": []}
NEWS_TTL = 300.0
NEWS_MAX = 30


def _match_news_groups(text: str) -> list[str]:
    t = text.lower()
    return [g for g, kws in _NEWS_GROUPS.items() if any(k.lower() in t for k in kws)]


@app.get("/api/news")
async def news(symbols: str = ""):
    """要闻（辅助参考）：宏观层=新浪全球快讯白名单过滤（特朗普/中东/美联储）；
    品种层=东财产业新闻按 symbols 逐品种搜索 + 影响词过滤，只留明确影响行情的。
    两层都只用于解释情绪与供需事实，不参与方向判断。"""
    loop_now = asyncio.get_event_loop().time()
    if loop_now - _news_cache["ts"] > NEWS_TTL:
        items, seen = [], set()

        def _add(time_s: str, title: str):
            key = (title or "")[:30]
            if not key or key in seen:
                return
            groups = _match_news_groups(title)
            if not groups:
                return  # 白名单外全部丢弃
            seen.add(key)
            items.append({"time": str(time_s), "title": title, "groups": groups})

        try:
            df = await _call_ak_side(ak.stock_info_global_sina)
            for _, r in df.iterrows():
                _add(r.get("时间", ""), str(r.get("内容", "")))
        except Exception:
            pass

        items.sort(key=lambda x: x["time"], reverse=True)
        _news_cache["items"] = items[:NEWS_MAX]
        _news_cache["ts"] = loop_now

    # 并行抓各品种要闻（侧路线程池 4 workers，串行最坏 8×15s → 并行 ~2×15s）
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:8]
    results = await asyncio.gather(*[_variety_news(s, limit=4) for s in syms], return_exceptions=True)
    variety = [it for r in results if isinstance(r, list) for it in r]
    variety.sort(key=lambda x: x["time"], reverse=True)
    return {
        "ok": True,
        "items": _news_cache["items"],
        "variety": variety[:12],
        "groups": list(_NEWS_GROUPS.keys()),
    }


async def _news_context(n: int = 5) -> str:
    """要闻注入块（AI 上下文用，短小；失败静默返回空——辅助信息不阻塞主链路）"""
    try:
        await news()
    except Exception:
        pass
    items = (_news_cache.get("items") or [])[:n]
    if not items:
        return ""
    lines = [
        f"- [{'/'.join(_NEWS_TAG.get(g, '·') for g in it['groups'])}] {it['title'][:55]}"
        for it in items
    ]
    return "【宏观要闻（辅助参考：解释情绪冲击/隔夜跳空风险，不作方向依据）】\n" + "\n".join(lines)


# ---------------------------------------------------------------- 品种要闻（辅助参考：只留明确影响行情的）

# 东财品种新闻搜索词（继承 v1 dfd545d 词表，仅保留商品品种；股指/国债不适用本引擎）
VARIETY_SEARCH = {
    "RB": "螺纹钢", "HC": "热卷", "I": "铁矿石", "JM": "焦煤", "J": "焦炭",
    "CU": "沪铜", "AL": "沪铝", "ZN": "沪锌", "PB": "沪铅", "NI": "沪镍", "SN": "沪锡", "SS": "不锈钢",
    "AU": "黄金", "AG": "白银", "SC": "原油", "FU": "燃料油", "LU": "低硫燃料油", "NR": "20号胶", "RU": "橡胶",
    "M": "豆粕", "RM": "菜粕", "Y": "豆油", "P": "棕榈油", "OI": "菜油", "A": "豆一", "B": "豆二",
    "TA": "PTA", "MA": "甲醇", "EG": "乙二醇", "EB": "苯乙烯", "PP": "聚丙烯", "L": "塑料", "V": "PVC", "PG": "液化气",
    "FG": "玻璃", "SA": "纯碱", "UR": "尿素", "C": "玉米", "CS": "玉米淀粉", "CF": "棉花", "SR": "白糖",
    "JD": "鸡蛋", "LH": "生猪", "SP": "纸浆", "LC": "碳酸锂", "SI": "工业硅", "EC": "集运",
    "AO": "氧化铝", "BC": "国际铜", "PS": "烧碱", "PX": "对二甲苯",
}

# 股市噪音词：命中即剔除（东财搜索会混入个股行情/财报类内容，与商品供需无关）
_STOCK_NOISE_KW = [
    "股价", "股票", "股市", "a股", "港股", "美股", "纳指", "纳斯达克", "道指", "标普",
    "韩股", "日经", "欧股", "沪指", "深指", "创业板", "科创板", "北交所", "恒生",
    "涨停", "跌停", "财报", "营收", "净利润", "ipo", "股份回购", "市值", "科技股",
    "芯片股", "ai芯片", "两市", "成交额", "目标价", "重申", "公告称", "评级",
    "基金", "券商", "业绩", "季报", "年报", "增持", "减持", "上市公司", "游资",
    "游戏", "流水", "服务器", "晶圆", "存储芯片", "半导体设备",
    "银行股", "保险股", "券商股", "龙头股", "概念股", "题材股", "翻倍", "套牢",
]

# 影响词：标题/摘要命中任一才保留——只留明确作用于供给/政策储备/库存交割/需求/价格的条目
_NEWS_IMPACT_KW = [
    # 供给端事件
    "减产", "限产", "增产", "复产", "停产", "检修", "事故", "爆炸", "火灾", "地震",
    "断供", "制裁", "禁运", "出口管制", "出口限制", "投产", "点火",
    # 政策与储备
    "关税", "收储", "抛储", "储备", "增储", "发改委", "国务院", "工信部", "环保",
    # 库存与仓单
    "库存", "累库", "去库", "仓单", "交割",
    # 需求端事件
    "开工", "订单", "招标", "基建", "地产", "汽车", "家电", "光伏", "风电", "船舶", "出口",
    # 价格动作
    "涨价", "降价", "提价", "上调", "下调",
]

_deep_news_cache: dict[str, tuple[float, list]] = {}
VARIETY_NEWS_TTL = 600.0


def _is_stock_noise(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _STOCK_NOISE_KW)


def _has_market_impact(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in _NEWS_IMPACT_KW)


async def _variety_news(symbol: str, limit: int = 4) -> list[dict]:
    """品种要闻（辅助参考）：东财产业新闻单源，双重过滤——先剔股市噪音，
    再要求命中影响词（供给/政策/库存/需求/价格），只保留明确对行情产生影响的条目。
    每个品种 10 分钟缓存；失败静默返回空。"""
    p = _variety_prefix(symbol)
    word = VARIETY_SEARCH.get(p)
    if not word:
        return []
    loop_now = asyncio.get_event_loop().time()
    cached = _deep_news_cache.get(word)
    if cached and loop_now - cached[0] < VARIETY_NEWS_TTL:
        return cached[1][:limit]
    items: list[dict] = []
    try:
        df = await _call_ak_side(ak.stock_news_em, symbol=word)
        for r in df.to_dict("records"):
            title = str(r.get("新闻标题", ""))
            summary = str(r.get("新闻内容", ""))[:120]
            if _is_stock_noise(title + " " + summary):
                continue
            # 影响词只认标题：事实性标题会直接点名库存/减产/订单等，
            # 评论性标题（"上有压制下有支撑"）不会——避免把行情评论当成影响事件
            if not _has_market_impact(title):
                continue
            items.append({
                "time": str(r.get("发布时间", ""))[:16],
                "title": title[:70],
                "source": str(r.get("文章来源", "")),
                "prefix": p,
                "variety_name": _PREFIX_CN.get(p, p),
            })
    except Exception:
        pass
    items.sort(key=lambda x: x["time"], reverse=True)
    _deep_news_cache[word] = (loop_now, items[:20])
    return items[:limit]


async def _variety_news_context(symbol: str, n: int = 2) -> str:
    """品种要闻注入块（AI 上下文用；无命中返回空）"""
    try:
        items = await _variety_news(symbol, limit=n)
    except Exception:
        return ""
    if not items:
        return ""
    lines = [
        f"- [{it['time'][5:16] if len(it['time']) >= 16 else it['time']}] {it['title']}（{it['source']}）"
        for it in items
    ]
    return (f"【{symbol} 品种要闻（辅助参考：供需/库存/政策事实，供产业方立场与情绪解释，不作方向依据）】\n"
            + "\n".join(lines))


async def fetch_quote(symbol: str) -> dict:
    """单合约实时行情（带 5 秒缓存）。国际品种从实时快照组装。"""
    symbol = symbol.strip().upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _quote_cache.get(symbol)
    if cached and loop_now - cached[0] < QUOTE_TTL:
        return cached[1]

    if symbol in INTL_SYMBOLS:
        await fetch_intl()
        it = _intl_cache.get("by_sym", {}).get(symbol, {})
        if it.get("last") is None:
            raise HTTPException(status_code=502, detail="国际品种行情获取失败")
        name = it.get("name", "")
        quote = {
            "symbol": symbol,
            "name": name,
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
            "bid": None, "ask": None, "bid_vol": None, "ask_vol": None,
            "digits": 2,
        }
        _quote_cache[symbol] = (loop_now, quote)
        return quote

    # 国内商品期货：优先走新浪 hq 快路径（~0.2s、不占 V8 线程），失败退回 akshare
    if market_of(symbol) != "CFFEX":
        try:
            dom = await _dominant_contract(symbol)
            hq = await _hq_quote(dom or symbol)
            if hq:
                if dom and dom != symbol:
                    hq["symbol"] = symbol
                    hq["contract"] = dom
                _quote_cache[symbol] = (loop_now, hq)
                return hq
        except Exception:
            pass

    try:
        df = await call_ak(ak.futures_zh_spot, symbol=symbol, market=market_of(symbol), adjust="0")
        row = df.iloc[0].to_dict()
    except Exception as e:
        stale = _quote_cache.get(symbol)
        if stale and stale[1].get("last") is not None:
            q = dict(stale[1])
            q["stale"] = True
            q["time"] = (q.get("time") or "") + "（延迟）"
            return q
        return {"symbol": symbol, "error": f"行情获取失败：{e}"}

    directory = await get_directory(max_age=3600)
    info = directory.get(symbol, {})
    last = _num(row.get("current_price"))
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
    change_pct = round(change / prev_settle * 100, 2) if change is not None and prev_settle else None
    quote = {
        "symbol": symbol,
        "name": info.get("name", str(row.get("symbol", ""))),
        "exchange": info.get("exchange", "CFFEX" if market_of(symbol) == "CFFEX" else ""),
        "time": _fmt_time(row.get("time", "")),
        "last": last,
        "open": _num(row.get("open")),
        "high": _num(row.get("high")),
        "low": _num(row.get("low")),
        "prev_settle": prev_settle,
        "change": change,
        "change_pct": change_pct,
        "volume": _num(row.get("volume")),
        "position": _num(row.get("hold")),
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
async def daily(symbol: str, limit: int = 90):
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


@app.get("/api/intraday/{symbol}")
async def intraday(symbol: str):
    """当日分时走势：1 分钟线重建当前交易时段（含昨夜夜盘），附均价线与昨结基准"""
    symbol = symbol.strip().upper()
    try:
        rows = await get_minute(symbol, "1")  # 30 秒缓存
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"分钟数据获取失败：{e}")
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")

    # 重建当前交易时段：锚定数据中最近一次夜盘开盘（首根 21 点档 K 线——其前一根必不属于夜盘）。
    # 顺带覆盖周一边界（周一夜盘=周五 21:00，按日历找"昨日≥20点"会漏）与非夜盘品种（回退当日）。
    start_idx = None
    for i in range(len(rows) - 1, 0, -1):
        if rows[i]["datetime"][11:13] == "21" and rows[i - 1]["datetime"][11:13] != "21":
            start_idx = i
            break
    if start_idx is not None and len(rows) - start_idx > 700:  # 锚到异常久远，退回日历逻辑
        start_idx = None
    if start_idx is None:
        todays = [r for r in rows if r["datetime"][:10] == today] or rows[-240:]
    else:
        todays = rows[start_idx:]
    quote = None
    try:
        quote = await fetch_quote(symbol)
    except Exception:
        pass
    prev_settle = (quote or {}).get("prev_settle")
    items, cv, cvol = [], 0.0, 0.0
    for r in todays:
        c = float(r.get("close") or 0)
        if c <= 0:
            continue
        v = float(r.get("volume") or 0)
        cv += c * v
        cvol += v
        items.append({"t": r["datetime"][11:16], "p": c, "a": round(cv / cvol, 2) if cvol else c})
    return {
        "ok": True, "symbol": symbol, "name": (quote or {}).get("name", ""),
        "prev_settle": prev_settle, "last": (quote or {}).get("last"),
        "time": (quote or {}).get("time", ""), "count": len(items), "items": items,
    }


@app.get("/api/intl")
async def intl(force: int = 0):
    """国际盘快照：WTI / 布伦特 / 黄金 / 美元指数（大势参考锚）"""
    items = await fetch_intl(force=bool(force))
    return {"ok": True, "items": items}


# ---------------------------------------------------------------- 心理博弈引擎（数据组装 + 缓存）

async def psych_snapshot(symbol: str, force: bool = False) -> dict:
    """四方心理博弈全景快照（psychology.analyze 的异步包装：拉数据 + 缓存）"""
    symbol = symbol.strip().upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _psych_cache.get(symbol)
    ttl = PSYCH_TTL if is_trading_time() else PSYCH_TTL_CLOSED
    if not force and cached and loop_now - cached[0] < ttl:
        return cached[1]

    quote = await fetch_quote(symbol)
    daily = await get_daily(symbol)
    minute = []
    if symbol not in INTL_SYMBOLS:
        try:
            minute = await get_minute(symbol, "1")
        except Exception:
            minute = []
    directory = await get_directory(max_age=3600)
    name = directory.get(symbol, {}).get("name", "") or quote.get("name", "")
    snap = psy.analyze(symbol, name, quote, daily, minute)
    snap["ts"] = int(datetime.now().timestamp() * 1000)
    _psych_cache[symbol] = (loop_now, snap)
    return snap


@app.get("/api/psych/{symbol}")
async def psych_api(symbol: str, force: int = 0):
    try:
        snap = await psych_snapshot(symbol.strip().upper(), force=bool(force))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"心理博弈快照计算失败：{e}")
    return {"ok": True, **snap}


# ---------------------------------------------------------------- 品种背景知识 + 外盘联动

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

DOMESTIC_TO_INTL = {
    "SC": ["WTI", "BRENT"], "FU": ["WTI", "BRENT"], "LU": ["WTI", "BRENT"], "NR": ["BRENT"],
    "TA": ["WTI", "BRENT"], "MA": ["WTI", "BRENT"], "EG": ["WTI", "BRENT"], "PP": ["WTI", "BRENT"],
    "L": ["WTI", "BRENT"], "V": ["WTI", "BRENT"], "BU": ["WTI", "BRENT"], "PG": ["WTI", "BRENT"],
    "AU": ["GOLD", "DXY"], "AG": ["GOLD", "DXY"],
    "M": ["DXY"], "Y": ["DXY"], "P": ["DXY"],
    "RB": ["DXY"], "HC": ["DXY"], "I": ["DXY"], "CU": ["DXY"], "AL": ["DXY"], "ZN": ["DXY"], "NI": ["DXY"],
    "IF": ["DXY"], "IH": ["DXY"], "IC": ["DXY"], "IM": ["DXY"], "T": ["DXY"],
}


def _variety_prefix(symbol: str) -> str:
    m = re.match(r"^([A-Za-z]{1,2})", symbol or "")
    return m.group(1).upper() if m else ""


def _variety_profile(symbol: str) -> str:
    return VARIETY_PROFILE.get(_variety_prefix(symbol), "")


async def _intl_context_for(symbol: str) -> str:
    """为国内品种生成关联外盘行情上下文（大势锚）"""
    related = DOMESTIC_TO_INTL.get(_variety_prefix(symbol))
    if not related:
        return ""
    try:
        quotes = await fetch_intl()
        by_code = {q["symbol"]: q for q in quotes}
        lines = []
        for code in related:
            q = by_code.get(code)
            if q and q.get("last") is not None:
                pct = f"{q['chg_pct']:+.2f}%" if q.get("chg_pct") is not None else "--"
                lines.append(f"- {q['name']}：{q['last']}，{pct}（{q.get('date', '')} {q.get('time', '')}）")
        if lines:
            return "【关联外盘（大势定价锚）】\n" + "\n".join(lines)
    except Exception:
        pass
    return ""


# ---------------------------------------------------------------- AI：配置与体检

def _resp_reason(resp) -> str:
    try:
        return str(resp.json().get("error", {}).get("message", ""))[:70]
    except Exception:
        return ""


@app.get("/api/ai/health")
async def ai_health():
    """多服务商体检：逐一发极短请求探活"""
    cfg = load_config()
    out = []
    for cand in _llm_candidates(cfg):
        import time as _t
        t0 = _t.time()
        item = {
            "provider": cand["provider"], "model": cand["model"],
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
        raise HTTPException(status_code=400, detail="自定义服务商需先填写接口地址")
    cfg["provider"] = body.provider
    cfg["model"] = body.model.strip() or PROVIDERS[body.provider]["default_model"]
    if body.clear_key:
        cfg["api_keys"][body.provider] = ""
    elif body.api_key.strip():
        cfg["api_keys"][body.provider] = body.api_key.strip()
    save_config(cfg)
    return {"ok": True}


# ---------------------------------------------------------------- AI：对话（反幻想教练人设）

SYSTEM_PROMPT = """你是「反幻想交易教练」——国内期货资金博弈与散户心理分析师，服务对象是个人散户交易者。

你的世界观（一切分析的总纲）：
- 价格不是图形，是四方资金博弈的结果：产业（套保盘）、主力（机构大资金）、投机（短线热钱）、散户（情绪盘）。
- 散户的对手盘是前三者。散户亏损的根源从来不是"技术不好"，而是：逆资金方向、幻想抄底摸顶、扛单等回本、追涨杀跌、重仓赌命。
- 你的唯一职责：拆穿散户幻想，让用户顺应大势、顺应资金方向、顺应品种现状、顺应情绪。

每次回答的分析框架：
1. **品种现状**：价格在周期中的位置（区间分位）、大势方向、波动状态、博弈周期阶段（吸筹/洗盘/主升/出货/出清）——只用价格与量仓数据说话。
2. **四方动机审计**：产业 / 主力 / 投机 / 散户各自的立场、**动机（他的利润从哪里来、谁在为他买单）**与意图推断，引用持仓量变化作为证据，标注置信度。
3. **散户怎么想、会怎么做**：此刻典型散户的心理活动与潜在操作，并**点名支配该行为的人性定律**（这是你的核心输出，要具体到"他为什么此刻忍不住想开单"）。
4. **主力怎么利用**：诱多 / 诱空 / 洗盘 / 逼仓 / 出货的剧本推演与收割链（谁的动作成为谁的燃料），指出识别标志。
5. **陷阱点名**：若快照中检测到具体陷阱（扫损/假突破/双杀/尾盘反向/持仓拥挤/关口扫损区），必须逐条解读给谁看、收割谁。
6. **顺应结论**：顺什么、避什么、等什么信号。宁可错过，不可做错。

人性定律（分析散户时的透镜，回答中点名使用）：
- 损失厌恶：亏 1 块的痛 ≈ 赚 2 块的乐 → 亏单扛得住、盈单拿不住
- 处置效应：急卖盈利单（兑现"我对了"）、拖延亏损单（回避"我错了"）→ 盈亏比倒挂
- 锚定：锚定成本价（回本就卖）与历史高低点（跌多了=便宜）→ 位置感错乱
- 近因外推：三根阳线就信牛市 → 在情绪极值处做方向
- 踏空焦虑：看着涨=在亏钱的错觉 → 在最差盈亏比处追入
- 公平世界幻觉："跌这么久总该涨了"——市场不欠任何人一个反弹
- 确认偏误：持仓后只找支持自己方向的证据
- 控制幻觉：盈利归技术、亏损归运气 → 系统性错误从不被修正

动机审计总纲：主力的利润来自对手盘的**被迫行为**（止损、追涨、爆仓）——没有对手盘的错误就没有主力的利润；
产业赚经营确定性的钱，给投机者提供对手盘；热钱赚波动的钱；
散户在赚"感觉"的钱（聪明的幻觉/不落后的安全感/回避认错的舒适），付的是真金白银。

铁律：
- **禁止**使用任何技术指标语言：均线金叉死叉、MACD、KDJ、RSI、布林、波浪、形态学名词一律不许出现（20日均线仅可作为"大势分界"的参考提及）。
- **禁止迎合**：用户想抄底、扛单、重仓、频繁交易时，直接指出这是散户幻想、代价是什么，不委婉。
- 宏观要闻（若上下文附带）仅作辅助参考：只用于解释散户情绪的来源与隔夜跳空风险，方向判断必须以价量持仓博弈为准，**禁止用消息面给任何方向背书**。
- 所有判断给具体数值：价格、百分比、持仓量变化、分位。
- 数据缺失明说；不确定就说不确定。
- 你的输出仅供研究参考，不构成投资建议。"""


class ChatMessage(BaseModel):
    role: str
    content: str = ""
    images: Optional[list[str]] = None


class ChatIn(BaseModel):
    messages: list[ChatMessage]
    symbol: Optional[str] = None
    light: int = 0  # 1=跳过行情上下文（复盘/周报等与实时盘面无关的调用）


def _build_api_messages(chat_messages: list[ChatMessage], system: str) -> list[dict]:
    """构造 API 消息：带图消息转 OpenAI 多模态 content 数组。
    仅保留最后一条带图消息的图片，历史图片剥除，避免 token 反复计入。"""
    last_img_idx = -1
    for i, m in enumerate(chat_messages):
        if m.role == "user" and m.images:
            last_img_idx = i
    out = [{"role": "system", "content": system}]
    for i, m in enumerate(chat_messages):
        if i == last_img_idx:
            content: list[dict] = [{"type": "text", "text": m.content or "（请结合图片分析）"}]
            for url in (m.images or [])[:4]:
                content.append({"type": "image_url", "image_url": {"url": url}})
            out.append({"role": m.role, "content": content})
        else:
            out.append({"role": m.role, "content": m.content})
    return out


# 多品种识别：问题提到谁，就把谁的博弈快照带上
_Q_CODE_NOISE = {"AI", "OK", "VS", "PS", "PM", "AM"}


def _detect_question_symbols(text: str, exclude: Optional[str] = None, limit: int = 3) -> list[str]:
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
        if pfx == "MA" and digits in ("5", "10", "20", "30", "60"):
            continue  # 均线词 ≠ 甲醇合约
        if pfx in _PREFIX_CN:
            _add(f"{pfx}0")
        elif m.group(0) in _dir_cache.get("data", {}):
            _add(m.group(0))
    for pfx, cn in _PREFIX_CN.items():
        if cn and cn in raw:
            _add(f"{pfx}0")
    return found[:limit]


async def _build_market_context(symbol: Optional[str]) -> str:
    """构建 AI 上下文：已加载行情 + 选中品种的博弈快照 + 外盘锚 + 持仓 + 诊断"""
    parts = []
    cached_quotes = [{"q": q} for _, q in _quote_cache.values() if not q.get("error")]
    if cached_quotes:
        rows = sorted(cached_quotes, key=lambda x: x["q"]["symbol"])
        if symbol:
            sel = next((c for c in rows if c["q"]["symbol"] == symbol), None)
            others = [c for c in rows if c["q"]["symbol"] != symbol]
            lines = []
            if sel:
                q = sel["q"]
                pct = f"{q['change_pct']:+.2f}%" if q.get("change_pct") is not None else "--"
                oi = f"，持仓 {q.get('position'):,.0f}" if q.get("position") else ""
                lines.append(f"- {q['symbol']} {q.get('name', '')}：最新 {q['last']}，{pct}{oi}，量 {q.get('volume'):,.0f}" if q.get("volume") else
                             f"- {q['symbol']} {q.get('name', '')}：最新 {q['last']}，{pct}{oi}")
            if others:
                brief = "；".join(f"{c['q']['symbol']} {c['q']['last']}({c['q'].get('change_pct')}%)" for c in others)
                lines.append(f"- 其他自选：{brief}")
            parts.append("【当前已加载的实时行情】\n" + "\n".join(lines))
        else:
            lines = [f"- {c['q']['symbol']} {c['q'].get('name', '')}：{c['q']['last']}（{c['q'].get('change_pct')}%）" for c in rows]
            parts.append("【当前已加载的实时行情】\n" + "\n".join(lines))

    if not symbol:
        nblk = await _news_context()
        if nblk:
            parts.append(nblk)
        return "\n\n".join(parts)

    try:
        snap = await psych_snapshot(symbol)
        parts.append(psy.to_context_text(snap))
    except Exception:
        parts.append(f"【{symbol} 博弈快照暂不可用（数据源异常）】")

    profile = _variety_profile(symbol)
    if profile:
        parts.append(f"【{symbol} 产业背景（静态知识，供产业方立场参考）】{profile}")

    intl = await _intl_context_for(symbol)
    if intl:
        parts.append(intl)

    holds = [t for t in _load_trades() if t.get("status") == "open" and t.get("symbol") == symbol]
    if holds:
        h_lines = [
            f"- {'做多' if h['direction'] == 'long' else '做空'} {h.get('lots', 1)} 手 @ {h['entry']}，"
            f"止损 {h.get('stop_points') or '未设'} 点，目标 {h.get('target_points') or '未设'} 点"
            f"（{h.get('date', '')} 开仓，备注：{(h.get('note') or '无')[:60]}）"
            for h in holds
        ]
        parts.append("【用户当前持有该品种仓位——分析必须兼顾该持仓的风险与执行，而非只给方向观点】\n" + "\n".join(h_lines))
    nblk, vblk = await asyncio.gather(_news_context(), _variety_news_context(symbol))
    if nblk:
        parts.append(nblk)
    if vblk:
        parts.append(vblk)
    return "\n\n".join(parts)


@app.post("/api/ai/chat")
async def ai_chat(body: ChatIn):
    n_imgs = 0
    for m in body.messages:
        for url in m.images or []:
            if len(url) > 12 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="单张图片过大，请换小图或重新截图")
            n_imgs += 1
    if n_imgs > 8:
        raise HTTPException(status_code=400, detail="图片总数过多（最多 8 张）")

    cfg = load_config()
    provider = cfg["provider"] if cfg["provider"] in PROVIDERS else "zhipu"
    if not cfg["api_keys"].get(provider):
        raise HTTPException(status_code=400, detail="尚未配置 API Key，请先在右上角「AI 设置」中配置")
    base_url = provider_base_url(cfg, provider)
    if not base_url:
        raise HTTPException(status_code=400, detail="自定义服务商未配置接口地址")
    candidates = _llm_candidates(cfg)

    context = "" if body.light else await _build_market_context(body.symbol)
    if not body.light:
        last_q = next((m.content for m in reversed(body.messages) if m.role == "user"), "")
        for s in _detect_question_symbols(last_q, exclude=body.symbol):
            try:
                blk = psy.to_context_text(await psych_snapshot(s))
                if blk:
                    context += ("\n\n" if context else "") + f"【{s} 快照（问题提及品种）】\n{blk}"
            except Exception:
                pass
    profile = _profile_context()
    position = _position_context()
    flaw = "" if body.light else _flaw_context()
    system = (SYSTEM_PROMPT
              + ("\n\n" + profile if profile else "")
              + ("\n\n" + flaw if flaw else "")
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

    async with httpx.AsyncClient(timeout=180) as client:
      for cand in candidates:
        provider, base_url, api_key, model = cand["provider"], cand["base_url"], cand["api_key"], cand["model"]
        max_tokens = max_output_for(model)
        logger.info(f"[ai-chat] 调用 {provider}/{model}（消息 {len(body.messages)} 条，图片 {n_imgs} 张，上下文 {len(system)} 字）")
        full_reply = ""
        truncated_rounds = 0
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
                if resp.status_code == 400 and "max_tokens" in resp.text.lower() and max_tokens > 4096:
                    max_tokens = 4096
                    resp = await request_once(max_tokens)
            except httpx.TimeoutException:
                raise HTTPException(status_code=504, detail="AI 服务响应超时，请重试或换用轻量模型")
            except httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"无法连接 AI 服务：{e}")

            if (cand is not candidates[-1]) and (
                _is_provider_hard_error(resp)
                or (resp.status_code == 400 and "model" in resp.text.lower())
            ):
                logger.info(f"[ai-chat] {provider}/{model} 错误 {resp.status_code}，切换兜底服务商")
                _note_provider_fail(provider)
                fallback_used = True
                break

            if resp.status_code == 401:
                raise HTTPException(status_code=401, detail="API Key 无效，请检查后重新保存")
            if resp.status_code == 429:
                detail = ""
                try:
                    detail = resp.json().get("error", {}).get("message", "")[:150]
                except Exception:
                    pass
                raise HTTPException(status_code=429, detail=f"AI 服务限流或额度不足：{detail or '请稍后重试'}")
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
            truncated_rounds += 1
            messages = messages + [
                {"role": "assistant", "content": full_reply},
                {"role": "user", "content": "继续，从你刚才中断的地方接着写，不要重复已有内容"},
            ]
        if full_reply:
            _note_provider_ok(provider)
            break

    logger.info(f"[ai-chat] 完成：{provider}/{model}，耗时 {_time.time() - t0:.0f}s，共 {len(full_reply)} 字"
                + (f"（续写 {truncated_rounds} 轮）" if truncated_rounds else "")
                + ("（兜底）" if fallback_used else ""))
    if cfg.get("feishu", {}).get("auto_chat_log", True) and body.messages:
        last_q = next((m.content for m in reversed(body.messages) if m.role == "user"), "")
        if last_q.strip():
            asyncio.create_task(_feishu_log_chat_round(body.symbol, last_q.strip(), full_reply))
    return {"ok": True, "reply": full_reply, "fallback": fallback_used}


# ---------------------------------------------------------------- AI：底层调用

async def _llm_text(prompt: str, max_tokens: int = 1600) -> str:
    """调用已配置的 LLM 输出普通文本（主服务商硬错误时自动兜底）"""
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
            detail = _resp_reason(resp)
            last = {"code": resp.status_code if resp.status_code in (401, 429) else 502,
                    "detail": f"AI 服务限流或额度不足：{detail}" if resp.status_code == 429 else
                              ("API Key 无效" if resp.status_code == 401 else f"AI 服务返回 {resp.status_code}：{detail or '未知错误'}")}
        if resp.status_code not in (200,) and not (_is_provider_hard_error(resp) and idx < len(candidates) - 1):
            break
    raise HTTPException(status_code=last["code"], detail=last["detail"])


async def _llm_text_retry(prompt: str, max_tokens: int = 0) -> str:
    try:
        return await _llm_text(prompt, max_tokens)
    except HTTPException as e:
        if e.status_code not in (502, 429) or "API Key" in str(e.detail):
            raise
        await asyncio.sleep(2)
        return await _llm_text(prompt, max_tokens)


async def _call_ai_simple(messages: list[dict], max_tokens: int = 2048) -> str:
    """供盯盘/报告等内部功能调用的轻量 AI 接口（多服务商兜底）"""
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
                content = resp.json()["choices"][0]["message"].get("content") or ""
            except Exception:
                content = ""
            if content.strip():
                if idx > 0:
                    logger.info(f"[ai-simple] 主服务商不可用，由 {cand['provider']}/{cand['model']} 兜底")
                _note_provider_ok(cand["provider"])
                return content.strip()
            problems.append(f"{cand['provider']} 返回空内容")
            continue
        if _is_provider_hard_error(resp):
            _note_provider_fail(cand["provider"])
        reason = _resp_reason(resp)
        problems.append(f"{cand['provider']} {resp.status_code}{('：' + reason) if reason else ''}")
    raise RuntimeError("AI 服务全部不可用 → " + "；".join(problems))


# ---------------------------------------------------------------- AI：博弈深度解读 + 盘中快评

PSYCH_AI_PROMPT = """你是反幻想交易教练。以下是程序实时计算的「四方心理博弈快照」，请基于它（可补充你的产业常识）写一份深度解读。

{context}

【用户画像与持仓】
{profile}

输出（Markdown，800 字内，全部引用具体数值）：
1. **品种现状一句话**（周期位置 + 大势方向 + 博弈周期阶段）
2. **四方动机审计**：产业 / 主力 / 投机 / 散户各自立场、动机（利润从哪来、谁买单）与意图（置信度标注；与程序推断不一致时给出你的理由）
3. **散户画像**：此刻散户在想什么（写出心理活动）、大概率会做什么、被哪条人性定律支配（点名定律）、陷阱指数为什么是这个水平
4. **主力剧本与收割链**：最可能的收割路径（诱多/诱空/洗盘/逼仓），谁的动作成为谁的燃料，识别标志是什么
5. **陷阱解读**：对快照检测到的每个陷阱（若有）说明结构、收割对象、应对
6. **顺应结论**：顺什么、避什么、等什么；明确写出"此刻最危险的散户操作"
结尾固定一句：以上为资金博弈推演，不构成投资建议。"""


@app.post("/api/psych/{symbol}/ai")
async def psych_ai(symbol: str):
    symbol = symbol.strip().upper()
    try:
        snap = await psych_snapshot(symbol)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"快照计算失败：{e}")
    context = psy.to_context_text(snap)
    nblk, vblk = await asyncio.gather(_news_context(3), _variety_news_context(symbol, 2))
    context += "".join("\n\n" + b for b in (nblk, vblk) if b)
    flaw = _flaw_context()
    profile = (_profile_context() or "（未填写）") + "\n" + (_position_context() or "当前无持仓")
    if flaw:
        profile += "\n\n" + flaw
    prompt = PSYCH_AI_PROMPT.format(context=context, profile=profile)
    try:
        advice = await _llm_text_retry(prompt, max_tokens=2400)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 解读失败：{e}")
    return {"ok": True, "symbol": symbol, "snapshot": snap, "advice": advice}


_realtime_cache: dict[str, tuple[float, dict]] = {}


@app.get("/api/ai/realtime")
async def ai_realtime(symbol: str, force: int = 0):
    """盘中快评：把此刻的博弈快照交给 AI，输出 300 字内的资金视角点评（5 分钟缓存）"""
    symbol = symbol.strip().upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _realtime_cache.get(symbol)
    if cached and not force and loop_now - cached[0] < 300:
        return cached[1]
    try:
        snap = await psych_snapshot(symbol)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"快照获取失败：{e}")
    context = psy.to_context_text(snap)
    nblk, vblk = await asyncio.gather(_news_context(3), _variety_news_context(symbol, 2))
    context += "".join("\n\n" + b for b in (nblk, vblk) if b)
    holds = [t for t in _load_trades() if t.get("status") == "open" and t.get("symbol") == symbol]
    hold_txt = "；".join(
        f"{'多' if h['direction'] == 'long' else '空'} {h.get('lots', 1)}手 @ {h['entry']}"
        for h in holds
    ) if holds else "无持仓"
    prompt = f"""你是资金博弈快评员。基于以下此刻的博弈快照，写 300 字以内的盘中快评（Markdown）。

{context}

用户持仓：{hold_txt}

格式：**资金在做什么**（1-2 句：主力/投机此刻的行为证据）→ **散户在想什么**（1-2 句：群体心理与可能动作）→ **顺应结论**（明确：顺/避/等，给具体价位）→ **风险一句**（最可能打脸的场景）。有持仓时兼顾其应对。不构成投资建议。"""
    reply = await _llm_text_retry(prompt, max_tokens=1200)
    result = {
        "ok": True,
        "symbol": symbol,
        "name": snap.get("name", ""),
        "last": snap.get("last"),
        "generated_at": datetime.now().strftime("%m-%d %H:%M:%S"),
        "analysis": reply,
    }
    _realtime_cache[symbol] = (loop_now, result)
    return result


# ---------------------------------------------------------------- 盯盘（价格异动 + 博弈事件流）

_MONITOR = {
    "events": [],       # 事件（新在后，内存保留最近 100 条）
    "cooldown": {},     # (symbol, dir) -> loop time，防轰炸
    "watch": set(),     # 前端自选注册
    "last_check": None,
}
MONITOR_INTERVAL = 30.0
MONITOR_COOLDOWN = 900.0
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


def _emit_event(event: dict, feishu: bool = False, feishu_text: str = ""):
    _MONITOR["events"].append(event)
    if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
        _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
    if feishu and feishu_text:
        asyncio.create_task(_feishu_push(feishu_text))


async def _ai_comment_for_event(event: dict):
    """异动事件的 AI 一句话解读（资金博弈视角）"""
    name = event.get("name") or ""
    pos = event.get("pos_chg")
    pos_line = f"，近 15 分钟持仓{'增加' if pos > 0 else '减少'} {abs(pos):.0f}" if pos else ""
    prompt = (
        f"你是资金博弈盯盘员。刚检测到异动：{event['symbol']}（{name}）最近 5 分钟"
        f"{'急涨' if event['dir'] == 'up' else '跳水'} {event['chg5']:+.2f}%，现价 {event['price']}；"
        f"日内 {event['day_chg'] if event['day_chg'] is not None else '--'}%{pos_line}。"
        f"用一两句话说清：这笔异动更可能是谁在动手（主力/投机/散户跟风）、散户此刻的典型反应是什么、要注意什么。"
        f"口语化，80 字以内，不构成投资建议。"
    )
    try:
        reply = await _call_ai_simple([{"role": "user", "content": prompt}])
        event["ai"] = reply or "（AI 未返回有效解读，可稍后重试）"
    except Exception as e:
        event["ai"] = f"（AI 解读失败：{str(e)[:220]}）"
    await _feishu_push(
        f"🤖 盯盘异动\n{event['symbol']}（{name}）5分钟{'急涨' if event['dir'] == 'up' else '跳水'} {event['chg5']:+.2f}%，现价 {event['price']}\n"
        f"日内 {event['day_chg'] if event['day_chg'] is not None else '--'}%{pos_line}\n\n💡 {str(event['ai'])[:600]}"
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
    directory = await get_directory(max_age=3600)
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
    _emit_event(event)
    asyncio.create_task(_ai_comment_for_event(event))


def _check_intl(hist: list, sensitivity: float):
    """国际品种 5 分钟急涨急跌检测"""
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
            "intl": True,
        }
        _emit_event(event)
        asyncio.create_task(_ai_comment_for_event(event))


async def monitor_loop():
    """盯盘双轨：国际品种 24 小时 + 国内品种（自选+持仓+预警）按各自交易时段"""
    await asyncio.sleep(20)
    hist: list[tuple[float, dict]] = []
    while True:
        try:
            mon_cfg = (load_config().get("monitor") or DEFAULT_CONFIG["monitor"])
            if mon_cfg.get("enabled", True):
                try:
                    items = await fetch_intl()
                except Exception:
                    items = _intl_cache.get("items") or []
                now_ts = asyncio.get_event_loop().time()
                prices = {it["symbol"]: it.get("last") for it in items if it.get("last") is not None}
                if prices:
                    hist.append((now_ts, prices))
                    hist = hist[-40:]
                    _check_intl(hist, mon_cfg.get("sensitivity", 1.0))
                if is_trading_time():
                    symbols = set(_MONITOR["watch"])
                    try:
                        symbols |= {
                            str(t["symbol"]).upper()
                            for t in _load_trades()
                            if t.get("status") == "open"
                        }
                    except Exception:
                        pass
                    symbols |= {a["symbol"] for a in _load_alerts() if not a.get("fired_ts")}
                    for sym in sorted(symbols):
                        if domestic_session_active(_variety_prefix(sym)):
                            await _check_symbol(sym, mon_cfg.get("sensitivity", 1.0))
                    await _check_alerts()
                _MONITOR["last_check"] = datetime.now().strftime("%H:%M:%S")
        except Exception:
            pass
        await asyncio.sleep(MONITOR_INTERVAL)


@app.get("/api/monitor/events")
async def monitor_events(limit: int = 30):
    mon_cfg = (load_config().get("monitor") or DEFAULT_CONFIG["monitor"])
    return {
        "ok": True,
        "enabled": mon_cfg.get("enabled", True),
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
    """构造一条模拟异动事件，端到端验证盯盘提醒链路（浏览器地址栏可直接触发）"""
    sym = "SC0"
    try:
        snap = await psych_snapshot(sym)
        last_close = snap.get("last") or 585.0
        name = snap.get("name") or "上海原油连续"
    except Exception:
        last_close, name = 585.0, "上海原油连续"
    event = {
        "id": f"{sym}-test-{int(asyncio.get_event_loop().time() * 1000)}",
        "ts": int(datetime.now().timestamp() * 1000),
        "symbol": sym,
        "name": name,
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
    _emit_event(event)
    asyncio.create_task(_ai_comment_for_event(event))
    return {"ok": True, "id": event["id"]}


# ---------------------------------------------------------------- 博弈异变监控（散户陷阱雷达）

_psych_prev: dict[str, dict] = {}
_psych_cool: dict[tuple, float] = {}


async def psych_watch_loop():
    """每 90 秒对比各品种博弈快照：行情阶段切换 / 资金定性翻转 / 陷阱指数升高 → 事件流。
    这是"散户怎么想"的实时预警线。"""
    await asyncio.sleep(60)
    while True:
        try:
            now = datetime.now()
            if is_trading_time(now) or (now.weekday() < 5 and 20 <= now.hour < 24):
                syms = ({s.upper() for s in _MONITOR["watch"]}
                        | {t["symbol"] for t in _load_trades() if t.get("status") == "open"}
                        | set(_load_profile().get("symbols") or []))
                for sym in sorted(syms)[:8]:
                    await _psych_check(sym)
        except Exception:
            pass
        await asyncio.sleep(90)


async def _psych_check(sym: str) -> None:
    try:
        snap = await psych_snapshot(sym)
    except Exception:
        return
    cur = {
        "regime": snap["regime"]["key"],
        "trap": snap["parties"]["retail"]["trap_risk"],
        "capital": snap["capital"].get("state5") or "",
    }
    prev = _psych_prev.get(sym)
    _psych_prev[sym] = cur
    if not prev:
        return  # 首轮建档
    loop_now = asyncio.get_event_loop().time()
    name = snap.get("name") or sym

    def _emit(ctype: str, text: str, feishu: bool = False, level: str = "info"):
        key = (sym, ctype)
        if loop_now - _psych_cool.get(key, -1e9) < 900:
            return
        _psych_cool[key] = loop_now
        _emit_event({
            "id": f"psych-{sym}-{ctype}-{int(loop_now)}",
            "ts": int(datetime.now().timestamp() * 1000),
            "kind": "psych", "etype": ctype, "level": level,
            "symbol": sym, "name": name, "dir": "up",
            "price": snap.get("last"), "text": text,
            "chg5": 0.0, "chg15": 0.0, "threshold": 0.0, "intl": True, "ai": "",
        }, feishu=feishu, feishu_text=f"📡 博弈雷达 · {sym}（{name}）\n{text}\n现价 {snap.get('last')}")

    # 行情阶段切换（最重要的结构事件）
    if prev["regime"] != cur["regime"]:
        _emit("regime",
              f"{sym} 行情阶段切换：{psy.PLAYBOOKS[prev['regime']]['label']} → {psy.PLAYBOOKS[cur['regime']]['label']}"
              f"——散户剧本已变，重新审视持仓方向",
              feishu=True, level="warn")
    # 资金定性翻转（持仓×价格组合变化）
    if prev["capital"] and cur["capital"] and prev["capital"] != cur["capital"]:
        _emit("capital", f"{sym} 资金定性翻转：{prev['capital']} → {cur['capital']}（持仓×价格组合变化）")
    # 陷阱指数跨入高危区
    if prev["trap"] < 70 <= cur["trap"]:
        _emit("trap", f"{sym} 散户陷阱指数升至 {cur['trap']}/100（{snap['regime']['label']}）——警惕典型散户行为高发",
              feishu=True, level="warn")


# ---------------------------------------------------------------- 交易记录 + 诊断引擎

TRADES_FILE = BASE_DIR / "trades.json"


def _load_trades() -> list[dict]:
    if TRADES_FILE.exists():
        try:
            return json.loads(TRADES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


GATE_LOG_FILE = BASE_DIR / "gate_log.json"


def _load_gate_log() -> list[dict]:
    """开仓闸门拦截记录（被拦下的尝试——防线战果，也是行为模式的证据）"""
    if GATE_LOG_FILE.exists():
        try:
            return json.loads(GATE_LOG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_gate_log(items: list[dict]) -> None:
    try:
        GATE_LOG_FILE.write_text(json.dumps(items[-200:], ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _save_trades(trades: list[dict]) -> None:
    try:
        TRADES_FILE.write_text(json.dumps(trades, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _init_trail(entry: float, stop_points: float, target_points: float,
                trail_points: float = 0, trail_arm: float = 0) -> dict:
    """持仓动态止盈（追踪止盈）初始状态"""
    return {
        "points": round(trail_points or stop_points * 0.5, 1),
        "arm": round(trail_arm or stop_points, 1),
        "target": target_points,
        "peak": entry,
        "active": False,
        "triggered": False,
        "partial_done": False,
    }


def _trail_state(t: dict, price: float) -> list[dict]:
    """更新单笔持仓的追踪止盈状态；返回本轮产生的提示事件"""
    tr = t.get("trail")
    if not tr or t.get("status") != "open" or not price:
        return []
    events: list[dict] = []
    sign = 1 if t["direction"] == "long" else -1
    pnl = sign * (price - t["entry"])
    if sign * (price - tr["peak"]) > 0:
        tr["peak"] = price
    if not tr["active"] and pnl >= tr["arm"]:
        tr["active"] = True
        events.append({"etype": "arm", "price": price, "pnl": round(pnl, 1),
                       "line": round(tr["peak"] - sign * tr["points"], 2)})
    if not tr["partial_done"] and tr.get("target") and pnl >= tr["target"]:
        tr["partial_done"] = True
        events.append({"etype": "partial", "price": price, "pnl": round(pnl, 1),
                       "line": round(tr["peak"] - sign * tr["points"], 2)})
    if tr["active"] and not tr["triggered"]:
        line = round(tr["peak"] - sign * tr["points"], 2)
        if sign * (line - price) >= 0:
            tr["triggered"] = True
            events.append({"etype": "trigger", "price": price, "pnl": round(pnl, 1), "line": line})
    return events


TRAIL_TEXT = {
    "arm": "🎯 {sym} {d}浮盈 +{pnl:.0f} 点，移动止盈激活：峰值 {peak} 回撤 {points:.0f} 点即离场（追踪线 {line}）",
    "partial": "📍 {sym} {d}浮盈 +{pnl:.0f} 点已达目标位：建议减仓 1/2，剩余改用移动止盈（追踪线 {line}）",
    "trigger": "✅ {sym} {d}移动止盈触发：{verb}追踪线 {line}，建议离场锁盈（当前浮盈 {pnl:+.0f} 点）",
}


async def trail_loop():
    """动态止盈巡检：持仓单每 30 秒更新追踪止盈状态，触发提示进事件流 + 飞书"""
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
                                _emit_event({
                                    "id": f"{t['symbol']}-trail-{ev['etype']}-{t['id']}",
                                    "ts": int(datetime.now().timestamp() * 1000),
                                    "kind": "trail", "etype": ev["etype"],
                                    "symbol": t["symbol"], "dir": "up" if t["direction"] == "long" else "down",
                                    "price": price, "line": ev["line"], "pnl": ev["pnl"],
                                    "text": text,
                                    "chg5": 0.0, "chg15": 0.0, "threshold": 0.0, "intl": True, "ai": "",
                                }, feishu=True, feishu_text=text)
                    if len(_MONITOR["events"]) > MONITOR_MAX_EVENTS:
                        _MONITOR["events"] = _MONITOR["events"][-MONITOR_MAX_EVENTS:]
                    if changed:
                        _save_trades(trades)
        except Exception:
            pass
        await asyncio.sleep(30)


# ---------------------------------------------------------------- 交割单导入（真实成交 → 交易记录）

# 交割单/成交流水列名别名（各家期货公司导出格式差异）
_IMPORT_COL_ALIAS = {
    "date": ("成交日期", "交易日期", "日期", "交易日"),
    "time": ("成交时间", "时间", "成交时点"),
    "contract": ("合约", "合约代码", "合约编号", "instrument", "证券代码"),
    "dir": ("买卖", "方向", "买卖方向", "交易方向"),
    "offset": ("开平", "开平仓", "开平标志", "开平类型"),
    "price": ("成交价", "价格", "成交价格", "发生价格"),
    "lots": ("成交量", "手数", "数量", "成交数量"),
    "fee": ("手续费", "费用", "手续费金额", "成交手续费"),
}
_DIR_LONG = ("买", "买入", "b", "buy", "多")
_DIR_SHORT = ("卖", "卖出", "s", "sell", "空")
_OPEN_KW = ("开", "o")
_CLOSE_KW = ("平", "c")


def _imp_num(v) -> Optional[float]:
    try:
        s = str(v).strip().replace(",", "").replace("，", "")
        if not s or s in ("--", "-"):
            return None
        return float(s)
    except (TypeError, ValueError):
        return None


def _imp_dt(date_s: str, time_s: str):
    """交割单日期时间解析：2026-09-14 / 2026/9/14 / 20260914 × 21:05:32 / 09:05 / 9:05 / 空"""
    d = str(date_s or "").strip().replace("/", "-").replace(".", "-")
    if len(d) == 8 and d.isdigit():
        d = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
    elif "-" in d:
        parts = d.split("-")
        if len(parts) == 3 and len(parts[0]) == 4 and parts[0].isdigit():
            try:
                d = f"{parts[0]}-{int(parts[1]):02d}-{int(parts[2]):02d}"  # 2026-9-4 → 2026-09-04
            except ValueError:
                pass
    t = str(time_s or "").strip().replace("：", ":")
    digits = t.replace(":", "")
    if digits.isdigit() and len(digits) in (3, 4, 6):
        if len(digits) == 3:      # 905 → 09:05
            digits = "0" + digits
        if len(digits) == 4:
            t = f"{digits[:2]}:{digits[2:]}:00"
        else:
            t = f"{digits[:2]}:{digits[2:4]}:{digits[4:]}"
    try:
        if not d:
            return None, ""
        dt = datetime.fromisoformat(f"{d}T{t or '00:00:00'}")
        return dt, d
    except ValueError:
        return None, ""


def _imp_dir_offset(dir_raw: str, offset_raw: str) -> tuple[str, str]:
    """返回 (long/short, open/close)。兼容 '买开/卖平' 复合写法与独立开平列"""
    d = (dir_raw or "").strip().lower()
    o = (offset_raw or "").strip().lower()
    side = "long" if d.startswith(_DIR_LONG) else "short" if d.startswith(_DIR_SHORT) else ""
    # 无独立开平列时从方向词推断（买开/卖平），否则看开平列
    if "开" in dir_raw and "平" not in dir_raw:
        act = "open"
    elif "平" in dir_raw:
        act = "close"
    elif o.startswith(_CLOSE_KW):
        act = "close"
    elif o.startswith(_OPEN_KW):
        act = "open"
    else:
        act = ""
    return side, act


def _parse_fills(text: str) -> tuple[list[dict], list[str]]:
    """解析成交流水文本（CSV/制表符，Excel 直接复制粘贴即可）。返回 (fills, errors)"""
    errors: list[str] = []
    if not text or not text.strip():
        return [], ["内容为空"]
    lines = [ln for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if ln.strip()]
    if not lines:
        return [], ["没有有效行"]
    delim = "\t" if lines[0].count("\t") >= lines[0].count(",") else ","
    header = [c.strip().strip('"') for c in lines[0].split(delim)]
    col_map: dict[str, int] = {}
    for key, aliases in _IMPORT_COL_ALIAS.items():
        for i, h in enumerate(header):
            if h and any(h.lower() == a.lower() or a in h for a in aliases):
                col_map[key] = i
                break
    if "contract" not in col_map or "price" not in col_map or "lots" not in col_map:
        return [], [f"未识别到必要列（需含 合约/成交价/成交量，表头实际为：{delim.join(header[:10])}）"]
    fills: list[dict] = []
    for ln in lines[1:]:
        cells = [c.strip().strip('"') for c in ln.split(delim)]
        if not cells or any(k in ln for k in ("合计", "小计", "总计")):
            continue
        contract = cells[col_map["contract"]].upper() if len(cells) > col_map["contract"] else ""
        price = _imp_num(cells[col_map["price"]]) if len(cells) > col_map["price"] else None
        lots = _imp_num(cells[col_map["lots"]]) if len(cells) > col_map["lots"] else None
        if not contract or price is None or not lots:
            continue
        dir_raw = cells[col_map["dir"]] if "dir" in col_map and len(cells) > col_map["dir"] else ""
        off_raw = cells[col_map["offset"]] if "offset" in col_map and len(cells) > col_map["offset"] else ""
        side, act = _imp_dir_offset(dir_raw, off_raw)
        if not side:
            errors.append(f"无法识别买卖方向：{ln[:50]}")
            continue
        if not act:
            act = "open"  # 兜底：无开平信息按开仓（仅影响配对，不影响金额）
        date_s = cells[col_map["date"]] if "date" in col_map and len(cells) > col_map["date"] else ""
        time_s = cells[col_map["time"]] if "time" in col_map and len(cells) > col_map["time"] else ""
        dt, date_norm = _imp_dt(date_s, time_s)
        fee = _imp_num(cells[col_map["fee"]]) if "fee" in col_map and len(cells) > col_map["fee"] else 0.0
        fills.append({
            "contract": contract, "side": side, "act": act, "price": price,
            "lots": lots, "fee": abs(fee or 0.0),
            "dt": dt, "date": date_norm or (dt.strftime("%Y-%m-%d") if dt else ""),
            "ms": int(dt.timestamp() * 1000) if dt else 0,
        })
    if not fills:
        errors.insert(0, "没有解析出有效成交行")
    return fills, errors[:8]


def _pair_fills(fills: list[dict]) -> tuple[list[dict], list[dict], int]:
    """FIFO 配对开平仓 → (闭环交易, 未平仓, 未能配对的开仓数)。
    平仓方向与被平持仓相反：卖平=平多，买平=平空。"""
    fills = sorted(fills, key=lambda f: (f["ms"] or 0,))
    queues: dict[str, list[dict]] = {}  # contract -> 待平仓手 [{side, price, lots, ms, date}]
    closed: list[dict] = []
    unmatched_close = 0
    for f in fills:
        q = queues.setdefault(f["contract"], [])
        if f["act"] == "open":
            q.append({"side": f["side"], "price": f["price"], "lots": f["lots"],
                      "ms": f["ms"], "date": f["date"], "fee": f["fee"]})
            continue
        # 平仓：被平一侧与成交方向相反
        closed_side = "short" if f["side"] == "long" else "long"
        remain = f["lots"]
        fee_left = f["fee"]
        total_lots_in_fill = f["lots"]
        while remain > 1e-9 and q:
            head_long = next((h for h in q if h["side"] == closed_side), None)
            if not head_long:
                break
            take = min(remain, head_long["lots"])
            hold_min = round((f["ms"] - head_long["ms"]) / 60000, 0) if f["ms"] and head_long["ms"] else None
            fee_share = round(fee_left * (take / total_lots_in_fill), 2) if total_lots_in_fill else 0
            sign = 1 if closed_side == "long" else -1
            entry_fee = round(head_long["fee"] * (take / head_long["lots"]), 2) if head_long["lots"] else 0
            exit_ms = f["ms"] or head_long["ms"]
            closed.append({
                "id": f"imp{exit_ms}-{f['contract']}-{closed_side}-{len(closed)}",
                "ts": head_long["ms"], "date": head_long["date"],
                "symbol": (re.match(r"^([A-Za-z]{1,2})", f["contract"]).group(1).upper() + "0"
                           if re.match(r"^([A-Za-z]{1,2})", f["contract"]) else f["contract"]),
                "contract": f["contract"],
                "direction": closed_side,
                "entry": head_long["price"], "exit": f["price"],
                "stop_points": None, "target_points": None,
                "lots": int(take) if abs(take - round(take)) < 1e-9 else round(take, 2),
                "status": "closed",
                "result_pts": round(sign * (f["price"] - head_long["price"]), 1),
                "closed_ts": exit_ms,
                "note": f"交割单导入（持时{int(hold_min)}分）" if hold_min is not None else "交割单导入",
                "fees": round(fee_share + entry_fee, 2),
                "hold_min": int(hold_min) if hold_min is not None else None,
                "source": "import", "trail": None,
            })
            head_long["lots"] -= take
            head_long["fee"] -= entry_fee
            remain -= take
            if head_long["lots"] <= 1e-9:
                q.remove(head_long)
        if remain > 1e-9:
            unmatched_close += 1
    # 剩余未平仓 → 当前持仓
    opened: list[dict] = []
    for contract, q in queues.items():
        for h in q:
            if h["lots"] <= 1e-9:
                continue
            opened.append({
                "id": f"imp{h['ms']}-{contract}-{h['side']}-open",
                "ts": h["ms"], "date": h["date"],
                "symbol": (re.match(r"^([A-Za-z]{1,2})", contract).group(1).upper() + "0"
                           if re.match(r"^([A-Za-z]{1,2})", contract) else contract),
                "contract": contract, "direction": h["side"], "entry": h["price"],
                "stop_points": None, "target_points": None,
                "lots": int(h["lots"]) if abs(h["lots"] - round(h["lots"])) < 1e-9 else round(h["lots"], 2),
                "status": "open", "exit": None, "result_pts": None, "closed_ts": None,
                "note": "交割单导入（未平仓）", "fees": round(h["fee"], 2),
                "source": "import", "trail": None,
            })
    return closed, opened, unmatched_close


class TradeImportIn(BaseModel):
    text: str = ""
    dry_run: int = 1


def _import_payload(fills: list, closed: list, opened: list, unmatched: int, errors: list):
    return {
        "ok": True,
        "fills_count": len(fills),
        "closed_count": len(closed),
        "closed_preview": [
            {"date": t["date"], "symbol": t["symbol"], "contract": t["contract"],
             "direction": t["direction"], "lots": t["lots"], "entry": t["entry"],
             "exit": t["exit"], "result_pts": t["result_pts"], "hold_min": t["hold_min"]}
            for t in closed[:10]
        ],
        "open_count": len(opened),
        "open_preview": [
            {"date": t["date"], "symbol": t["symbol"], "contract": t["contract"],
             "direction": t["direction"], "lots": t["lots"], "entry": t["entry"]}
            for t in opened[:10]
        ],
        "unmatched_close": unmatched,
        "errors": errors,
    }


@app.post("/api/trades/import")
async def trades_import(body: TradeImportIn):
    """导入交割单/成交流水（CSV/制表符文本，编码由前端解码）。dry_run=1 仅解析预览；
    dry_run=0 落盘（按 id 去重，重复导入安全）"""
    fills, errors = _parse_fills(body.text)
    if not fills:
        raise HTTPException(status_code=400, detail="；".join(errors) or "未解析出任何成交")
    closed, opened, unmatched = _pair_fills(fills)
    payload = _import_payload(fills, closed, opened, unmatched, errors)
    if body.dry_run:
        return payload
    trades = _load_trades()
    exist_ids = {t.get("id") for t in trades}
    new_items = [t for t in closed + opened if t["id"] not in exist_ids]
    trades.extend(new_items)
    _save_trades(trades)
    payload["added"] = len(new_items)
    payload["skipped_dup"] = len(closed) + len(opened) - len(new_items)
    return payload


class TradeIn(BaseModel):
    symbol: str
    direction: str  # long / short
    entry: float
    stop_points: float = 0
    target_points: float = 0
    lots: float = 1
    date: str = ""
    note: str = ""
    force: int = 0  # 1=已在红色风险确认后仍要开仓（记录违规标记）


# ---- 诊断规则（开仓即检 + 持仓盯防，问题即时暴露） ----

def _issue(iid, sev, title, evidence, advice, symbol="", trade_id=""):
    return {"id": iid, "sev": sev, "title": title, "evidence": evidence,
            "advice": advice, "symbol": symbol, "trade_id": trade_id,
            "ts": int(datetime.now().timestamp() * 1000)}


async def _diagnose_trade(t: dict, snap: Optional[dict], price: Optional[float]) -> list[dict]:
    """单笔交易的问题清单（需要博弈快照与实时价配合的规则）"""
    out = []
    sym = t["symbol"]
    side = t["direction"]
    sign = 1 if side == "long" else -1
    stop = float(t.get("stop_points") or 0)
    lots = float(t.get("lots") or 1)
    entry = float(t.get("entry") or 0)

    # D01 无止损
    if stop <= 0:
        out.append(_issue("D01", "fatal", "开仓无止损",
                          f"{sym} {'多' if side == 'long' else '空'}单 @ {entry} 未设止损点数",
                          "无止损=把亏损的控制权交给了对手盘。立即补设止损（逻辑位，不是金额倒推位）。", sym, t.get("id", "")))
    # D02 扛单越损（实时，两级：越损=止损犹豫；超2倍=深度扛单）
    if price and stop > 0:
        flt = sign * (price - entry)
        if flt < -stop * 2:
            out.append(_issue("D02", "fatal", "深度扛单（止损已远被击穿）",
                              f"{sym} 浮动 {flt:+.1f} 点，已达止损 {stop:.0f} 点的 {abs(flt) / stop:.1f} 倍",
                              "止损被击穿两倍以上仍在场=决策权已完全交给对手盘。立即离场，这笔的教训比这笔的亏损值钱。", sym, t.get("id", "")))
        elif flt < -stop * 1.1:
            out.append(_issue("D02", "fatal", "价格已穿止损仍未离场（止损犹豫）",
                              f"{sym} 浮动 {flt:+.1f} 点，已超止损 {stop:.0f} 点 {abs(flt) - stop:.1f} 点",
                              "「再等等」每多一分钟，主动权就少一分：按纪律离场，把决定权拿回来。", sym, t.get("id", "")))
    # D03 止损过窄（日内噪音可扫）
    if stop > 0 and snap:
        intra = snap.get("intraday") or {}
        rng = (intra.get("day_high") or 0) - (intra.get("day_low") or 0)
        if rng and stop < rng * 0.15:
            out.append(_issue("D03", "warn", "止损窄于日内噪音",
                              f"止损 {stop:.0f} 点 vs 今日波幅 {rng:.0f} 点（仅 {stop / rng * 100:.0f}%）",
                              "太窄的止损会被正常波动扫掉（扫了再按原方向走是常态）。放到结构位外、并相应减仓。", sym, t.get("id", "")))
    # D04 单笔风险超标
    mult = CONTRACT_MULTIPLIER.get(_variety_prefix(sym))
    cfg = load_config()["discipline"]
    acct = float(cfg.get("account_size") or 0)
    if acct > 0 and mult and stop > 0:
        risk_amt = stop * mult * lots
        cap = acct * float(cfg.get("risk_per_trade", 1.0)) / 100
        if risk_amt > cap * 2:
            out.append(_issue("D04", "fatal", "单笔风险严重超标",
                              f"该笔满打亏损约 ¥{risk_amt:,.0f}，为上限（¥{cap:,.0f}）的 {risk_amt / cap:.1f} 倍",
                              "重仓是散户爆仓的第一路径。减仓到上限以内。", sym, t.get("id", "")))
        elif risk_amt > cap:
            out.append(_issue("D04", "warn", "单笔风险超上限",
                              f"该笔满打亏损约 ¥{risk_amt:,.0f} > 上限 ¥{cap:,.0f}",
                              "减仓或放宽止损到结构位（二选一，不要硬扛）。", sym, t.get("id", "")))
    # D07 逆资金方向
    if snap:
        cap_state = (snap.get("capital") or {}).get("state5")
        regime = (snap.get("regime") or {}).get("key")
        trend_bias = (snap.get("trend") or {}).get("bias")
        is_long = side == "long"
        if (is_long and (cap_state in _BEAR_CAPITAL or regime in _BEAR_REGIMES)) or \
           (not is_long and (cap_state == "增仓上行" or regime in ("趋势上行", "高位加速"))):
            out.append(_issue("D07", "fatal", "逆资金方向开仓",
                              f"{'做多' if is_long else '做空'}，但当前：行情阶段「{snap['regime']['label']}」、日线资金「{cap_state or '不明'}」",
                              "逆着新进场资金的方向做单=给对手盘送流动性。要么反手顺势，要么空仓等方向翻转信号。", sym, t.get("id", "")))
        # D09 左侧抄底/摸顶（P003：左侧仓位减半）
        elif is_long and trend_bias == "down" and regime not in ("低位企稳",):
            out.append(_issue("D09", "warn", "左侧做多（大势未转向）",
                              f"价格仍在下行大势中（阶段「{snap['regime']['label']}」），此时做多属左侧交易",
                              "左侧胜率天然低：仓位上限降为正常一半，止损放前低下方结构位（不是整数关口附近）。", sym, t.get("id", "")))
        elif (not is_long) and trend_bias == "up":
            out.append(_issue("D09", "warn", "左侧做空（大势向上）",
                              f"大势偏上行（阶段「{snap['regime']['label']}」），此时做空属摸顶",
                              "趋势的终点无法预知。摸顶仓位减半，止损放前高上方。", sym, t.get("id", "")))
        # D08 追涨杀跌（入场位置 vs 日内结构）
        intra = snap.get("intraday") or {}
        pos_pct = intra.get("pos_pct")
        c15 = intra.get("chg15m") or 0
        if pos_pct is not None:
            if side == "long" and pos_pct >= 82 and c15 > 0.15:
                out.append(_issue("D08", "warn", "追高入场（日内 {p:.0f}% 分位）".format(p=pos_pct),
                                  f"入场贴近日内高点（{pos_pct:.0f}% 分位），15 分钟已涨 {c15:+.2f}%——典型的 FOMO 追涨位",
                                  "追在情绪最热处=盈亏比最差。等回踩确认再进；若必须进，减半仓+收紧止损。", sym, t.get("id", "")))
            if side == "short" and pos_pct <= 18 and c15 < -0.15:
                out.append(_issue("D08", "warn", "杀跌追空（日内 {p:.0f}% 分位）".format(p=pos_pct),
                                  f"入场贴近日内低点（{pos_pct:.0f}% 分位），15 分钟已跌 {c15:+.2f}%——恐慌追空位",
                                  "恐慌末端追空容易吃反弹。等反抽衰竭再进。", sym, t.get("id", "")))
    return out


def _diagnose_global(trades: list) -> list[dict]:
    """跨交易的群体问题：超频 / 报复交易 / 连亏未停 / 相关品种堆仓 / 日亏损停手线 / 持亏砍盈"""
    out = []
    cfg = load_config()["discipline"]
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")

    today_trades = [t for t in trades if t.get("date") == today and t.get("status") in ("open", "closed")]
    daily_max = int(cfg.get("daily_max_trades", 3))
    if len(today_trades) > daily_max:
        out.append(_issue("D05", "fatal", "日内开仓超限",
                          f"今日已开 {len(today_trades)} 笔（上限 {daily_max}）",
                          "频繁交易=手续费+情绪双杀。今日停止开新仓。"))

    # 报复性交易：亏损了结后 30 分钟内立刻开新仓
    closed_sorted = sorted(
        [t for t in trades if t.get("status") == "closed" and t.get("closed_ts")],
        key=lambda t: t["closed_ts"])
    for c in reversed(closed_sorted[-8:]):
        if (c.get("result_pts") or 0) >= 0:
            continue
        for t in trades:
            if t.get("ts") and t["ts"] > c["closed_ts"] and t["ts"] - c["closed_ts"] < 30 * 60 * 1000:
                out.append(_issue("D06", "warn", "疑似报复性交易",
                                  f"{c['symbol']} 亏损了结后 {((t['ts'] - c['closed_ts']) / 60000):.0f} 分钟即开新仓 {t['symbol']}",
                                  "亏损后的第一冲动往往不是机会而是情绪。冷静期（默认 30 分钟）内不开仓。", "", t.get("id", "")))
                break
        break

    # 连续亏损
    recent = [t for t in closed_sorted if t.get("result_pts") is not None][-3:]
    if len(recent) == 3 and all((t.get("result_pts") or 0) < 0 for t in recent):
        out.append(_issue("D11", "warn", "连续 3 笔亏损",
                          "、".join(f"{t['symbol']} {t['result_pts']:+.0f}点" for t in recent),
                          "连亏说明节奏或方向感出了问题（往往正值逆势期）。停手半日，用「品种博弈」页重看资金方向。"))

    # 相关品种组同向堆仓（隐形杠杆）
    group_hits: dict[str, list] = {}
    for t in trades:
        if t.get("status") != "open":
            continue
        pfx = _variety_prefix(t["symbol"])
        for g, members in CORR_GROUPS.items():
            if pfx in members:
                group_hits.setdefault(f"{g}:{t['direction']}", []).append(t["symbol"])
    for key, syms in group_hits.items():
        g, side = key.rsplit(":", 1)
        if len(set(syms)) >= 2:
            out.append(_issue("D10", "warn", "高相关品种同向堆仓",
                              f"{g}：{'、'.join(sorted(set(syms)))} 同方向持仓",
                              "相关品种同向持仓=隐形杠杆（一个板块逻辑反转全线被套）。合并计算仓位上限。"))

    # 日内已实现亏损 vs 停手线
    acct = float(cfg.get("account_size") or 0)
    if acct > 0:
        realized = 0.0
        for t in today_trades:
            if t.get("status") == "closed" and t.get("result_pts") is not None:
                m = CONTRACT_MULTIPLIER.get(_variety_prefix(t["symbol"]))
                if m:
                    realized += float(t["result_pts"]) * m * float(t.get("lots") or 1)
        stop_line = -acct * float(cfg.get("daily_stop", 3.0)) / 100
        if realized < stop_line:
            out.append(_issue("D12", "fatal", "日亏损已达停手线",
                              f"今日已实现约 ¥{realized:,.0f}，越过停手线 ¥{stop_line:,.0f}",
                              "停手线是体系的最后防线。关掉软件，今天结束了。"))
        elif realized < stop_line * 0.6 and realized < 0:
            out.append(_issue("D12", "info", "日亏损接近停手线",
                              f"今日已实现约 ¥{realized:,.0f}（停手线 ¥{stop_line:,.0f}）",
                              "只剩最后的安全垫，只减不加。"))

    # 持亏砍盈倾向（统计性，需要已了结样本）
    closed_pts = [float(t["result_pts"]) for t in closed_sorted if t.get("result_pts") is not None]
    if len(closed_pts) >= 6:
        wins = [p for p in closed_pts if p > 0]
        losses = [p for p in closed_pts if p < 0]
        if wins and losses:
            avg_w = sum(wins) / len(wins)
            avg_l = abs(sum(losses) / len(losses))
            if avg_w < avg_l * 0.7:
                out.append(_issue("D13", "warn", "持亏砍盈倾向（赚小赔大）",
                                  f"近 {len(closed_pts)} 笔：平均盈利 {avg_w:+.0f} 点 vs 平均亏损 -{avg_l:.0f} 点",
                                  "盈亏比倒挂是散户统计特征：盈利单拿不住（怕回吐）、亏损单扛得住（怕认错）。让利润单按计划走到目标。"))
    return out


_DIAG = {"issues": [], "ts": 0.0, "seen": {}, "running": False}


async def _diagnosis_scan(push: bool = False) -> list[dict]:
    """全量诊断：持仓逐笔 + 群体问题。push=True 时新 fatal 问题进事件流+飞书。"""
    trades = _load_trades()
    issues: list[dict] = []
    open_trades = [t for t in trades if t.get("status") == "open"]
    missing = sorted({t["symbol"] for t in open_trades
                      if not (_quote_cache.get(t["symbol"], (0, {}))[1] or {}).get("last")})
    if missing:
        await asyncio.gather(*[fetch_quote(s) for s in missing], return_exceptions=True)
    for t in open_trades:
        snap = None
        price = None
        try:
            snap = await psych_snapshot(t["symbol"])
        except Exception:
            pass
        ts_, q = _quote_cache.get(t["symbol"], (0, {}))
        price = (q or {}).get("last")  # 取不到时仍诊断（D01/D07 等不依赖现价，仅 D02/D03 跳过）
        issues.extend(await _diagnose_trade(t, snap, price))
    issues.extend(_diagnose_global(trades))
    sev_rank = {"fatal": 0, "warn": 1, "info": 2}
    issues.sort(key=lambda x: sev_rank.get(x["sev"], 3))

    if push:
        now_ts = asyncio.get_event_loop().time()
        for it in issues:
            if it["sev"] != "fatal":
                continue
            key = f"{it['id']}:{it['trade_id']}"
            if now_ts - _DIAG["seen"].get(key, -1e9) < 1800:
                continue
            _DIAG["seen"][key] = now_ts
            _emit_event({
                "id": f"diag-{key}-{int(now_ts)}",
                "ts": it["ts"],
                "kind": "diag", "etype": it["id"], "level": "fatal",
                "symbol": it["symbol"], "name": "", "dir": "down",
                "price": None, "text": f"🚨 {it['title']}：{it['evidence']}",
                "chg5": 0.0, "chg15": 0.0, "threshold": 0.0, "intl": True, "ai": "",
            }, feishu=True, feishu_text=f"🚨 交易诊断预警\n{it['title']}\n{it['evidence']}\n\n→ {it['advice']}")
    _DIAG["issues"] = issues
    _DIAG["ts"] = asyncio.get_event_loop().time()
    return issues


async def diagnose_loop():
    """交易诊断巡检：交易时段每 60 秒扫一遍（扛单/越限的实时预警线）"""
    await asyncio.sleep(40)
    while True:
        try:
            now = datetime.now()
            if is_trading_time(now) or (now.weekday() < 5 and 20 <= now.hour < 24):
                if _load_trades():
                    await _diagnosis_scan(push=True)
        except Exception:
            pass
        await asyncio.sleep(60)


@app.get("/api/diagnosis")
async def diagnosis():
    loop_now = asyncio.get_event_loop().time()
    if not _DIAG["issues"] or loop_now - _DIAG["ts"] > 45:
        if not _DIAG["running"]:
            _DIAG["running"] = True
            try:
                await _diagnosis_scan()
            finally:
                _DIAG["running"] = False
    fatal = sum(1 for i in _DIAG["issues"] if i["sev"] == "fatal")
    warn = sum(1 for i in _DIAG["issues"] if i["sev"] == "warn")
    return {"ok": True, "issues": _DIAG["issues"], "fatal_count": fatal, "warn_count": warn}


# ---------------------------------------------------------------- 开仓闸门（散户高发亏钱模式的源头拦截）

_GATE_BEAR_REGIMES = {"低位阴跌", "低位恐慌", "趋势下行", "高位回落"}


def _entry_gate(trade: dict, snap: Optional[dict], price: Optional[float], all_trades: list) -> list[dict]:
    """源头拦截器：接飞刀 / 亏损加仓 / 幻想反弹 / 逆资金 / 追涨 / 恐慌追空 /
    冷静期 / 日亏停手线 / 日内超频。返回致命级 blockers（空=放行）。
    设计：不剥夺开仓自由，但强制二次确认并留违规标记。"""
    out = []
    sym = trade["symbol"]
    is_long = trade["direction"] == "long"
    side_txt = "做多" if is_long else "做空"

    def block(code: str, name: str, evidence: str, antidote: str):
        out.append({"code": code, "name": name, "evidence": evidence, "antidote": antidote})

    # ---- 纪律类（用户配置的风控参数，在源头执行）----
    cfg = load_config()["discipline"]
    today = datetime.now().strftime("%Y-%m-%d")

    cooling_min = float(cfg.get("cooling_min", 30) or 0)
    if cooling_min > 0:
        now_ms = int(datetime.now().timestamp() * 1000)
        last_loss_ts = max(
            (t.get("closed_ts") or 0) for t in all_trades
            if t.get("status") == "closed" and (t.get("result_pts") or 0) < 0 and t.get("closed_ts")
        ) if any(t.get("status") == "closed" and (t.get("result_pts") or 0) < 0 and t.get("closed_ts")
                 for t in all_trades) else 0
        if last_loss_ts and now_ms - last_loss_ts < cooling_min * 60 * 1000:
            remain = (cooling_min * 60 * 1000 - (now_ms - last_loss_ts)) / 60000
            block("G7", "⏳ 冷静期内（亏损后）",
                  f"{cooling_min - remain:.0f} 分钟前刚有亏损平仓，{cooling_min:.0f} 分钟冷静期还剩 {remain:.0f} 分钟",
                  "亏损后的第一冲动是情绪不是机会。冷静期是给大脑的冷却时间——等它走完再评估")

    acct = float(cfg.get("account_size") or 0)
    if acct > 0:
        realized = 0.0
        for t in all_trades:
            if t.get("date") == today and t.get("status") == "closed" and t.get("result_pts") is not None:
                m = CONTRACT_MULTIPLIER.get(_variety_prefix(t["symbol"]))
                if m:
                    realized += float(t["result_pts"]) * m * float(t.get("lots") or 1)
        stop_line = -acct * float(cfg.get("daily_stop", 3.0)) / 100
        if realized < stop_line:
            block("G8", "🛑 日亏已达停手线",
                  f"今日已实现约 ¥{realized:,.0f}，已越过停手线 ¥{stop_line:,.0f}",
                  "停手线是体系的最后防线。今天结束了——关掉软件，亏损不会因为再看一眼而变少")

    daily_max = int(cfg.get("daily_max_trades", 3) or 0)
    if daily_max > 0:
        today_n = sum(1 for t in all_trades
                      if t.get("date") == today and t.get("status") in ("open", "closed"))
        if today_n >= daily_max:
            block("G9", "🌀 日内开仓已达上限",
                  f"今日已开 {today_n} 笔（上限 {daily_max}），这是第 {today_n + 1} 笔",
                  "频繁交易=手续费+情绪双杀。真有机会，明天它还在；没机会，今天开 10 笔也不会有")

    # ---- 盘面类（实时博弈快照）----
    if snap:
        regime = (snap.get("regime") or {}).get("key")
        regime_label = (snap.get("regime") or {}).get("label", "")
        intra = snap.get("intraday") or {}
        cap = snap.get("capital") or {}
        trend = snap.get("trend") or {}
        c15 = intra.get("chg15m") or 0
        pos_pct = intra.get("pos_pct")
        cap5 = cap.get("state5")

        if is_long and (regime in _GATE_BEAR_REGIMES or cap5 == "增仓下行") and c15 <= -0.25:
            block("G1", "🩸 接飞刀",
                  f"{side_txt}，但当前「{regime_label}」、日线资金「{cap5 or '不明'}」，15 分钟 {c15:+.2f}% 仍在急跌",
                  "下跌中接多=接正在下落的兑现盘。等放量止跌与资金方向翻转确认，不赌最低点")
        if not is_long and regime in ("低位恐慌", "低位阴跌") and (pos_pct or 50) <= 15 and c15 <= -0.4:
            block("G1b", "🩸 恐慌末端追空",
                  f"价格已贴日内最低（{pos_pct:.0f}% 分位）且 15 分钟 {c15:+.2f}%——杀跌末端追空易吃 V 型反弹",
                  "恐慌衰竭处不追空；要空等反抽失败再评估")
        if is_long and (trend.get("pct60") or 50) <= 22 and (trend.get("chg20") or 0) <= -3:
            block("G2", "🪞 幻想反弹（深跌抄底）",
                  f"60 日仅 {(trend.get('pct60') or 0):.0f}% 分位、20 日 {(trend.get('chg20') or 0):+.1f}%，深跌区做多=赌 V 型反转",
                  "「跌够了」不是底部理由：底部需要持仓出清+放量反攻确认。左侧即使要做也减半仓+结构位止损")
        if (is_long and cap5 == "增仓下行") or (not is_long and cap5 == "增仓上行"):
            block("G3", "⚡ 逆资金方向而为",
                  f"{side_txt}，但日线资金「{cap5}」——新进场资金在你的对侧",
                  "逆着新钱方向做单=给对手盘送流动性。等资金方向站到同侧，或至少等它停止进攻")
        if is_long and (pos_pct or 50) >= 85 and c15 >= 0.4:
            block("G4", "🔥 追涨（FOMO）",
                  f"价格贴日内高点（{pos_pct:.0f}% 分位）且 15 分钟已涨 {c15:+.2f}%——情绪最热、盈亏比最差的位置",
                  "追在情绪极值处=接力末棒。等回踩确认再进；必须进则减半仓")

    # 亏损加仓（摊平）：同品种同方向已有亏单再加仓——不需要行情快照，只看持仓与现价
    holds = [t for t in all_trades if t.get("status") == "open"
             and t["symbol"] == sym and t["direction"] == trade["direction"]]
    if holds and price:
        sign = 1 if is_long else -1
        losing = [h for h in holds if sign * (float(price) - float(h["entry"])) < 0]
        if losing:
            worst = min(sign * (float(price) - float(h["entry"])) for h in losing)
            block("G6", "📉 亏损加仓（摊平）",
                  f"已持有同方向 {len(losing)} 笔亏单（最差浮亏 {worst:+.1f} 点），此刻加仓=摊平",
                  "摊平是让亏损集中爆发的最快路径：亏单只减不加；加仓等它转盈后按新信号执行")
    return out


@app.post("/api/trades")
async def add_trade(body: TradeIn):
    """记一笔交易（带开仓闸门）：接飞刀/亏损加仓/幻想反弹/逆资金/追涨先拦截——
    返回 blocked=true 与 blockers，前端红色风险确认；force=1 二次确认后放行并留违规标记"""
    if body.direction not in ("long", "short"):
        raise HTTPException(status_code=400, detail="direction 仅支持 long/short")
    symbol = body.symbol.strip().upper()
    trades = _load_trades()
    now_ms = int(datetime.now().timestamp() * 1000)
    trade = {
        "id": f"t{now_ms}",
        "ts": now_ms,
        "date": body.date.strip() or datetime.now().strftime("%Y-%m-%d"),
        "symbol": symbol,
        "direction": body.direction,
        "entry": body.entry,
        "stop_points": body.stop_points,
        "target_points": body.target_points,
        "lots": body.lots,
        "status": "open",
        "exit": None,
        "result_pts": None,
        "closed_ts": None,
        "note": body.note.strip()[:200],
        "trail": _init_trail(body.entry, body.stop_points, body.target_points),
    }
    # 源头闸门：先取实时快照与现价，拦截致命模式
    try:
        snap = await psych_snapshot(symbol)
    except Exception:
        snap = None
    price = None
    try:
        price = (await fetch_quote(symbol)).get("last")
    except Exception:
        pass
    blockers = _entry_gate(trade, snap, price, trades)
    if blockers and not body.force:
        log = _load_gate_log()
        log.append({"ts": now_ms, "symbol": symbol, "direction": body.direction,
                    "entry": body.entry, "codes": [b["code"] for b in blockers],
                    "names": [b["name"] for b in blockers]})
        _save_gate_log(log)
        return {"ok": True, "blocked": True, "blockers": blockers}
    if blockers:
        trade["violation"] = [f"{b['code']} {b['name']}" for b in blockers]
        vi_txt = "；".join(f"{b['name']}——{b['evidence']}" for b in blockers)
        asyncio.create_task(_feishu_push(
            f"🚫 无视闸门强行开仓\n{symbol} {'做多' if body.direction == 'long' else '做空'} "
            f"{body.lots} 手 @ {body.entry}\n拦截原因：{vi_txt[:600]}\n此单后续将由违规成绩单跟踪"))
    trades.append(trade)
    _save_trades(trades)
    # 开仓即检：问题即时返回前端展示
    warnings_list = await _diagnose_trade(trade, snap, price)
    # 当日超限也属于开仓时点问题
    today_n = sum(1 for t in trades if t.get("date") == trade["date"] and t.get("status") in ("open", "closed"))
    daily_max = int(load_config()["discipline"].get("daily_max_trades", 3))
    if today_n > daily_max:
        warnings_list.append(_issue("D05", "fatal", "日内开仓超限",
                                    f"今日已开 {today_n} 笔（上限 {daily_max}）",
                                    "频繁交易=手续费+情绪双杀。这是今日最后一笔。", symbol, trade["id"]))
    asyncio.create_task(_diagnosis_scan(push=True))
    return {"ok": True, "item": trade, "warnings": warnings_list,
            "forced": bool(trade.get("violation")), "blockers": blockers}


class TradePatch(BaseModel):
    exit: Optional[float] = None
    result_pts: Optional[float] = None
    note: Optional[str] = None
    status: Optional[str] = None


@app.post("/api/trades/{trade_id}/review")
async def trade_review_one(trade_id: str):
    """持仓 AI 体检：原计划 + 当前博弈快照 → continue/reduce/exit 判定 + 生死价位 + 执行偏差"""
    t = next((x for x in _load_trades() if x["id"] == trade_id and x.get("status") == "open"), None)
    if not t:
        raise HTTPException(status_code=404, detail="持仓记录不存在（或已平仓）")
    sym = t["symbol"]
    try:
        snap = await psych_snapshot(sym)
    except Exception:
        snap = None
    price = (_quote_cache.get(sym, (0, {}))[1] or {}).get("last")
    if not price:
        try:
            price = (await fetch_quote(sym)).get("last")
        except Exception:
            price = None
    sign = 1 if t["direction"] == "long" else -1
    pnl = round(sign * (float(price) - float(t["entry"])), 1) if price else None
    context = psy.to_context_text(snap) if snap else "（博弈快照暂不可用：数据源异常）"
    prompt = f"""你是反幻想交易教练。对用户当前持仓做一次体检，给出明确的动作指导。

【原计划】
- {sym} {'做多' if t['direction'] == 'long' else '做空'} {t.get('lots', 1)} 手，入场 {t['entry']}，
  止损 {t.get('stop_points') or '未设 ⚠'} 点，目标 {t.get('target_points') or '未设'} 点
- 开仓理由：{t.get('note') or '（无记录）'}
- 现价 {price}，浮动 {pnl:+.1f} 点

【当前博弈快照】
{context}

输出（Markdown，400 字内）：
**判定**：continue（持有）/ reduce（减仓）/ exit（离场），三选一
**依据**：资金方向、位置分位、陷阱结构各一句，引用具体数值
**建议动作**：可执行的具体动作（移损移到哪个价位、减仓减几成、等什么信号）
**生死价位**：跌破/升破哪个具体数字必须无条件离场
**执行偏差**：当前持倧行为与原计划的差距（浮盈后止损未上移/快到目标未处置等；无偏差也要说明）

不迎合：该离场就直说离场。数据缺失明说。结尾注明不构成投资建议。"""
    advice = await _llm_text_retry(prompt, max_tokens=1400)
    m = re.search(r"判定[^\n：:]*[：:]\s*\**\s*(continue|reduce|exit|持有|减仓|离场)", advice)
    if m:
        verdict = {"持有": "continue", "减仓": "reduce", "离场": "exit"}.get(m.group(1), m.group(1))
    else:
        head = advice[:60]
        verdict = "exit" if "exit" in head or "离场" in head else ("reduce" if ("reduce" in head or "减仓" in head) else "continue")
    return {"ok": True, "id": trade_id, "symbol": sym, "price": price,
            "pnl_pts": pnl, "verdict": verdict, "advice": advice, "direction": t["direction"]}


# ---------------------------------------------------------------- 价格预警（生死线的哨兵）

ALERTS_FILE = BASE_DIR / "alerts.json"


def _load_alerts() -> list[dict]:
    if ALERTS_FILE.exists():
        try:
            return json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_alerts(items: list[dict]) -> None:
    try:
        ALERTS_FILE.write_text(json.dumps(items[-50:], ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


async def _check_alerts():
    """盯盘循环内检查：现价触及预警线 → 事件流 + 飞书，一次性触发"""
    alerts = _load_alerts()
    changed = False
    for a in alerts:
        if a.get("fired_ts"):
            continue
        ts_, q = _quote_cache.get(a["symbol"], (0, {}))
        last = (q or {}).get("last")
        if last is None:
            continue
        hit = (a["dir"] == "above" and last >= a["price"]) or (a["dir"] == "below" and last <= a["price"])
        if not hit:
            continue
        a["fired_ts"] = int(datetime.now().timestamp() * 1000)
        changed = True
        arrow = "升破" if a["dir"] == "above" else "跌破"
        note = a.get("note") or ""
        _emit_event({
            "id": f"alert-{a['id']}-{a['fired_ts']}", "ts": a["fired_ts"], "kind": "alert",
            "symbol": a["symbol"], "name": "", "dir": "up" if a["dir"] == "above" else "down",
            "price": last, "text": f"🔔 预警触发：{a['symbol']} {arrow} {a['price']}（现价 {last}）"
                   + (f" · {note}" if note else ""),
            "chg5": 0.0, "chg15": 0.0, "threshold": a["price"], "intl": False, "ai": "",
        }, feishu=True, feishu_text=f"🔔 价格预警触发\n{a['symbol']} {arrow} {a['price']}，现价 {last}\n{note}")
    if changed:
        _save_alerts(alerts)


class AlertIn(BaseModel):
    symbol: str
    price: float
    dir: str = "below"     # above=升破提醒 / below=跌破提醒
    note: str = ""


@app.get("/api/alerts")
async def alerts_get():
    return {"ok": True, "items": [a for a in _load_alerts() if not a.get("fired_ts")][-20:]}


@app.post("/api/alerts")
async def alerts_add(body: AlertIn):
    if body.dir not in ("above", "below"):
        raise HTTPException(status_code=400, detail="dir 仅支持 above/below")
    import uuid
    alerts = _load_alerts()
    now_ms = int(datetime.now().timestamp() * 1000)
    alerts.append({"id": f"a{now_ms}-{uuid.uuid4().hex[:6]}", "ts": now_ms,
                   "symbol": body.symbol.strip().upper(),
                   "price": body.price, "dir": body.dir, "note": body.note.strip()[:80], "fired_ts": None})
    _save_alerts(alerts)
    return {"ok": True}


@app.delete("/api/alerts/{alert_id}")
async def alerts_del(alert_id: str):
    alerts = _load_alerts()
    remain = [a for a in alerts if a["id"] != alert_id]
    if len(remain) == len(alerts):
        raise HTTPException(status_code=404, detail="预警不存在")
    _save_alerts(remain)
    return {"ok": True}


@app.get("/api/shield")
async def shield_status():
    """🛡️ 盾状态：今日拦截/违规、持仓风险敞口、日亏停手线消耗、纪律连胜、活跃预警"""
    trades = _load_trades()
    cfg = load_config()["discipline"]
    today = datetime.now().strftime("%Y-%m-%d")
    acct = float(cfg.get("account_size") or 0)

    def _day_of(ms: int) -> str:
        try:
            return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
        except (TypeError, ValueError, OSError, OverflowError):
            return ""

    blocked_today = sum(1 for g in _load_gate_log() if _day_of(g.get("ts") or 0) == today)
    forced_today = sum(1 for t in trades if t.get("violation") and t.get("date") == today)

    exposure = 0.0
    no_stop_open = 0
    open_n = 0
    for t in trades:
        if t.get("status") != "open":
            continue
        open_n += 1
        m = CONTRACT_MULTIPLIER.get(_variety_prefix(t["symbol"]))
        stop = t.get("stop_points")
        if m and stop:
            exposure += float(stop) * m * float(t.get("lots") or 1)
        else:
            no_stop_open += 1
    exposure_pct = round(exposure / acct * 100, 1) if acct > 0 else None

    stop_used_pct = None
    realized_txt = None
    if acct > 0:
        realized = 0.0
        for t in trades:
            if t.get("date") == today and t.get("status") == "closed" and t.get("result_pts") is not None:
                m = CONTRACT_MULTIPLIER.get(_variety_prefix(t["symbol"]))
                if m:
                    realized += float(t["result_pts"]) * m * float(t.get("lots") or 1)
        line = acct * float(cfg.get("daily_stop", 3.0)) / 100
        realized_txt = f"¥{realized:,.0f} / -¥{line:,.0f}"
        if line > 0:
            stop_used_pct = round(min(100.0, max(0.0, -realized / line * 100)), 0)
    # 连续纪律天数：从今日回溯，无强行违规开仓的日子都算干净（被闸门拦下不断链）
    viol_days = {t.get("date") for t in trades if t.get("violation") and t.get("date")}
    all_dates = sorted(t.get("date") for t in trades if t.get("date"))
    earliest = all_dates[0] if all_dates else None
    streak = 0
    d = datetime.now().date()
    if today in viol_days:
        d -= timedelta(days=1)
    while streak < 999:
        ds = d.strftime("%Y-%m-%d")
        if ds in viol_days or (earliest and ds < earliest):
            break
        streak += 1
        d -= timedelta(days=1)
    return {
        "ok": True, "today": today,
        "blocked_today": blocked_today, "forced_today": forced_today,
        "open_count": open_n, "no_stop_open": no_stop_open,
        "exposure_pct": exposure_pct, "stop_used_pct": stop_used_pct,
        "realized_txt": realized_txt,
        "streak": streak,
        "active_alerts": sum(1 for a in _load_alerts() if not a.get("fired_ts")),
    }


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
            t["note"] = body.note.strip()[:200]
        if body.status:
            if body.status not in ("open", "closed", "abandoned"):
                raise HTTPException(status_code=400, detail="status 仅支持 open/closed/abandoned")
            t["status"] = body.status
        if t.get("result_pts") is not None or t["status"] == "abandoned":
            if t["status"] == "open":
                t["status"] = "closed"
            if not t.get("closed_ts"):
                t["closed_ts"] = int(datetime.now().timestamp() * 1000)
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
    items = list(reversed(_load_trades()))
    # 缓存未命中的持仓品种并行补拉行情（串行最坏 N×0.5s；fetch_quote 自带 5s 缓存回填）
    missing = sorted({t["symbol"] for t in items
                      if t.get("status") == "open"
                      and not (_quote_cache.get(t["symbol"], (0, {}))[1] or {}).get("last")})
    if missing:
        await asyncio.gather(*[fetch_quote(s) for s in missing], return_exceptions=True)
    for t in items:
        if t.get("status") != "open":
            continue
        sym = t["symbol"]
        ts_, q = _quote_cache.get(sym, (0, {}))
        price = (q or {}).get("last")
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
    """复盘统计：总览 + 分品种 + 行为画像（散户病计数）"""
    trades = _load_trades()
    closed = [t for t in trades if t["status"] == "closed" and t.get("result_pts") is not None]

    def _summary(items):
        if not items:
            return {"count": 0}
        pts = [float(t["result_pts"]) for t in items]
        wins = [p for p in pts if p > 0]
        losses = [p for p in pts if p < 0]
        plan_rr = [t["target_points"] / t["stop_points"] for t in items if t.get("stop_points") and t.get("target_points")]
        return {
            "count": len(items),
            "win_rate": round(len(wins) / len(items) * 100, 1),
            "total_pts": round(sum(pts), 1),
            "avg_win": round(sum(wins) / len(wins), 1) if wins else 0,
            "avg_loss": round(sum(losses) / len(losses), 1) if losses else 0,
            "avg_plan_rr": round(sum(plan_rr) / len(plan_rr), 2) if plan_rr else None,
        }

    by_symbol = {}
    for t in closed:
        by_symbol.setdefault(t["symbol"], []).append(t)
    # 行为画像：无止损 / 扛单（穿损后才了结）/ 报复交易 计数
    no_stop = sum(1 for t in trades if not t.get("stop_points"))
    hold_loss = 0
    for t in closed:
        if t.get("stop_points") and t.get("exit"):
            sign = 1 if t["direction"] == "long" else -1
            flt_at_exit = sign * (float(t["exit"]) - float(t["entry"]))
            if flt_at_exit < -float(t["stop_points"]) * 1.1:
                hold_loss += 1
    revenge = 0
    closed_sorted = sorted([t for t in closed if t.get("closed_ts")], key=lambda t: t["closed_ts"])
    for c in reversed(closed_sorted[-10:]):
        if (c.get("result_pts") or 0) >= 0:
            continue
        hit = next((t for t in trades if t.get("ts") and t["ts"] > c["closed_ts"]
                    and t["ts"] - c["closed_ts"] < 30 * 60 * 1000), None)
        if hit:
            revenge += 1
        break
    return {
        "ok": True,
        "overview": _summary(closed),
        "open_count": sum(1 for t in trades if t["status"] == "open"),
        "abandoned_count": sum(1 for t in trades if t["status"] == "abandoned"),
        "by_symbol": {s: _summary(v) for s, v in sorted(by_symbol.items())},
        "behavior": {"no_stop": no_stop, "held_thru_stop": hold_loss, "revenge": revenge,
                     "forced": sum(1 for t in trades if t.get("violation")),
                     "blocked": len(_load_gate_log())},
    }


@app.get("/api/discipline/config")
async def discipline_config_get():
    return {"ok": True, "discipline": load_config()["discipline"]}


# ---------------------------------------------------------------- 散户缺陷画像（真实交易数据驱动）

def _flaw_profile() -> list[dict]:
    """从真实交易记录检测该交易者的散户缺陷：每项含证据与解药（纪律规则），按严重度排序。
    只用已存字段（不需要行情回放），随时可算。样本 <3 笔时返回空——不拿两笔交易给人贴标签。"""
    trades = _load_trades()
    closed = [t for t in trades if t.get("status") == "closed" and t.get("result_pts") is not None]
    if len(closed) < 3 and len(trades) < 3:
        return []
    cfg = load_config()["discipline"]
    flaws: list[dict] = []

    def add(name: str, count: int, total: int, evidence: str, antidote: str, weight: float = 1.0):
        if count <= 0 or total <= 0:
            return
        rate = count / total
        flaws.append({
            "name": name, "count": count, "rate": round(rate * 100),
            "severity": min(100, int(rate * 100 * weight)),
            "evidence": evidence, "antidote": antidote,
        })

    # 1 无止损：把亏损控制权交给对手盘
    no_stop = sum(1 for t in trades if not t.get("stop_points"))
    add("无止损开仓", no_stop, len(trades), f"{no_stop}/{len(trades)} 笔未设止损",
        "开仓即挂硬止损（结构位之外），单笔风险 ≤ 账户 1%")

    # 2 穿损扛单：止损形同虚设
    held = sum(
        1 for t in closed if t.get("stop_points") and t.get("exit")
        and (1 if t["direction"] == "long" else -1) * (float(t["exit"]) - float(t["entry"]))
        < -float(t["stop_points"]) * 1.1
    )
    add("穿损扛单", held, len(closed), f"{held}/{len(closed)} 笔超过止损 10% 才离场",
        "止损是保险不是建议：触发即离场，「等回本」的代价是主动权持续流失", weight=1.2)

    # 3 持亏砍盈（处置效应）：亏损单比盈利单拿得久
    wins_h = [t["hold_min"] for t in closed if float(t["result_pts"]) > 0 and t.get("hold_min") is not None]
    loss_h = [t["hold_min"] for t in closed if float(t["result_pts"]) < 0 and t.get("hold_min") is not None]
    if wins_h and loss_h and sum(loss_h) / len(loss_h) > sum(wins_h) / len(wins_h) * 1.3:
        add("持亏砍盈（处置效应）", len(loss_h), len(closed),
            f"亏损单平均持 {sum(loss_h) / len(loss_h):.0f} 分钟 vs 盈利单 {sum(wins_h) / len(wins_h):.0f} 分钟",
            "规则对调：盈利单按计划走到目标（浮盈回撤过半才走），亏损单到止损无条件走")

    # 4 盈亏比倒挂：赚小赔大
    wins = [float(t["result_pts"]) for t in closed if float(t["result_pts"]) > 0]
    losses = [float(t["result_pts"]) for t in closed if float(t["result_pts"]) < 0]
    if wins and losses and sum(wins) / len(wins) < abs(sum(losses) / len(losses)) * 0.7:
        add("盈亏比倒挂", len(losses), len(closed),
            f"平均盈利 {sum(wins) / len(wins):+.0f} 点 vs 平均亏损 {sum(losses) / len(losses):+.0f} 点",
            "截断亏损、让利润奔跑——两者规则不能对称")

    # 5 报复性交易：亏损了结后 30 分钟内再开仓
    seq = sorted(closed, key=lambda t: t.get("closed_ts") or 0)
    revenge = sum(
        1 for i, t in enumerate(seq[:-1])
        if float(t["result_pts"]) < 0 and t.get("closed_ts")
        and (seq[i + 1].get("ts") or 0) and 0 < seq[i + 1]["ts"] - t["closed_ts"] < 30 * 60 * 1000
    )
    add("报复性交易", revenge, len(seq), f"{revenge} 次亏损平仓后 30 分钟内立即开新仓",
        "亏损后的第一冲动是情绪不是机会：强制冷静期 30 分钟内不开仓", weight=1.2)

    # 6 频繁交易：超过日内开仓上限的天数
    from collections import Counter
    daily_max = int(cfg.get("daily_max_trades", 3))
    by_day = Counter(t.get("date") for t in trades if t.get("date"))
    over_days = {d: c for d, c in by_day.items() if c > daily_max}
    add("频繁交易", len(over_days), max(len(by_day), 1),
        (f"{len(over_days)}/{len(by_day)} 个交易日超过 {daily_max} 笔上限"
         + (f"（最猛的一天 {max(over_days.values())} 笔）" if over_days else "")),
        "频率是手续费+情绪双杀：当日达到上限即停止开新仓")

    # 7 连胜后加仓（过度自信）
    streak_add = sum(
        1 for i in range(2, len(seq))
        if all(float(seq[j]["result_pts"]) > 0 for j in range(i - 2, i))
        and float(seq[i].get("lots") or 1) > float(seq[i - 1].get("lots") or 1)
    )
    add("连胜后加仓（过度自信）", streak_add, max(len(seq) - 2, 1),
        f"{streak_add} 次两连胜后立即加大手数",
        "仓位由风险预算决定，与连胜次数和心情无关")

    # 8 无视拦截强行开仓：闸门拦下仍 force 通过——最硬的纪律失效证据
    forced = [t for t in trades if t.get("violation")]
    add("无视拦截强行开仓", len(forced), len(trades),
        f"{len(forced)}/{len(trades)} 笔在风险闸门警告后仍强行开仓"
        + (f"（最近：{'、'.join(t['violation'][0] for t in forced[-2:])}）" if forced else ""),
        "闸门拦的是统计上最亏钱的入场模式；每次强行通过都是在为「我知道我在干什么」的幻觉付费",
        weight=1.3)

    flaws.sort(key=lambda f: -f["severity"])
    return flaws[:8]


def _flaw_context() -> str:
    """缺陷画像注入块（AI 上下文用）"""
    flaws = _flaw_profile()
    blocked = len(_load_gate_log())
    if not flaws and not blocked:
        return ""
    lines = [f"- {f['name']}（严重度 {f['severity']}/100）：{f['evidence']}；解药：{f['antidote']}" for f in flaws]
    head = "【该交易者的散户缺陷画像（由其真实交易记录判定；分析与建议必须优先针对这些缺陷）】"
    if blocked:
        lines.append(f"- 🛡️ 闸门拦截战果：{blocked} 次开仓尝试被拦下后放弃（正面信号——拦下的都是统计上最亏钱的模式，值得肯定）")
    if not flaws:
        return head + "\n" + lines[-1]
    return head + "\n" + "\n".join(lines)


@app.get("/api/flaw-profile")
async def flaw_profile_api():
    return {"ok": True, "flaws": _flaw_profile(), "blocked_count": len(_load_gate_log())}


@app.post("/api/discipline/config")
async def discipline_config_post(body: dict):
    cfg = load_config()
    d = cfg["discipline"]
    for k in ("account_size", "risk_per_trade", "daily_stop", "cooling_min"):
        if k in body and isinstance(body[k], (int, float)):
            d[k] = float(body[k])
    for k in ("daily_max_trades",):
        if k in body and isinstance(body[k], (int, float)):
            d[k] = int(body[k])
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
    return {"ok": True, "items": list(reversed(_load_notes()))}


class NoteIn(BaseModel):
    title: str = ""
    content: str
    symbol: Optional[str] = None
    tags: str = ""
    date: str = ""


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
        "synced": False,
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


class AiReviewIn(BaseModel):
    chats: list[dict] = []
    notes: list[dict] = []
    symbols: list[str] = []
    since: str = ""
    until: str = ""


def _clip_txt(s, n: int) -> str:
    s = str(s or "").strip().replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


@app.post("/api/ai/review")
async def ai_review(body: AiReviewIn):
    """AI 复盘：对话存档 + 心得 + 交易记录 → 行为模式分析"""
    chats = [c for c in (body.chats or []) if str(c.get("content", "")).strip()][:60]
    notes = [n for n in (body.notes or []) if str(n.get("content", "")).strip()][:50]
    trades = _load_trades()
    if not chats and not notes and not trades:
        raise HTTPException(status_code=400, detail="所选范围内没有可分析的记录")

    parts = []
    scope = f"（品种：{'、'.join(body.symbols) if body.symbols else '全部'}；时间：{body.since or '最早'} ~ {body.until or '今天'}）"
    if trades:
        lines = []
        for t in trades[-40:]:
            note_txt = f" 备注：{t.get('note', '')[:40]}" if t.get("note") else ""
            res = f"{float(t['result_pts']):+.0f}点" if t.get("result_pts") is not None else "持仓中"
            lines.append(
                f"- [{t.get('date', '')}] {t['symbol']} {'多' if t['direction'] == 'long' else '空'} "
                f"{t.get('lots', 1)}手 @ {t['entry']} 止损{t.get('stop_points') or '无'} 目标{t.get('target_points') or '无'}"
                f" → {res}{note_txt}"
            )
        parts.append(f"【交易记录 {len(trades)} 笔】（客观行为，最硬的证据）\n" + "\n".join(lines))
    if notes:
        lines = [
            f"- [{n.get('date', '')}]{('[' + str(n['symbol']) + ']') if n.get('symbol') else ''}"
            f"{_clip_txt(n.get('title', ''), 30)}：{_clip_txt(n.get('content', ''), 220)}"
            for n in notes
        ]
        parts.append(f"【交易心得 {len(notes)} 条】（用户自己的判断与反思）\n" + "\n".join(lines))
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
                         f"{_clip_txt(c.get('content', ''), 100 if ask else 300)}")
        parts.append(f"【AI 对话 {len(chats)} 条】\n" + "\n".join(lines))

    prompt = f"""以下是这位期货交易者的存档{scope}。请基于且仅基于这些内容，从「散户心理与行为模式」角度生成复盘报告：

一、行为模式画像：交易记录体现的典型散户行为（追涨杀跌/抄底扛单/频繁交易/报复性交易/无止损），逐条用记录举证
二、幻想清单：心得与提问中暴露的幻想（抄底幻想/回本幻想/重仓暴富/预测执念），它们各付出了什么代价
三、做对的事：存档中值得保留的行为，明确肯定
四、重复性问题：反复出现的错误
五、改进建议：3~5 条可执行建议，逐条对应上述发现

用中文输出 Markdown（## 分节），关键论断引用存档原句；信息不足时如实说明，不编造。

""" + "\n\n".join(parts)
    report = await _llm_text_retry(prompt, max_tokens=2400)
    return {"ok": True, "report": report, "stats": {"chats": len(chats), "notes": len(notes), "trades": len(trades)}}


class ReviewSaveIn(BaseModel):
    report: str
    since: str = ""
    until: str = ""
    symbols: list[str] = []
    stats: dict = {}


@app.post("/api/ai/review-save")
async def ai_review_save(body: ReviewSaveIn):
    """把复盘报告追加到飞书《AI 复盘报告》文档"""
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
        f" · 交易 {st.get('trades', 0)} 笔 + 心得 {st.get('notes', 0)} 条 + 对话 {st.get('chats', 0)} 条\n"
    )
    await _feishu_append(doc_id, _md_to_feishu_blocks(head + body.report))
    return {"ok": True}


# ---------------------------------------------------------------- 历史交易 AI 复盘（真实交割数据）

# ---------------------------------------------------------------- 历史交易盘面回放（入场快照 + MFE/MAE）

async def _daily_bars_for(symbol: str) -> list[dict]:
    """get_daily 标准化为升序日线（date/high/low/close/oi），失败返回空"""
    try:
        rows = await get_daily(symbol)
    except Exception:
        return []
    bars = []
    for r in rows:
        d = str(r.get("date") or r.get("datetime") or "")[:10]
        try:
            bar = {
                "date": d,
                "high": float(r.get("high") or 0), "low": float(r.get("low") or 0),
                "close": float(r.get("close") or 0), "oi": float(r.get("hold") or r.get("position") or 0),
            }
        except (TypeError, ValueError):
            continue
        if d and bar["close"] > 0:
            bars.append(bar)
    bars.sort(key=lambda b: b["date"])
    return bars


def _trade_day_idx(ts_ms: int, bars: list[dict]) -> int:
    """成交时间 → 所属交易日索引。夜盘（20 点后成交）归属下一根日线；非交易日找下一交易日"""
    if not ts_ms:
        return -1
    try:
        dt = datetime.fromtimestamp(ts_ms / 1000)
    except (TypeError, ValueError, OSError, OverflowError):
        return -1
    d = dt.strftime("%Y-%m-%d")
    idx = next((i for i, b in enumerate(bars) if b["date"] == d), -1)
    if idx < 0:
        return next((i for i, b in enumerate(bars) if b["date"] > d), -1)
    if dt.hour >= 20 and idx + 1 < len(bars):
        return idx + 1
    return idx


def _replay_tag(t: dict, bars: list[dict], mbars: Optional[list] = None) -> tuple[str, dict]:
    """单笔交易盘面回放：返回 (标注文本, 行为标签字典)。日线不足返回 ("", {})。
    mbars=15 分钟线 (ms, high, low) 升序列表——覆盖持有窗口时 MFE/MAE 用日内精度。"""
    if len(bars) < 25:
        return "", {}
    ei = _trade_day_idx(t.get("ts") or 0, bars)
    if ei < 20:
        return "", {}
    entry = float(t["entry"])
    sign = 1 if t["direction"] == "long" else -1
    is_long = t["direction"] == "long"

    # 合约口径校验：具体月份合约价格与主连日线背离（换月期/非主力成交）时回放无意义，宁缺毋滥
    b_check = bars[ei]
    if not (b_check["low"] * 0.9 <= entry <= b_check["high"] * 1.1):
        return "", {}

    win60 = bars[max(0, ei - 59):ei + 1]
    hi60 = max(b["high"] for b in win60)
    lo60 = min(b["low"] for b in win60)
    pos60 = (entry - lo60) / (hi60 - lo60) * 100 if hi60 > lo60 else 50.0
    ma20 = sum(b["close"] for b in bars[ei - 19:ei + 1]) / 20
    dev20 = (entry - ma20) / ma20 * 100

    b0, prev, b5 = bars[ei], bars[ei - 1], bars[ei - 5]
    rng = b0["high"] - b0["low"]
    day_pos = (entry - b0["low"]) / rng if rng > 0 else 0.5
    day_chg = (b0["close"] - prev["close"]) / prev["close"] * 100 if prev["close"] else 0
    oi5 = (b0["oi"] - b5["oi"]) / b5["oi"] * 100 if b5["oi"] else 0
    px5 = (b0["close"] - b5["close"]) / b5["close"] * 100 if b5["close"] else 0
    cap_tag = ("增仓" if oi5 > 1 else "减仓" if oi5 < -1 else "仓平") + \
              ("上行" if px5 > 0.5 else "下行" if px5 < -0.5 else "横盘")

    flags = {"chase": False, "counter_trend": False, "mfe_capture": None, "mae": None, "exit_early": False}
    if is_long and day_pos >= 0.78 and day_chg > 0.3:
        flags["chase"] = True
    if not is_long and day_pos <= 0.22 and day_chg < -0.3:
        flags["chase"] = True
    if (is_long and px5 < -0.5 and pos60 < 35) or (not is_long and px5 > 0.5 and pos60 > 65):
        flags["counter_trend"] = True
    against = (is_long and cap_tag in ("增仓下行", "减仓下行")) or (not is_long and cap_tag in ("增仓上行", "减仓上行"))

    tags = []
    if flags["chase"]:
        tags.append("追涨杀跌位")
    if flags["counter_trend"]:
        tags.append("逆势抄底摸顶")
    if against:
        tags.append("逆5日资金")
    # 展示口径：区间位置夹在 0-100（区间外无百分比意义）；浮盈/浮亏极值越界侧显示"无"
    head = (f"60日{max(0.0, min(100.0, pos60)):.0f}%分位 距MA20{dev20:+.1f}% "
            f"5日{cap_tag} 当日区间{max(0.0, min(100.0, day_pos)) * 100:.0f}%")
    if tags:
        head += "⚠" + "/".join(tags)

    tail = ""
    exit_ts = t.get("closed_ts") or 0
    xi = _trade_day_idx(exit_ts, bars) if exit_ts else ei
    if xi >= ei:
        # MFE/MAE 按方向取价：多头看最高/最低，空头看最低/最高（方向反了会把浮盈浮亏互换）。
        # 15 分钟线完整覆盖持有窗口时用日内精度，否则回退日线近似。
        mfe = mae = None
        prec = ""
        e_ms = t.get("ts") or 0
        if mbars and e_ms and exit_ts and mbars[0][0] <= e_ms and mbars[-1][0] >= exit_ts:
            seg_m = [b for b in mbars if e_ms <= b[0] <= exit_ts]
            if len(seg_m) >= 2:
                if sign > 0:
                    mfe = max(b[1] for b in seg_m) - entry
                    mae = min(b[2] for b in seg_m) - entry
                else:
                    mfe = entry - min(b[2] for b in seg_m)
                    mae = entry - max(b[1] for b in seg_m)
                prec = "（15分钟精度）"
        if mfe is None:
            seg = bars[ei:xi + 1]
            if sign > 0:
                mfe = max(b["high"] for b in seg) - entry
                mae = min(b["low"] for b in seg) - entry
            else:
                mfe = entry - min(b["low"] for b in seg)
                mae = entry - max(b["high"] for b in seg)
        flags["mfe_capture"] = None
        flags["mae"] = mae
        res = float(t["result_pts"]) if t.get("result_pts") is not None else 0.0
        if mfe > 1e-9:
            flags["mfe_capture"] = res / mfe
        # 拿早判定：盈利单只兑现小半浮盈，且出场后 3 根日线继续朝有利方向走
        post = bars[xi + 1:xi + 4]
        if flags["mfe_capture"] is not None and 0 < flags["mfe_capture"] < 0.5 and post and t.get("exit"):
            drift = sign * (post[-1]["close"] - float(t["exit"])) / float(t["exit"]) * 100
            flags["exit_early"] = drift > 0.5
        cap_txt = f"（兑现{flags['mfe_capture'] * 100:.0f}%）" if flags["mfe_capture"] is not None and res > 0 else ""
        mfe_txt = f"{mfe:+.0f}" if mfe > 1e-9 else "无"
        mae_txt = f"{mae:+.0f}" if mae < -1e-9 else "无"
        tail = f" | 持有期浮盈极值{mfe_txt} 浮亏极值{mae_txt}{cap_txt}{prec}"
    return f" [{head}{tail}]", flags


def _replay_summary(flag_list: list[dict]) -> list[str]:
    """回放标签聚合 → 统计行"""
    if not flag_list:
        return []
    n = len(flag_list)
    chase = sum(1 for f in flag_list if f["chase"])
    counter = sum(1 for f in flag_list if f["counter_trend"])
    caps = [f["mfe_capture"] for f in flag_list if f["mfe_capture"] is not None and f["mfe_capture"] > 0]
    maes = [f["mae"] for f in flag_list if f["mae"] is not None and f["mae"] < 0]
    early = sum(1 for f in flag_list if f["exit_early"])
    lines = []
    if chase or counter:
        lines.append(f"- 入场质量：追涨杀跌位 {chase}/{n} 笔、逆势抄底摸顶 {counter}/{n} 笔（对照当日区间位置与 5 日趋势自动判定）")
    if caps:
        lines.append(f"- 盈利单浮盈兑现率平均 {sum(caps) / len(caps) * 100:.0f}%（实际结果 ÷ 持有期最大浮盈；低=该赚的没赚到）")
    if maes:
        avg_mae = sum(maes) / len(maes)
        lines.append(f"- 持有期最大浮亏平均 {avg_mae:+.0f} 点（入场到出场承受过的最深浮亏=实际扛单深度）")
    if early:
        lines.append(f"- 疑似拿早 {early} 笔（盈利单兑现不足一半且出场后继续朝有利方向走）")
    return lines


class TradeReviewIn(BaseModel):
    days: int = 90      # 0 = 全部历史
    symbols: list[str] = []


@app.post("/api/ai/trade-review")
async def ai_trade_review(body: TradeReviewIn):
    """真实交易历史复盘：聚合统计 + 逐笔明细 → 反幻想教练视角的行为模式报告"""
    trades = _load_trades()
    closed = [t for t in trades if t.get("status") == "closed" and t.get("result_pts") is not None]
    if body.days > 0:
        cutoff = (datetime.now() - timedelta(days=body.days)).strftime("%Y-%m-%d")
        closed = [t for t in closed if (t.get("date") or "") >= cutoff]
    if body.symbols:
        want = {s.upper() for s in body.symbols}
        closed = [t for t in closed if t["symbol"].upper() in want]
    if len(closed) < 3:
        raise HTTPException(status_code=400, detail=f"样本太少（{len(closed)} 笔已平仓，至少 3 笔才能复盘）——先在「📥 导入交割单」里导入历史数据")
    closed.sort(key=lambda t: (t.get("closed_ts") or t.get("ts") or 0))

    pts = [float(t["result_pts"]) for t in closed]
    wins = [p for p in pts if p > 0]
    losses = [p for p in pts if p < 0]
    gross_win, gross_loss = sum(wins), abs(sum(losses))
    # 最长连亏
    max_lose_streak = cur = 0
    for p in pts:
        cur = cur + 1 if p < 0 else 0
        max_lose_streak = max(max_lose_streak, cur)
    # 方向偏好
    longs = [t for t in closed if t["direction"] == "long"]
    shorts = [t for t in closed if t["direction"] == "short"]
    # 品种分布
    by_sym: dict[str, list] = {}
    for t in closed:
        by_sym.setdefault(t["symbol"], []).append(float(t["result_pts"]))
    sym_rows = sorted(by_sym.items(), key=lambda kv: -abs(sum(kv[1])))[:8]
    # 持仓时长（仅导入数据有 hold_min）：盈利单 vs 亏损单平均持时（持亏砍盈的硬证据）
    hw = [t["hold_min"] for t in closed if t.get("hold_min") is not None and t["result_pts"] > 0]
    hl = [t["hold_min"] for t in closed if t.get("hold_min") is not None and t["result_pts"] < 0]
    # 报复交易 proxy：亏损平仓后 30 分钟内再开仓
    revenge = 0
    for i, t in enumerate(closed[:-1]):
        if float(t["result_pts"]) >= 0 or not t.get("closed_ts"):
            continue
        nxt = closed[i + 1]
        if (nxt.get("ts") or 0) and 0 < nxt["ts"] - t["closed_ts"] < 30 * 60 * 1000:
            revenge += 1
    fees_total = round(sum(float(t.get("fees") or 0) for t in closed), 2)

    avg_win_s = f"{sum(wins) / len(wins):+.0f}" if wins else "无"
    avg_loss_s = f"{sum(losses) / len(losses):+.0f}" if losses else "无"
    stat_lines = [
        f"- 已平仓 {len(closed)} 笔：胜率 {len(wins) / len(closed) * 100:.0f}%"
        f"（盈 {len(wins)} / 亏 {len(losses)}），累计 {sum(pts):+.0f} 点，手续费 ¥{fees_total:,.0f}",
        f"- 平均盈利 {avg_win_s} 点 vs 平均亏损 {avg_loss_s} 点"
        f"（盈亏比 {(gross_win / gross_loss) if gross_loss else float('inf'):.2f}）",
        f"- 最大单笔亏损 {min(pts):+.0f} 点；最长连亏 {max_lose_streak} 笔；最大单笔盈利 {max(pts):+.0f} 点",
        f"- 方向偏好：多单 {len(longs)} 笔 {sum(float(t['result_pts']) for t in longs):+.0f} 点 / "
        f"空单 {len(shorts)} 笔 {sum(float(t['result_pts']) for t in shorts):+.0f} 点",
    ]
    if hw and hl:
        stat_lines.append(
            f"- 持仓时长：盈利单平均 {sum(hw) / len(hw):.0f} 分钟 vs 亏损单平均 {sum(hl) / len(hl):.0f} 分钟"
            f"（亏损单拿得比盈利单久 = 处置效应实锤）" if sum(hl) / len(hl) > sum(hw) / len(hw) else
            f"- 持仓时长：盈利单平均 {sum(hw) / len(hw):.0f} 分钟 vs 亏损单平均 {sum(hl) / len(hl):.0f} 分钟")
    if revenge:
        stat_lines.append(f"- 亏损平仓后 30 分钟内再开仓：{revenge} 次（报复性交易嫌疑）")
    if sym_rows:
        stat_lines.append("分品种（累计点数）："
                          + "、".join(f"{s} {sum(v):+.0f}点/{len(v)}笔" for s, v in sym_rows))

    # 违规单 vs 正常单绩效对比（强行通过闸门的单，成绩单不会说谎）
    forced_closed = [t for t in closed if t.get("violation")]
    if forced_closed:
        def _mini(items: list) -> str:
            if not items:
                return "0 笔"
            pts_ = [float(t["result_pts"]) for t in items]
            wins_ = [p for p in pts_ if p > 0]
            return f"{len(items)} 笔、胜率 {len(wins_) / len(items) * 100:.0f}%、累计 {sum(pts_):+.0f} 点"
        stat_lines.append(f"- 🚫 违规对比：强行通过闸门的单 {_mini(forced_closed)} vs 听劝的正常单 "
                          f"{_mini([t for t in closed if not t.get('violation')])}")

    # 盘面回放：预载涉及品种的日线（V8 队列串行，但每品种 30 分钟缓存，只拉一次）
    # 与 15 分钟线（约 2 个月覆盖——持有窗口在其内的交易 MFE/MAE 用日内精度）
    symbols_involved = sorted({t["symbol"] for t in closed})
    bars_map, m15_map = {}, {}
    for s in symbols_involved:
        bars_map[s] = await _daily_bars_for(s)
        try:
            mrows = await get_minute(s, "15")
        except Exception:
            mrows = []
        idx = []
        for r in mrows:
            try:
                ms = int(datetime.fromisoformat(str(r["datetime"])).timestamp() * 1000)
                hi_, lo_ = float(r.get("high") or 0), float(r.get("low") or 0)
                if hi_ > 0 and lo_ > 0:
                    idx.append((ms, hi_, lo_))
            except (TypeError, ValueError, OSError, OverflowError):
                continue
        m15_map[s] = idx

    detail = []
    flag_list = []
    for t in closed[-40:]:
        hold = f"（持时{t['hold_min']}分）" if t.get("hold_min") is not None else ""
        contract = f"({t['contract']})" if t.get("contract") else ""
        viol = " 🚫强行" if t.get("violation") else ""
        tag, flags = _replay_tag(t, bars_map.get(t["symbol"], []), m15_map.get(t["symbol"]))
        if flags:
            flag_list.append(flags)
        detail.append(
            f"- {t.get('date', '')} {t['symbol']}{contract} "
            f"{'多' if t['direction'] == 'long' else '空'} {t.get('lots', 1)}手 "
            f"{t['entry']}→{t.get('exit')}{hold} {float(t['result_pts']):+.0f}点{viol}{tag}"
        )
    stat_lines.extend(_replay_summary(flag_list))

    holds_open = [t for t in _load_trades() if t.get("status") == "open"]
    hold_lines = [
        f"- {t.get('date', '')} {t['symbol']} {'多' if t['direction'] == 'long' else '空'} "
        f"{t.get('lots', 1)}手 @ {t['entry']}"
        + (f"（止损 {'未设 ⚠' if not t.get('stop_points') else t['stop_points'] + ' 点'}）")
        for t in holds_open[:8]
    ]

    scope = f"近 {body.days} 天" if body.days > 0 else "全部历史"
    if body.symbols:
        scope += f"·品种 {'、'.join(body.symbols)}"

    prompt = f"""以下是这位期货散户交易者的真实交割数据复盘范围（{scope}）。数据来自期货公司结算单导入，是客观事实（手记记录可能混入，标注里带「交割单导入」的为真实成交）。

【汇总统计】
{chr(10).join(stat_lines)}

【逐笔明细】（最多最近 40 笔。每笔末尾 [ ] 内为**入场时刻盘面回放**：60 日分位/距 MA20/5 日资金状态/当日区间位置（⚠行为标签：追涨杀跌位/逆势抄底摸顶/逆5日资金），以及持有期最大浮盈/浮亏与浮盈兑现率——日线粒度近似，夜盘成交归属下一交易日）
{chr(10).join(detail)}

【当前持仓】
{chr(10).join(hold_lines) if hold_lines else "无持仓"}

请以反幻想交易教练视角生成历史交易复盘报告（Markdown，## 分节，1000 字内）：

一、行为模式画像：用具体交易举证——追涨杀跌/抄底扛单/频繁交易/报复性交易/持亏砍盈；哪个品种、哪个方向在反复送钱（用分品种统计说话）。盈亏比与持仓时长对比（盈利单 vs 亏损单）是处置效应的硬证据，有数据必须引用。
二、决策质量审计（盘面回放）：入场快照的 ⚠ 标签逐类清算——追涨杀跌位入场几笔？逆 5 日资金方向开仓几笔、这些单的结果如何？逆势抄底摸顶的单付出了什么代价？浮盈兑现率低+拿早判定=该赚的没赚到，持有期浮亏极值深=实际扛单深度远超表面止损。
三、人性定律归因：每条行为模式点名支配它的人性定律（损失厌恶/处置效应/锚定/近因外推/踏空焦虑/公平世界幻觉/确认偏误/控制幻觉）。
四、做对的事：数据能支撑的肯定（顺资金方向的单、拿住的高兑现单、有纪律的离场）。
五、改进建议：3~5 条可执行建议，逐条对应上述发现，给具体数字标准（如"只顺 5 日资金方向开仓"、"浮盈回撤过半即离场"）。

要求：所有论断引用具体数值与日期；数据缺失明说；不编造。结尾注明不构成投资建议。"""

    report = await _llm_text_retry(prompt, max_tokens=2800)
    return {
        "ok": True, "report": report,
        "stats": {"trades": len(closed), "days": body.days, "symbols": body.symbols,
                  "win_rate": round(len(wins) / len(closed) * 100, 1), "total_pts": round(sum(pts), 1)},
    }


# ---------------------------------------------------------------- 飞书

FEISHU_BASE = "https://open.feishu.cn/open-apis"
_feishu_token = {"token": "", "expire_at": 0.0}


async def _feishu_push(text: str) -> bool:
    """飞书群机器人 webhook 推送（未配置时静默跳过）"""
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
        raise HTTPException(status_code=400, detail="未配置飞书应用凭证（App ID / App Secret）")
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
    """极简 Markdown -> 飞书 docx 块"""
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
        r = await client.post(
            f"{FEISHU_BASE}/docx/v1/documents/{doc_id}/blocks/{doc_id}/children",
            headers={"Authorization": f"Bearer {token}"},
            json={"children": blocks[:90]},
        )
    data = r.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=502, detail=f"飞书写入失败：{data.get('msg')}")


async def _feishu_ensure_doc() -> str:
    """获取配置的文档 ID；没有则创建《期货交易心得》文档"""
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
    cfg = load_config()
    cfg.setdefault("feishu", {})
    cfg["feishu"]["doc_id"] = doc_id
    save_config(cfg)
    return doc_id


async def _feishu_review_doc_id():
    """确保《AI 复盘报告》文档存在；失败返回 None"""
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
            cfg = load_config()
            cfg.setdefault("feishu", {})["review_doc_id"] = doc_id
            save_config(cfg)
    except Exception as e:
        logging.getLogger("uvicorn.error").info(f"[review-save] 创建文档异常：{type(e).__name__} {e}")
    return doc_id or None


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
    """确保《AI 对话记录》文档存在；失败返回 None"""
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
        if data.get("code") == 0 and data.get("data", {}).get("document"):
            doc_id = data["data"]["document"]["document_id"]
            cfg = load_config()
            cfg.setdefault("feishu", {})["chat_doc_id"] = doc_id
            save_config(cfg)
    except Exception as e:
        logging.getLogger("uvicorn.error").info(f"[chat-export] 创建文档异常：{type(e).__name__} {e}")
    if not doc_id:
        doc_id = await _feishu_ensure_doc()
    return doc_id or None


async def _feishu_log_chat_round(symbol, question: str, answer: str):
    """每轮 AI 对话自动追加到飞书文档；失败静默"""
    import logging
    try:
        doc_id = await _feishu_chat_doc_id()
        if not doc_id:
            return
        name = ""
        if symbol:
            try:
                name = (await get_directory(max_age=3600)).get(symbol, {}).get("name", "")
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
    cfg = load_config()
    fs = cfg.get("feishu") or {}
    if not fs.get("app_id") or not fs.get("app_secret"):
        raise HTTPException(status_code=400, detail="未配置飞书应用凭证")
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
    notes = _load_notes()
    targets = [n for n in notes if n["id"] == note_id] if note_id else \
              [n for n in notes if not n.get("synced")]
    if not targets:
        return {"ok": True, "synced": 0, "msg": "没有待同步的心得"}
    doc_id = await _feishu_ensure_doc()
    blocks = []
    for n in targets:
        blocks.extend(_md_to_feishu_blocks(_note_to_md(n)))
    try:
        await _feishu_append(doc_id, blocks)
    except HTTPException as e:
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
    fresh = _load_notes()
    for n in fresh:
        if n["id"] in ids:
            n["synced"] = True
    _save_notes(fresh)
    return {"ok": True, "synced": len(targets), "doc_id": doc_id}


class FeishuCfgIn(BaseModel):
    app_id: str = ""
    app_secret: str = ""
    doc_title: str = "期货交易心得"
    webhook_url: str = ""
    clear: bool = False


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
    if body.app_id.strip() or body.app_secret.strip():
        fs.pop("doc_id", None)
    save_config(cfg)
    return {"ok": True}


@app.post("/api/feishu/push-test")
async def feishu_push_test():
    ok = await _feishu_push("✅ 心理博弈助手推送测试：配置成功，预警与晨报将推送到本群。")
    if not ok:
        cfg = load_config()
        if not (cfg.get("feishu") or {}).get("webhook_url"):
            raise HTTPException(status_code=400, detail="未配置 webhook URL")
        raise HTTPException(status_code=502, detail="推送失败，请检查 webhook 地址与群机器人设置")
    return {"ok": True}


# ---------------------------------------------------------------- 交易者画像

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
        lines.append(f"体系规则 {r.get('id', '')}（必须遵守）：{r.get('rule', '')}")
        if r.get("reason"):
            lines.append(f"  原因：{r['reason'][:80]}")
    if not lines:
        return ""
    return "\n【交易者画像（AI 记忆，分析时个性化适配）】\n" + "\n".join(lines)


def _position_context() -> str:
    trades = _load_trades()
    open_trades = [t for t in trades if t["status"] == "open"]
    recent_closed = [t for t in trades if t["status"] == "closed" and t.get("result_pts") is not None][-5:]
    if not open_trades and not recent_closed:
        return ""
    lines = []
    if open_trades:
        lines.append("当前持仓（分析时请注意：持仓会让人产生确认偏误，请主动挑战持仓方向）：")
        for t in open_trades:
            d = "多" if t["direction"] == "long" else "空"
            lines.append(
                f"  {t['symbol']} {d} {t.get('lots', 1)}手 @{t['entry']}，"
                f"止损 {t.get('stop_points') or '未设'}点 目标 {t.get('target_points') or '未设'}点（{t['date']}开仓）"
            )
    if recent_closed:
        pts = [float(t["result_pts"]) for t in recent_closed]
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


# ---------------------------------------------------------------- 晨/夜报（心理博弈简报）

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
    """晨/夜报：自选品种博弈快照 + 持仓诊断 + 外盘锚 → AI 反幻想简报"""
    parts = []
    syms = sorted(set(_MONITOR["watch"]) | {"SC0", "AU0"})[:8]
    lines = []
    for s in syms:
        try:
            snap = await psych_snapshot(s)
        except Exception:
            continue
        r = snap["parties"]["retail"]
        lines.append(
            f"- {s}（{snap.get('name', '')}）：{snap['regime']['label']}，"
            f"{snap['last']}（{snap.get('change_pct'):+.2f}%），"
            f"日线资金「{snap['capital'].get('state5') or '数据不足'}」，"
            f"散户陷阱指数 {r['trap_risk']}/100"
        )
    if lines:
        parts.append("【自选品种博弈快照】\n" + "\n".join(lines))

    # 持仓与诊断
    try:
        trades = _load_trades()
        holds = [t for t in trades if t.get("status") == "open"]
        if holds:
            h_lines = []
            for h in holds:
                q = _quote_cache.get(h["symbol"], (0, {}))[1]
                last = q.get("last") if q else None
                flt = f"，浮动 {((last - h['entry']) * (1 if h['direction'] == 'long' else -1)):+.1f} 点" if last else ""
                h_lines.append(
                    f"- {h['symbol']} {'多' if h['direction'] == 'long' else '空'} {h.get('lots', 1)}手："
                    f"入 {h['entry']} 损 {h.get('stop_points') or '未设'}点 目标 {h.get('target_points') or '未设'}点{flt}"
                )
            parts.append("【当前持仓（今日盯住其止损位与资金方向变化）】\n" + "\n".join(h_lines))
        issues = [i for i in _DIAG["issues"] if i["sev"] in ("fatal", "warn")][:5]
        if issues:
            parts.append("【交易诊断未决问题】\n" + "\n".join(f"- [{i['sev']}] {i['title']}：{i['evidence']}" for i in issues))
    except Exception:
        pass

    # 外盘锚
    try:
        intl_items = await fetch_intl()
        lines = []
        for it in intl_items:
            pct = it.get("chg_pct")
            if it.get("last") is not None:
                lines.append(f"- {it['name']}：{it['last']}（{'+' if (pct or 0) >= 0 else ''}{pct}%）")
        if lines:
            parts.append("【外盘大势锚】\n" + "\n".join(lines))
    except Exception:
        pass

    # 宏观要闻 + 自选品种要闻（辅助参考；品种并行抓取）
    try:
        nblk = await _news_context(5)
        if nblk:
            parts.append(nblk)
        news_results = await asyncio.gather(*[_variety_news(s, limit=1) for s in syms], return_exceptions=True)
        v_lines = []
        for s, res in zip(syms, news_results):
            if isinstance(res, Exception):
                continue
            for it in res:
                v_lines.append(f"- [{s} {it['time'][5:16] if len(it['time']) >= 16 else it['time']}] {it['title'][:55]}")
        if v_lines:
            parts.append("【自选品种要闻（辅助参考：供需/库存/政策事实，不作方向依据）】\n" + "\n".join(v_lines[:6]))
    except Exception:
        pass

    if not parts:
        return "（暂无可用数据，请稍后重新生成）"

    kind = "晨报（日盘前瞻）" if _report_slot().endswith("-am") else "夜报（夜盘前瞻）"
    profile = _profile_context()
    flaw = _flaw_context()
    prompt = (
        (f"交易者画像：\n{profile}\n\n" if profile else "")
        + (f"{flaw}\n\n" if flaw else "")
        + f"你是反幻想交易教练。基于以下数据生成{kind}，Markdown 格式：\n"
        f"## 一、市场情绪概览（3-4 句：各品种散户情绪处于什么阶段，外盘与宏观要闻给的情绪基调——要闻只解释情绪来源与跳空风险，不作方向依据）\n"
        f"## 二、分品种博弈要点（每品种 1-2 句：资金方向+散户陷阱+关键价位）\n"
        f"## 三、今日纪律（3-5 条：结合持仓、诊断问题与缺陷画像，给出「不做清单」——今天最不该做的是什么；若上下文带缺陷画像，逐条点名对应缺陷）\n"
        f"要求：客观精炼、全文 600 字以内、全部引用具体数值；结尾注明仅供参考。\n\n"
        + "\n\n".join(parts)
    )
    cfg = load_config()
    return await _call_ai_simple(
        [{"role": "user", "content": prompt}],
        max_tokens=min(4096, max_output_for(cfg["model"] or "")),
    )


async def report_push_loop():
    """晨/夜报定时生成并推送飞书（8:50 晨报、20:50 夜报）"""
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
                # 先扫一遍诊断，报告里带上未决问题
                if _load_trades():
                    try:
                        await _diagnosis_scan()
                    except Exception:
                        pass
                text = await _generate_report()
                reports = _load_reports()
                reports[slot] = {"ts": int(datetime.now().timestamp() * 1000), "report": text}
                keep = sorted(reports.keys())[-6:]
                _save_reports({k: reports[k] for k in keep})
                kind = "晨报（日盘前瞻）" if is_am else "夜报（夜盘前瞻）"
                await _feishu_push(f"📋 心理博弈{kind}\n\n{text[:1800]}")
        except Exception as e:
            import logging
            logging.getLogger("uvicorn.error").info(f"[report-push] 异常：{e}")
        await asyncio.sleep(120)


@app.get("/api/report")
async def get_report(force: int = 0):
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
            keep = sorted(reports.keys())[-6:]
            _save_reports({k: reports[k] for k in keep})
        except Exception as e:
            logging.getLogger("uvicorn.error").info(f"[report] 生成失败：{e}")
        finally:
            _report_state["generating"] = False

    asyncio.create_task(_job())
    return {"ok": True, "status": "generating", "slot": slot}


# ---------------------------------------------------------------- 定期自检

_health = {"ts": 0, "results": [], "running": False}
_APP_STARTED = datetime.now()


async def _selfcheck_run(ping_ai: bool = False) -> list:
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
        items = await fetch_intl()
        ok = [i for i in items if i.get("last") is not None]
        return f"{len(ok)}/{len(items)} 品种正常"

    async def probe_psych():
        snap = await psych_snapshot("RB0")
        return f"{snap['regime']['label']}，陷阱指数 {snap['parties']['retail']['trap_risk']}"

    async def probe_monitor():
        lc = _MONITOR.get("last_check")
        if not lc:
            uptime = (datetime.now() - _APP_STARTED).total_seconds()
            if uptime < 90:
                return f"启动初始化中（{int(uptime)}s）"
            raise RuntimeError("盯盘循环尚未运行")
        return f"最近巡检 {lc}"

    async def probe_psych_watch():
        if not _psych_prev:
            uptime = (datetime.now() - _APP_STARTED).total_seconds()
            if uptime < 150:
                return f"启动初始化中（{int(uptime)}s）"
            raise RuntimeError("博弈雷达尚未建档")
        return f"监控 {len(_psych_prev)} 个品种"

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

    checks = [
        ("国内实时行情", probe_quote), ("国内日K", probe_kline),
        ("国内分钟线", probe_minute), ("国际行情", probe_intl),
        ("心理博弈引擎", probe_psych), ("盯盘循环", probe_monitor),
        ("博弈雷达", probe_psych_watch), ("飞书", probe_feishu),
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


# ---------------------------------------------------------------- 静态页面

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    return FileResponse(
        BASE_DIR / "static" / "index.html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8300)
