"""期货实时分析助手 - 后端服务

数据来源：AkShare（新浪财经），免费、约 3~5 秒延迟，仅供研究参考。
AI 对话：转发到 OpenAI 兼容接口（智谱 GLM / DeepSeek），API Key 保存在本机 config.json。
"""

import asyncio
import json
import re
from contextlib import asynccontextmanager
from datetime import datetime, time as dtime
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
        "default_model": "deepseek-v4-flash-vision-exp",
    },
}

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
    "api_keys": {},  # 按服务商独立保存：{"zhipu": "...", "deepseek": "..."}
    "feishu": {},    # 飞书云文档同步：{"app_id", "app_secret", "doc_title", "doc_id"}
    "monitor": {
        "enabled": True,
        "sensitivity": 1.0,          # 阈值倍率：0.5 灵敏 / 1 标准 / 2 迟钝
        "focus": ["SC0", "AU0"],     # 重点常驻监控（原油、黄金）
    },
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
# 多线程同时首次调用会直接 abort 整个进程。因此启动时先单线程预热一遍，
# 预热失败（如断网）时则通过锁降级为串行调用。
_warmed = False
_ak_lock = asyncio.Lock()


async def call_ak(func, *args, **kwargs):
    global _warmed
    if _warmed:
        return await asyncio.to_thread(func, *args, **kwargs)
    async with _ak_lock:
        result = await asyncio.to_thread(func, *args, **kwargs)
        _warmed = True
        return result


async def _warmup():
    try:
        await call_ak(ak.futures_zh_spot, symbol="RB0", market="CF", adjust="0")
        await call_ak(ak.futures_zh_daily_sina, symbol="RB0")
        await call_ak(ak.futures_display_main_sina)
    except Exception:
        _warmed = False  # 预热失败：保持串行模式


@asynccontextmanager
async def lifespan(_app):
    await _warmup()
    monitor_task = asyncio.create_task(monitor_loop())
    report_task = asyncio.create_task(report_push_loop())
    yield
    monitor_task.cancel()
    report_task.cancel()


app = FastAPI(title="期货实时分析助手", lifespan=lifespan)

# ---------------------------------------------------------------- 配置


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- 行情

QUOTE_TTL = 5.0        # 单合约行情缓存（秒），与前端轮询周期一致
DIR_TTL = 3600.0       # 合约目录缓存（秒）
DAILY_TTL = 60.0       # 日线缓存（秒），收盘后数据不变，避免指标反复请求打爆数据源
INTRADAY_TTL = 30.0    # 分钟线缓存（秒）

_quote_cache: dict[str, tuple[float, dict]] = {}
_dir_cache: dict = {"ts": 0.0, "data": {}}
_daily_cache: dict[str, tuple[float, list]] = {}
_minute_cache: dict[tuple, tuple[float, list]] = {}
_intraday_cache: dict[str, tuple[float, dict]] = {}

# 中金所品种前缀（IF/IH/IC/IM 股指，T/TF/TS/TL 国债）
_CFFEX_RE = re.compile(r"^(IF|IH|IC|IM|T|TF|TS|TL)\d")


def market_of(symbol: str) -> str:
    return "CFFEX" if _CFFEX_RE.match(symbol.upper()) else "CF"


def is_trading_time(now: Optional[datetime] = None) -> bool:
    """简化的国内期货交易时段判断（多数品种夜盘到 23:00，少数延至凌晨，此处不细分）"""
    now = now or datetime.now()
    if now.weekday() >= 5:
        return False
    t = now.time()
    sessions = [
        (dtime(9, 0), dtime(10, 15)),
        (dtime(10, 30), dtime(11, 30)),
        (dtime(13, 30), dtime(15, 0)),
        (dtime(21, 0), dtime(23, 0)),
    ]
    return any(a <= t <= b for a, b in sessions)


def _fmt_time(raw) -> str:
    s = str(raw).strip()
    if re.fullmatch(r"\d{6}", s):
        return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"
    return s


