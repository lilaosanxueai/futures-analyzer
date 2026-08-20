"""技术指标计算与信号检测（纯 pandas 实现，无 TA-Lib 依赖）。

输入日线 DataFrame（列：date/open/high/low/close/volume/hold），
输出带指标列的 DataFrame 与最新信号列表。
"""

import pandas as pd


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()

    # 均线
    for n in (5, 10, 20, 60):
        out[f"ma{n}"] = out["close"].rolling(n).mean()

    # MACD：DIF = EMA12 - EMA26，DEA = DIF 的 EMA9，柱 = (DIF-DEA)*2（国内口径）
    ema12 = out["close"].ewm(span=12, adjust=False).mean()
    ema26 = out["close"].ewm(span=26, adjust=False).mean()
    out["dif"] = ema12 - ema26
    out["dea"] = out["dif"].ewm(span=9, adjust=False).mean()
    out["macd_hist"] = (out["dif"] - out["dea"]) * 2

    # RSI（Wilder 平滑），国内常用 6/12/24
    for n in (6, 12, 24):
        delta = out["close"].diff()
        gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
        loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
        rs = gain / loss.replace(0, pd.NA)
        out[f"rsi{n}"] = 100 - 100 / (1 + rs)

    # 布林带（20, 2σ）
    mid = out["close"].rolling(20).mean()
    std = out["close"].rolling(20).std(ddof=0)
    out["boll_mid"] = mid
    out["boll_up"] = mid + 2 * std
    out["boll_low"] = mid - 2 * std

    # KDJ(9,3,3)：K = SMA(RSV,3,1)，等价 alpha=1/3 的 EMA
    low9 = out["low"].rolling(9).min()
    high9 = out["high"].rolling(9).max()
    rng = (high9 - low9).replace(0, pd.NA)
    rsv = (out["close"] - low9) / rng * 100
    out["k"] = rsv.ewm(com=2, adjust=False).mean()
    out["d"] = out["k"].ewm(com=2, adjust=False).mean()
    out["j"] = 3 * out["k"] - 2 * out["d"]

    return out


VALUE_FIELDS = [
    "ma5", "ma10", "ma20", "ma60",
    "dif", "dea", "macd_hist",
    "rsi6", "rsi12", "rsi24",
    "boll_up", "boll_mid", "boll_low",
    "k", "d", "j",
]


def _round(v, nd=2):
    try:
        f = float(v)
        return round(f, nd) if f == f else None
    except (TypeError, ValueError):
        return None


def latest_values(df: pd.DataFrame) -> dict:
    """最新一根日 K 的指标值（NaN -> None）"""
    last = df.iloc[-1]
    vals = {"close": _round(last["close"])}
    for f in VALUE_FIELDS:
        vals[f] = _round(last.get(f))
    return vals


def detect_signals(df: pd.DataFrame) -> list[dict]:
    """比较最后两根日 K，输出信号列表。dir: bull/bear/warn"""
    if len(df) < 2:
        return []
    last, prev = df.iloc[-1], df.iloc[-2]
    date = str(last.get("date", ""))
    signals = []

    def ok(*fields):
        rows = (last, prev)
        return all(
            r.get(f) is not None and _round(r.get(f)) is not None
            for r in rows for f in fields
        )

    # MACD 交叉
    if ok("dif", "dea"):
        if prev["dif"] <= prev["dea"] and last["dif"] > last["dea"]:
            signals.append({"dir": "bull", "name": "MACD 金叉",
                            "detail": f"DIF {_round(last['dif'])} 上穿 DEA {_round(last['dea'])}"})
        elif prev["dif"] >= prev["dea"] and last["dif"] < last["dea"]:
            signals.append({"dir": "bear", "name": "MACD 死叉",
                            "detail": f"DIF {_round(last['dif'])} 下穿 DEA {_round(last['dea'])}"})
    if ok("macd_hist") and prev["macd_hist"] * last["macd_hist"] < 0:
        side = "翻红" if last["macd_hist"] > 0 else "翻绿"
        signals.append({"dir": "bull" if last["macd_hist"] > 0 else "bear",
                        "name": f"MACD 柱{side}",
                        "detail": f"柱值 {round(float(last['macd_hist']), 2)}"})

    # KDJ 交叉与 J 值极值
    if ok("k", "d"):
        if prev["k"] <= prev["d"] and last["k"] > last["d"]:
            signals.append({"dir": "bull", "name": "KDJ 金叉",
                            "detail": f"K {_round(last['k'], 1)} 上穿 D {_round(last['d'], 1)}"})
        elif prev["k"] >= prev["d"] and last["k"] < last["d"]:
            signals.append({"dir": "bear", "name": "KDJ 死叉",
                            "detail": f"K {_round(last['k'], 1)} 下穿 D {_round(last['d'], 1)}"})
    if ok("j"):
        if last["j"] > 100:
            signals.append({"dir": "warn", "name": "KDJ 超买",
                            "detail": f"J 值 {round(float(last['j']), 1)}，短线过热"})
        elif last["j"] < 0:
            signals.append({"dir": "warn", "name": "KDJ 超卖",
                            "detail": f"J 值 {round(float(last['j']), 1)}，短线超跌"})

    # RSI 超买超卖（RSI6 常用 80/20 界限）
    if ok("rsi6"):
        if last["rsi6"] > 80:
            signals.append({"dir": "warn", "name": "RSI 超买",
                            "detail": f"RSI6 {_round(last['rsi6'], 1)}，注意回调风险"})
        elif last["rsi6"] < 20:
            signals.append({"dir": "warn", "name": "RSI 超卖",
                            "detail": f"RSI6 {_round(last['rsi6'], 1)}，存在反弹动能"})

    # 价格与 MA20 关系
    if ok("ma20"):
        if prev["close"] <= prev["ma20"] and last["close"] > last["ma20"]:
            signals.append({"dir": "bull", "name": "站上 MA20",
                            "detail": f"收盘 {_round(last['close'])} 突破 MA20 {_round(last['ma20'])}"})
        elif prev["close"] >= prev["ma20"] and last["close"] < last["ma20"]:
            signals.append({"dir": "bear", "name": "跌破 MA20",
                            "detail": f"收盘 {_round(last['close'])} 跌破 MA20 {_round(last['ma20'])}"})

    # 均线多空排列
    if ok("ma5", "ma10", "ma20"):
        if last["ma5"] > last["ma10"] > last["ma20"]:
            signals.append({"dir": "bull", "name": "均线多头排列",
                            "detail": "MA5 > MA10 > MA20，中期趋势偏多"})
        elif last["ma5"] < last["ma10"] < last["ma20"]:
            signals.append({"dir": "bear", "name": "均线空头排列",
                            "detail": "MA5 < MA10 < MA20，中期趋势偏空"})

    # 布林带突破
    if ok("boll_up", "boll_low"):
        if last["close"] > last["boll_up"]:
            signals.append({"dir": "warn", "name": "突破布林上轨",
                            "detail": f"收盘 {_round(last['close'])} > 上轨 {_round(last['boll_up'])}，强势但防冲高回落"})
        elif last["close"] < last["boll_low"]:
            signals.append({"dir": "warn", "name": "跌破布林下轨",
                            "detail": f"收盘 {_round(last['close'])} < 下轨 {_round(last['boll_low'])}，弱势或有超跌反弹"})

    for s in signals:
        s["date"] = date
    return signals