async def get_directory() -> dict[str, dict]:
    """主力合约目录：symbol(如 RB0) -> {name, exchange}"""
    loop_now = asyncio.get_event_loop().time()
    if loop_now - _dir_cache["ts"] > DIR_TTL:
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
        except Exception:
            pass  # 目录刷新失败时沿用旧缓存
    return _dir_cache["data"]


async def get_daily(symbol: str, max_age: float = 60.0) -> list[dict]:
    """日线数据（带缓存：收盘后基本不变，60 秒内复用）"""
    symbol = symbol.upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _daily_cache.get(symbol)
    if cached and loop_now - cached[0] < max_age:
        return cached[1]
    df = await call_ak(ak.futures_zh_daily_sina, symbol=symbol)
    records = df.to_dict("records")
    _daily_cache[symbol] = (loop_now, records)
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


async def fetch_quote(symbol: str) -> dict:
    """单合约实时行情（带 5 秒缓存）"""
    symbol = symbol.strip().upper()
    loop_now = asyncio.get_event_loop().time()
    cached = _quote_cache.get(symbol)
    if cached and loop_now - cached[0] < QUOTE_TTL:
        return cached[1]

    try:
        df = await call_ak(ak.futures_zh_spot, symbol=symbol, market=market_of(symbol), adjust="0")
        row = df.iloc[0].to_dict()
    except Exception as e:
        return {"symbol": symbol, "error": f"行情获取失败：{e}"}

    directory = await get_directory()
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


async def get_indicators(symbol: str) -> dict:
    """日线技术指标 + 信号（供 API 与 AI 上下文共用）"""
    records = await get_daily(symbol)
    if len(records) < 30:
        raise ValueError(f"日线数据不足（{len(records)} 根），无法计算指标")
    df = pd.DataFrame(records)
    ind = compute_indicators(df)
    return {
        "values": latest_values(ind),
        "signals": detect_signals(ind),
        "date": str(ind.iloc[-1].get("date", "")),
    }


@app.get("/api/indicators/{symbol}")
async def indicators(symbol: str):
    try:
        data = await get_indicators(symbol)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"指标计算失败：{e}")
    return {"ok": True, **data}


KLINE_PERIODS = {"day": None, "60m": "60", "30m": "30", "15m": "15", "5m": "5", "1m": "1"}


@app.get("/api/kline/{symbol}")
async def kline(symbol: str, period: str = "day", limit: int = 120):
    """K 线（蜡烛图数据）：日线或分钟线，附 MA5/10/20 与（仅日线）信号"""
    period = period if period in KLINE_PERIODS else "day"
    limit = min(max(limit, 30), 500)
    symbol = symbol.upper()
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
        "feishu_configured": bool((cfg.get("feishu") or {}).get("app_id")),
    }


class AiConfigIn(BaseModel):
    provider: str = "zhipu"
    model: str = ""
    api_key: str = ""
    clear_key: bool = False


@app.post("/api/ai/config")
async def set_ai_config(body: AiConfigIn):
    if body.provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail="不支持的服务商")
    cfg = load_config()
    cfg["provider"] = body.provider
    cfg["model"] = body.model.strip() or PROVIDERS[body.provider]["default_model"]
    if body.clear_key:
        cfg["api_keys"][body.provider] = ""
    elif body.api_key.strip():  # 留空则保留该服务商已存的 Key
        cfg["api_keys"][body.provider] = body.api_key.strip()
    save_config(cfg)
    return {"ok": True}


async def _build_market_context(symbol: Optional[str]) -> str:
    """把已缓存的实时行情与选中合约近期日线拼成文字上下文"""
    parts = []
    cached_quotes = [
        {"ts": ts, "q": q}
        for ts, q in _quote_cache.values()
        if not q.get("error")
    ]
    if cached_quotes:
        lines = []
        for c in sorted(cached_quotes, key=lambda x: x["q"]["symbol"]):
            q = c["q"]
            pct = f"{q['change_pct']:+.2f}%" if q.get("change_pct") is not None else "--"
            lines.append(
                f"- {q['symbol']} {q.get('name', '')}：最新 {q['last']}，昨结 {q.get('prev_settle')}，"
                f"涨跌 {pct}，成交量 {q.get('volume')}，持仓量 {q.get('position')}（行情时间 {q.get('time')}）"
            )
        parts.append("【当前已加载的实时行情】\n" + "\n".join(lines))

    if symbol:
        try:
            daily = await get_daily(symbol)
            directory = await get_directory()
            name = directory.get(symbol, {}).get("name", "")
            lines = [
                f"{d['date']} 开{_num(d.get('open'))} 高{_num(d.get('high'))} "
                f"低{_num(d.get('low'))} 收{_num(d.get('close'))} "
                f"量{_num(d.get('volume'))} 持仓{_num(d.get('hold'))}"
                for d in daily[-10:]
            ]
            parts.append(f"【{symbol}（{name}）近 10 个交易日日线】\n" + "\n".join(lines))
        except Exception:
            pass

        # 技术指标与信号
        try:
            ind = await get_indicators(symbol)
            v = ind["values"]
            dir_cn = {"bull": "看多", "bear": "看空", "warn": "警示"}
            ind_lines = [
                f"【{symbol} 技术指标（日线，截至 {ind['date']}）】",
                f"收盘 {v.get('close')} | MA5 {v.get('ma5')} MA10 {v.get('ma10')} "
                f"MA20 {v.get('ma20')} MA60 {v.get('ma60')}",
                f"MACD: DIF {v.get('dif')} DEA {v.get('dea')} 柱 {v.get('macd_hist')} | "
                f"RSI6 {v.get('rsi6')} RSI12 {v.get('rsi12')} RSI24 {v.get('rsi24')}",
                f"KDJ: K {v.get('k')} D {v.get('d')} J {v.get('j')} | "
                f"BOLL: 上轨 {v.get('boll_up')} 中轨 {v.get('boll_mid')} 下轨 {v.get('boll_low')}",
            ]
            if ind["signals"]:
                sig = "；".join(
                    f"[{dir_cn.get(s['dir'], s['dir'])}]{s['name']}（{s['detail']}）"
                    for s in ind["signals"]
                )
                ind_lines.append(f"最新信号：{sig}")
            else:
                ind_lines.append("最新信号：无明显技术信号")
            parts.append("\n".join(ind_lines))
        except Exception:
            pass

        # 日内走势结构
        try:
            intra = await _intraday_summary(symbol)
            if intra:
                parts.append(f"【{symbol} 日内走势结构】{intra}")
        except Exception:
            pass

        # 日K统计（区间分位与量仓趋势）
        try:
            stats = _daily_stats(await get_daily(symbol))
            if stats:
                parts.append(f"【{symbol} 中期统计】{stats}")
        except Exception:
            pass

        # 消息面（三层：品种产业/供需深研 + 金属行情快讯 + 全球要闻流）
        try:
            deep = await _variety_news_deep(symbol)
            if deep:
                lines = [f"- [{it['time'][5:16]}] {it['title']}（{it['source']}）" for it in deep]
                parts.append(f"【{symbol} 产业·供需聚焦（东财专业新闻，近期待闻）】\n" + "\n".join(lines))
        except Exception:
            pass
        try:
            shm = await _shmet_news(symbol)
            if shm:
                lines = [f"- [{it['time']}] {it['title']}" for it in shm]
                parts.append(f"【金属行情快讯（上海有色网 SHMET，实时）】\n" + "\n".join(lines))
        except Exception:
            pass
        try:
            vnews = _variety_news(symbol)
            if vnews:
                lines = [f"- [{it['time'][5:16]}] {it['title'][:60]}" for it in vnews]
                parts.append(f"【{symbol} 全球宏观要闻（新浪/东财快讯流）】\n" + "\n".join(lines))
        except Exception:
            pass

        # 基本面背景
        profile = _variety_profile(symbol)
        if profile:
            parts.append(f"【{symbol} 基本面框架（背景知识，供分析参考）】{profile}")
    return "\n\n".join(parts)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    messages: list[ChatMessage]
    symbol: Optional[str] = None


SYSTEM_PROMPT = """你是一位专业的国内期货市场分析助手。用户会给你多维数据：实时行情、近期日线与技术指标（MA/MACD/RSI/KDJ/BOLL）及信号、日内走势结构（开高低与出现时间、均价偏离、量能分布、尾盘动向）、中期统计（60日分位、持仓变化、量能趋势）、品种相关消息面、基本面框架。请综合分析：
1) 日内结构：价格在当日区间的位置、量价配合、尾盘动向暗示的短期方向；
2) 技术面：趋势与关键支撑压力（结合均线/布林/分位）、动能状态与信号共振或冲突；
3) 消息面与基本面：相关要闻如何作用于该品种的供需与情绪逻辑；
4) 结论：多空倾向、关键价位（触发条件明确）、量仓验证信号、主要风险。
要求：观点客观中立、条理清晰、使用中文、引用具体数值；如某维数据缺失要明说；数据为连续主力合约口径，注意换月影响。
你的输出仅供研究参考，不构成投资建议，必要时提醒用户注意风险。"""


@app.post("/api/ai/chat")
async def ai_chat(body: ChatIn):
    cfg = load_config()
    provider = cfg["provider"] if cfg["provider"] in PROVIDERS else "zhipu"
    api_key = cfg["api_keys"].get(provider)
    if not api_key:
        raise HTTPException(status_code=400, detail="尚未配置 API Key，请先在右上角「AI 设置」中配置")
    base_url = PROVIDERS[provider]["base_url"]
    model = cfg["model"] or PROVIDERS[provider]["default_model"]

    context = await _build_market_context(body.symbol)
    system = SYSTEM_PROMPT + ("\n\n" + context if context else "")

    messages = [{"role": "system", "content": system}] + [
        {"role": m.role, "content": m.content} for m in body.messages
    ]

    import logging
    import time as _time

    logger = logging.getLogger("uvicorn.error")
    t0 = _time.time()
    max_tokens = max_output_for(model)
    logger.info(f"[ai-chat] 开始调用 {provider}/{model}（消息 {len(body.messages)} 条，上下文 {len(system)} 字，max_tokens={max_tokens}）")

    full_reply = ""
    truncated_rounds = 0

    async with httpx.AsyncClient(timeout=180) as client:  # 推理模型长回复需要更长时间
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

    logger.info(f"[ai-chat] 完成：耗时 {_time.time() - t0:.0f}s，共 {len(full_reply)} 字"
                + (f"（续写 {truncated_rounds} 轮）" if truncated_rounds else ""))
    return {"ok": True, "reply": full_reply}


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


# 品种搜索词（东财品种新闻 / SHMET 快讯过滤用）
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


TRADE_EVAL_PROMPT = """你是严格的日内短线交易风险教练（国内期货，T+0 双向交易）。交易者提交了开仓计划，请基于参考数据做开仓前风险体检。

【交易计划】
- 品种：{symbol}（{name}），方向：{dir_cn}
- 开仓价 {entry}（现价 {last}，偏离 {dev_pct}%）
- 止损 {stop_points} 点（{stop_price}），止盈 {target_points} 点（{target_price}）
- 盈亏比 {rr}，手数 {lots}{risk_amt}
- 止损幅度占日内已实现波幅 {stop_vs_range}%，占近5日平均日波幅 {stop_vs_avg}%
- 参考位：今日最高 {day_high} / 最低 {day_low}，日内均价 {day_avg}，昨结 {prev_settle}

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

    prompt = TRADE_EVAL_PROMPT.format(
        symbol=symbol, name=name, dir_cn="做多" if body.direction == "long" else "做空",
        entry=body.entry, last=last, dev_pct=dev_pct,
        stop_points=body.stop_points, stop_price=stop_price,
        target_points=body.target_points, target_price=target_price,
        rr=rr, lots=body.lots, risk_amt=risk_amt,
        stop_vs_range=stop_vs_range if stop_vs_range is not None else "--",
        stop_vs_avg=stop_vs_avg if stop_vs_avg is not None else "--",
        day_high=day_high, day_low=day_low, day_avg=day_avg, prev_settle=quote.get("prev_settle"),
        context=context,
    )

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
        },
        "advice": advice,
    }


# ---------------------------------------------------------------- 交易日志与复盘统计

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


@app.get("/api/trades")
async def get_trades():
    return {"ok": True, "items": list(reversed(_load_trades()))}  # 新的在前


class TradeIn(BaseModel):
    symbol: str
    direction: str  # long / short
    entry: float
    stop_points: float
    target_points: float
    lots: float = 1
    date: str = ""
    ai_grade: str = ""   # AI 评估时的风险评级快照（低/中/高）


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
    }
    trades.append(trade)
    _save_trades(trades)
    return {"ok": True, "item": trade}


class TradePatch(BaseModel):
    exit: Optional[float] = None       # 平仓价（与 result_pts 二选一）
    result_pts: Optional[float] = None  # 直接填盈亏点数
    note: Optional[str] = None
    status: Optional[str] = None       # closed / open / 放弃可填 closed 且 result 0？约定：abandoned


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


# ---------------------------------------------------------------- AI 盯盘引擎

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


async def _call_ai_simple(messages: list[dict], max_tokens: int = 2048, provider: str = "") -> str:
    """供盯盘等内部功能调用的轻量 AI 接口。

    注意：推理型模型（如 deepseek-v4-pro）会先消耗大量 token 生成思维链，
    max_tokens 给足才能保证正文（content）非空。
    """
    cfg = load_config()
    provider = provider or cfg["provider"]
    if provider not in PROVIDERS:
        provider = "zhipu"
    api_key = cfg["api_keys"].get(provider)
    if not api_key:
        raise RuntimeError("未配置 API Key")
    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(
            f"{PROVIDERS[provider]['base_url']}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": cfg["model"] if provider == cfg["provider"] else PROVIDERS[provider]["default_model"],
                "messages": messages,
                "temperature": 0.4,
                "max_tokens": max_tokens,
            },
        )
    resp.raise_for_status()
    return (resp.json()["choices"][0]["message"].get("content") or "").strip()


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
    directory = await get_directory()
    name = directory.get(event["symbol"], {}).get("name", "")
    pos = event.get("pos_chg")
    pos_line = f"，近 15 分钟持仓{'增加' if pos > 0 else '减少'} {abs(pos):.0f} 手" if pos else ""
    prompt = (
        f"你是期货盯盘助手。刚检测到异动：{event['symbol']}（{name}）最近 5 分钟"
        f"{'急涨' if event['dir'] == 'up' else '跳水'} {event['chg5']:+.2f}%，现价 {event['price']}；"
        f"15 分钟 {event['chg15']:+.2f}%，日内 {event['day_chg'] if event['day_chg'] is not None else '--'}%{pos_line}。"
        f"请用一两句话点出可能的驱动因素和需要关注的价位/风险，口语化，80 字以内，不构成投资建议。"
    )
    try:
        reply = await _call_ai_simple([{"role": "user", "content": prompt}])
        event["ai"] = reply or "（AI 未返回有效解读，可稍后重试）"
    except Exception:
        event["ai"] = "（AI 解读不可用：未配置 Key 或调用失败）"
    # 推送飞书群（配置了 webhook 时）
    await _feishu_push(
        f"🤖 盯盘异动\n"
        f"{event['symbol']}（{name}）5分钟{'急涨' if event['dir'] == 'up' else '跳水'} {event['chg5']:+.2f}%，"
        f"现价 {event['price']}\n"
        f"15分钟 {event['chg15']:+.2f}% | 日内 {event['day_chg'] if event['day_chg'] is not None else '--'}%\n\n"
        f"💡 {event['ai'][:600]}"
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
    """AI 盯盘：每 30 秒巡检自选 + 重点品种（原油/黄金等），检测 5 分钟急涨急跌"""
    await asyncio.sleep(20)  # 等待预热与首轮行情
    while True:
        try:
            mon_cfg = (load_config().get("monitor") or DEFAULT_CONFIG["monitor"])
            if mon_cfg.get("enabled", True):
                symbols = {s.upper() for s in (mon_cfg.get("focus") or [])} | set(_MONITOR["watch"])
                for sym in sorted(symbols):
                    await _check_symbol(sym, mon_cfg.get("sensitivity", 1.0))
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


# ---------------------------------------------------------------- 对比与相关性


async def _aligned_closes(syms: list[str], limit: int) -> tuple[list[str], dict]:
    """多品种日线收盘价按日期对齐，返回（公共日期列表, {sym: {date: close}}）"""
    closes = {}
    for s in syms:
        daily = await get_daily(s)
        closes[s] = {str(r["date"]): r["close"] for r in daily if r.get("close")}
    common = sorted(set.intersection(*[set(c) for c in closes.values()]))[-limit:]
    return common, closes


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


# ---------------------------------------------------------------- 飞书云文档同步

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
            logging.getLogger("uvicorn.error").info(f"[feishu-push] 失败：{r.text[:120]}")
        return ok
    except Exception as e:
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


@app.post("/api/chat-export")
async def chat_export(body: ChatExportIn):
    """将 AI 对话历史导出追加到飞书云文档《AI 对话记录》"""
    cfg = load_config()
    fs = cfg.get("feishu") or {}
    if not fs.get("app_id") or not fs.get("app_secret"):
        raise HTTPException(status_code=400, detail="未配置飞书应用凭证（App ID / App Secret）")
    text = body.content.strip()
    if not text:
        raise HTTPException(status_code=400, detail="对话内容为空")

    doc_id = fs.get("chat_doc_id") or ""
    if not doc_id:
        import logging
        # 首次导出：创建独立《AI 对话记录》文档并记住
        token = await _feishu_get_token()
        try:
            async with httpx.AsyncClient(timeout=20) as _client:
                r = await _client.post(
                    f"{FEISHU_BASE}/docx/v1/documents",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"title": body.title},
                )
            data = r.json()
            logging.getLogger("uvicorn.error").info(f"[chat-export] 创建文档：code={data.get('code')} msg={data.get('msg')}")
            if data.get("code") == 0 and data.get("data", {}).get("document"):
                doc_id = data["data"]["document"]["document_id"]
                cfg["feishu"]["chat_doc_id"] = doc_id
                save_config(cfg)
        except Exception as e:
            logging.getLogger("uvicorn.error").info(f"[chat-export] 创建文档异常：{type(e).__name__} {e}")
    if not doc_id:
        # 创建失败兜底：追加到心得文档（有内容可存比文档分类更优先）
        doc_id = await _feishu_ensure_doc()

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
    for n in notes:
        if n["id"] in ids:
            n["synced"] = True
    _save_notes(notes)
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
    # 凭证变更后重建文档关联
    if body.app_id.strip() or body.app_secret.strip():
        fs.pop("doc_id", None)
    save_config(cfg)
    return {"ok": True}


@app.post("/api/feishu/push-test")
async def feishu_push_test():
    """发送测试消息验证 webhook 配置"""
    ok = await _feishu_push("✅ 期货助手推送测试：配置成功，盯盘异动与晨报将推送到本群。")
    if not ok:
        cfg = load_config()
        if not (cfg.get("feishu") or {}).get("webhook_url"):
            raise HTTPException(status_code=400, detail="未配置 webhook URL")
        raise HTTPException(status_code=502, detail="推送失败，请检查 webhook 地址与群机器人设置")
    return {"ok": True}


# ---------------------------------------------------------------- 主题要闻

# 多主题关键词：每条快讯会标记命中的全部主题
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
        "特朗普", "白宫", "美国国务院", "五角大楼", "美国国防部", "美军", "美国中央司令部",
        "美国官员", "华盛顿号",
        # 伊朗方
        "伊朗", "德黑兰", "哈梅内伊", "伊朗总统", "伊朗外长", "革命卫队", "伊朗核",
        "铀浓缩", "国际原子能机构", "iaea",
        # 冲突动作与关联方（保持聚焦，泛词如"地缘/俄乌"归 oilgold 主题）
        "空袭", "霍尔木兹", "红海", "胡塞", "停火谈判", "以色列", "沙特遇袭", "对伊制裁",
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
    cfg = load_config()
    if not cfg["api_keys"].get(cfg["provider"]):
        return tags

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
    return tags


async def _ai_filter_job():
    _news_ai["running"] = True
    try:
        items = _news_cache["items"][:NEWS_AI_LIMIT]
        _news_ai["tags"] = await _ai_filter_news(items)
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


def _news_topics(text: str) -> list[str]:
    """返回文本命中的全部主题（不区分大小写）"""
    t = text.lower()
    return [topic for topic, kws in NEWS_TOPICS.items() if any(k in t for k in kws)]


@app.get("/api/news")
async def news(topic: str = ""):
    """主题要闻：新浪全球快讯（市场异动流）+ 东方财富全球快讯，多主题命中标记。

    topic 传入 NEWS_TOPICS 的键时仅返回该主题命中的条目。
    """
    loop_now = asyncio.get_event_loop().time()
    if loop_now - _news_cache["ts"] > NEWS_TTL:
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
        },
    }


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
    """晨/夜报：主题要闻 + 自选品种快照与信号 → AI 汇总"""
    parts = []

    try:
        nd = await news()
        matched = [i for i in nd.get("items", []) if i.get("matched")][:20]
        if matched:
            lines = [f"- [{i['time'][5:16]}] {i['title'][:60]}" for i in matched]
            parts.append("【近期要闻（原油/黄金/宏观主题）】\n" + "\n".join(lines))
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
            ind = await get_indicators(s)
            sigs = "；".join(x["name"] for x in ind["signals"][:3]) or "无明显信号"
            line += f"；日线信号：{sigs}"
        except Exception:
            pass
        lines.append(line)
    if lines:
        parts.append("【自选品种快照】\n" + "\n".join(lines))

    if not parts:
        return "（暂无可用数据，请稍后重新生成）"

    kind = "晨报（日盘前瞻）" if _report_slot().endswith("-am") else "夜报（夜盘前瞻）"
    prompt = (
        f"你是期货{kind}助手。请基于以下数据生成一份简明交易简报，使用 Markdown：\n"
        f"## 一、市场概览（3-4 句，结合要闻讲清楚隔夜/近期主线）\n"
        f"## 二、分品种要点（每个品种 1-2 句：状态+关键点位+信号提示）\n"
        f"## 三、今日关注（3-5 条：要盯的事件/价位/信号）\n"
        f"要求：客观精炼、全文 600 字以内、引用具体数值；结尾注明仅供参考。\n\n"
        + "\n\n".join(parts)
    )
    cfg = load_config()
    return await _call_ai_simple(
        [{"role": "user", "content": prompt}],
        max_tokens=min(4096, max_output_for(cfg["model"] or "")),
    )


async def report_push_loop():
    """晨/夜报定时生成并推送飞书：8:50 后生成当日晨报、20:50 后生成夜报（不依赖打开页面）"""
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8300)
