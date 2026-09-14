"""心理博弈引擎（纯计算，无 IO、不调 AI）

分析底层逻辑：价格不是随机波动，是四方资金的博弈结果——
  产业（套保盘）/ 主力（机构大资金）/ 投机（短线热钱）/ 散户（情绪盘）
本引擎用最原始的价、量、持仓三要素推断四方立场与意图，
核心产出：行情阶段 → 散户在想什么、会做什么 → 主力会如何利用 → 你该顺应什么。

输入数据（由 app.py 提供）：
  quote   实时行情（last/change_pct/position 持仓量/volume）
  daily   日线 list[{date,open,high,low,close,volume,hold}]
  minute  当日 1 分钟线 list[{datetime,open,high,low,close,volume,position}]
"""

from __future__ import annotations

from typing import Optional


def _f(v) -> Optional[float]:
    try:
        f = float(v)
        return f if f == f else None  # NaN -> None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- 行情阶段剧本库
# 每个阶段回答四个问题：散户在想什么 / 散户会做什么 / 主力在做什么 /
# 最危险的幻想是什么 / 该顺应什么。这是本应用的世界观核心。

PLAYBOOKS = {
    "高位加速": {
        "label": "高位加速冲顶",
        "desc": "价格处区间高位且短期急涨，情绪最亢奋、故事最性感的阶段",
        "retail_thinking": [
            "「每天看着它涨，不买就像在亏钱」——踏空焦虑压倒风险意识",
            "「这次逻辑不一样，还能再涨 X%」——给追高找基本面上的一万个理由",
            "「回调就是上车机会」——把主力出货制造的回抽当成恩赐",
        ],
        "retail_actions": [
            "FOMO 追多：越涨越买，仓位越加越大（最危险动作）",
            "回调挂多单等「上车」，接的往往是主力兑现的货",
            "空头止损后反手追多，成为最后一棒接力者",
        ],
        "main_force": (
            "高位急涨是主力兑现的最佳窗口：先用急拉吸引跟风盘进场，"
            "再在散户接力的位置分批出货。识别标志：放量滞涨（量放大但价不再创新高）、"
            "减仓上行（涨势靠空头回补而非新多）。若持仓大增且价格停滞后回落，警惕多头踩踏。"
        ),
        "fantasy": "「还能涨」的幻想。此处入场盈亏比全区间最差：上方空间被压缩，下方是整个涨幅的回吐空间。",
        "follow": "持仓者用移动止盈让利润奔跑、不主动加仓；空仓者禁止追高，等情绪退潮、缩量回调后再评估。",
        "trap_risk": 85,
    },
    "高位滞涨": {
        "label": "高位增仓滞涨",
        "desc": "价格高位横住但持仓持续增加——新钱在进场、老钱在对倒，多头正在拥挤",
        "retail_thinking": [
            "「横盘蓄势，马上要突破」——把出货平台解读成启动平台",
            "「持仓增加说明资金看好」——不知道高位增仓同样可能是空头主力进场",
            "「不等了，先买进去等突破」——提前埋伏在主力出货区",
        ],
        "retail_actions": [
            "提前埋伏多单等突破",
            "突破瞬间追多（恰是诱多经典的触发点）",
            "把止损放在平台下沿的显眼位置（扎堆扫损区）",
        ],
        "main_force": (
            "高位横盘+持仓增加是典型的对倒诱多结构：主力用小单推高、大单出货，"
            "维持「随时突破」的错觉。一旦跟风盘仓位饱和，一次增仓下行即可触发多杀多。"
            "真突破的确认是：缩量回踩不破平台+再度放量增仓上行。"
        ),
        "fantasy": "「蓄势待突破」的幻想。高位增仓滞涨里，突破失败的概率远高于成功。",
        "follow": "不提前埋伏；若持多单收紧止损至平台下沿；等方向用持仓量表决后再跟随。",
        "trap_risk": 75,
    },
    "高位回落": {
        "label": "高位回落",
        "desc": "价格从高位拐头向下，趋势可能反转的敏感窗口",
        "retail_thinking": [
            "「只是回调，趋势没坏」——用旧趋势的外推掩盖新信号",
            "「跌下来正好低接，摊低成本」——把出货当洗盘",
            "「跌这么多了，总该反弹吧」——用幅度代替逻辑",
        ],
        "retail_actions": [
            "逢低接多（接的是正在下落的主兑现盘）",
            "多单扛单不认错，等「回本再走」",
            "反弹时以为是反转重仓补多",
        ],
        "main_force": (
            "主力兑现后的回落不需要利空，只需要没有买盘。回抽常被用来确认出货完成度："
            "缩量弱反弹后再破位，是趋势反转的经典节奏。减仓下行=多头撤退，"
            "增仓下行=新空进场——后者下方空间通常更大。"
        ),
        "fantasy": "「回调上车」的幻想。从高位回落的每一次接多，都在为撤退的多头提供流动性。",
        "follow": "多头减仓/离场，不接飞刀；想反手做空也要等反弹衰竭信号，不追第一根大阴线。",
        "trap_risk": 65,
    },
    "趋势上行": {
        "label": "趋势上行中段",
        "desc": "价格站在大势分界上方、均线中枢抬升，资金仍在多头一侧",
        "retail_thinking": [
            "「涨太多了不敢买」——对正常趋势的恐高",
            "「我做空博个回调」——在多头趋势里找逆势的刺激",
            "「等深度回调再买」——趋势市里深度回调往往不来",
        ],
        "retail_actions": [
            "逆势摸顶空单（被趋势碾压）",
            "追在急涨点上、止损放太窄（被正常波动扫掉后行情继续）",
            "反复进出、赚小钱赔大钱， trend 吃不到",
        ],
        "main_force": (
            "趋势中段主力的任务是抬走散户的筹码：用震荡洗盘把不坚定多头洗下车，"
            "用逼空把空头止损盘变成燃料。增仓上行延续性最好；减仓上行则说明趋势进入兑现期。"
        ),
        "fantasy": "「到顶了」的摸顶幻想。趋势的终点无法预知，只能跟随。",
        "follow": "顺势持多或回调企稳后做多，止损放在结构位；不做逆势空单。",
        "trap_risk": 40,
    },
    "区间震荡": {
        "label": "区间震荡",
        "desc": "无趋势、无方向，存量资金在区间内高抛低吸",
        "retail_thinking": [
            "「突破在即，重仓埋伏」——震荡市里最贵的执念",
            "「到上沿了做空/到下沿了做多」——方向赌边界而非等确认",
            "「做三次小单练手感」——频繁交易给手续费打工",
        ],
        "retail_actions": [
            "频繁双向开仓，被来回双打",
            "区间边缘逆势赌反转",
            "突破瞬间追单（震荡市多数突破是假的）",
        ],
        "main_force": (
            "震荡区是主力的洗盘与建仓区：反复上下沿扫损收集筹码。"
            "成交缩量+持仓缓增=建仓期，放量+持仓大增=即将选方向。"
            "真正的突破会伴随持仓激增与量能连续放大，而非一根孤量。"
        ),
        "fantasy": "「马上要选择方向了，我先站队」的幻想。方向没出来之前，站队都是赌。",
        "follow": "降低频率：要么休息，要么只在区间边缘轻仓做回归；突破确认（持仓+量能双验证）后才顺势。",
        "trap_risk": 35,
    },
    "趋势下行": {
        "label": "趋势下行中段",
        "desc": "价格在大势分界下方、均线中枢下移，资金仍在空头一侧",
        "retail_thinking": [
            "「跌这么深了，空单该落袋了」——趋势未完先恐低",
            "「位置这么低，做多安全」——把低价当安全",
            "「跌不动了吧」——用感觉代替持仓量数据",
        ],
        "retail_actions": [
            "逢低抄底多单（逆资金方向）",
            "空单赚一点就跑，错过主跌段",
            "抄底被套后扛单、加仓摊平",
        ],
        "main_force": (
            "下行趋势里空头主力持续增仓下压，逼多头认输；每一次弱反弹都被用来加空。"
            "趋势终结的信号不是「跌多了」，而是：减仓下行转增仓上行、放量长下影、"
            "持仓明显下降+价格不再创新低。"
        ),
        "fantasy": "「跌够了」的抄底幻想。空头趋势里接多，接的是仍在下落的刀。",
        "follow": "顺势持空或反弹衰竭后进空；禁止抄底多单；多单被套者正视止损而非摊平。",
        "trap_risk": 45,
    },
    "低位阴跌": {
        "label": "低位阴跌",
        "desc": "价格低位、缩量缓跌，多头持续离场但恐慌未至",
        "retail_thinking": [
            "「都在历史低位了还能跌哪去」——低位不等于底部",
            "「越跌越买，长期肯定回来」——用股票思维做期货杠杆",
            "「空头也赚够了，该反弹了」——替主力规划利润",
        ],
        "retail_actions": [
            "分批抄底、越套越补（保证金先于行情见底）",
            "空单提前止盈离场",
            "把反弹当反转，重仓打捞",
        ],
        "main_force": (
            "阴跌是消耗战：产业套保盘+空头主力持续压制，多头止损盘分段离场。"
            "阴跌的可怕在于它不给你像样的反弹去减仓。底部确认需要看到：持仓下降（多头认输出清）"
            "后的放量增仓反攻，或深度贴水+产业买保进场。"
        ),
        "fantasy": "「低位=安全」的幻想。低位的下半场，往往才是杠杆散户的坟墓。",
        "follow": "不抄底、不摸顶：空单跟随移动止盈；多仓等出清信号（持仓下降+放量反攻）出现后再谈。",
        "trap_risk": 70,
    },
    "低位恐慌": {
        "label": "低位恐慌加速",
        "desc": "低位放量急跌——多头踩踏、空头狂欢，情绪最绝望的阶段",
        "retail_thinking": [
            "「完了，要归零了」——恐慌盘在最低区交出筹码",
            "「早知道早点割」——割在地板上的冲动最强",
            "「空头这是送钱，满仓干」——追空在最差盈亏比的位置",
        ],
        "retail_actions": [
            "多单割在恐慌最低点（主力接走筹码）",
            "空头追空在踩踏末端（反弹一触即发）",
            "多翻空、空翻多来回被打",
        ],
        "main_force": (
            "恐慌加速段是主力收筹区：踩踏的多头止损单恰是买盘来源。"
            "巨量长下影+随后持仓骤降，是出清完成的标志。空头主力开始获利回补时，"
            "价格弹性极大——减仓上行式反弹随时出现。"
        ),
        "fantasy": "双向幻想：多头幻想「跌无可跌」满仓抄底，空头幻想「趋势永远」追空加仓。两者都是给对手盘送流动性。",
        "follow": "多头不再割在急跌里（等反弹减）、空头不追空（移动止盈锁利）；等巨量出清信号后再定方向。",
        "trap_risk": 85,
    },
    "低位企稳": {
        "label": "低位放量企稳",
        "desc": "低位出现放量反攻或持仓出清后的止跌结构——左侧转向的最早信号",
        "retail_thinking": [
            "「狼来了太多次，这次也是假反弹」——被骗次数多了反而不信真信号",
            "「反弹就是给我减亏/做空的机会」——把转向当反抽",
            "「等回踩确认再买」——合理，但常常等不到深回踩",
        ],
        "retail_actions": [
            "反弹开空（赌新低）",
            "犹豫不决错过启动第一段",
            "过早重仓抄底（左侧信号仍需右侧确认）",
        ],
        "main_force": (
            "主力在恐慌出清后的低位悄悄回补/建多：特征是价格不创新低+持仓先降后升+"
            "回调缩量。确认信号：放量增仓阳线站上前期反弹高点。"
        ),
        "fantasy": "「还会再破一次位」的踏空幻想让人错过右侧确认；但左侧重仓同样是幻想——信号没确认前仓位就该轻。",
        "follow": "小仓试探多单（左侧半仓原则）或等右侧确认（放量增仓突破反弹高点）后顺势加；空头止盈离场。",
        "trap_risk": 40,
    },
}

REGIME_ORDER = list(PLAYBOOKS.keys())


# ---------------------------------------------------------------- 主力动机与收割链
# 博弈的底层是动机：每一方的利润从哪里来、谁在为他买单。
# 主力的利润 = 对手盘的被迫行为（止损、追涨、爆仓）；没有对手盘的错误，就没有主力的利润。

FORCE_MOTIVES = {
    "高位加速": {
        "motive": "兑现利润：急拉不是为了持有，是为了制造足够多的跟风买盘当对手",
        "chain": "急拉引跟风 → 跟风盘接力抬轿 → 高位滞涨分批出货 → 跌破启动位后，跟风盘的止损单变成下跌燃料",
    },
    "高位滞涨": {
        "motive": "维持「随时突破」的幻觉，让散户提前埋伏、接走筹码",
        "chain": "横盘蓄势叙事 → 散户埋伏多单等突破 → 一次增仓下行破位 → 埋伏盘与突破追入盘同时被套，双杀",
    },
    "高位回落": {
        "motive": "兑现已经开始，回抽是为了测试下方还有多少接货盘",
        "chain": "回落 → 散户「跌多了」低接 → 缩量弱反弹（诱多回抽）→ 再破位 → 低接盘层层被套成新的抛压",
    },
    "趋势上行": {
        "motive": "抬走散户筹码：洗盘吓走不坚定者，趋势本身逼空头缴械",
        "chain": "震荡洗盘扫掉多单止损 → 散户下车 → 续涨 → 空头止损与追多盘共同助燃 → 直到跟风盘饱和",
    },
    "区间震荡": {
        "motive": "双向收「保费」：区间边缘收割赌突破的和赌回归的两组止损",
        "chain": "上沿假突破扫掉空单止损 → 回落 → 下沿假跌破扫掉多单止损 → 双向收割，直到持仓和量能决议方向",
    },
    "趋势下行": {
        "motive": "逼多认输：每一次反弹都是加空和出货的位置",
        "chain": "反弹给「企稳」希望 → 散户抄底 → 增仓下压 → 抄底盘止损引发连锁下跌，抄底者互为燃料",
    },
    "低位阴跌": {
        "motive": "消耗多头耐心：不给像样的反弹，逼出带血筹码",
        "chain": "阴跌磨人心 → 多头熬不住陆续割肉 → 持仓持续下降（多头出清）→ 筹码换手完成前，任何反弹都乏力",
    },
    "低位恐慌": {
        "motive": "收筹：踩踏盘的止损单正是最廉价的买盘来源",
        "chain": "巨量破位制造绝望 → 恐慌割肉集中释放 → 长下影收回（收筹完成）→ 空头开始回补，价格弹性剧增",
    },
    "低位企稳": {
        "motive": "悄悄回补/建多：制造「还会再破一次位」的错觉，让散户把筹码交在低位",
        "chain": "不再创新低 → 散户等「肯定有二次探底」 → 放量增仓启动 → 等回踩的人等不到，追在半山腰",
    },
}


# ---------------------------------------------------------------- 人性定律（散户行为的根）
# 散户买的不只是头寸，是心理舒适：抄底买「我是聪明人」的感觉，追涨买「不落后于人」的安全感，
# 扛单回避「我错了」的痛苦，割肉在最痛处是为了结束煎熬。以下是不变的定律。

HUMAN_NATURE = {
    "loss_aversion": "损失厌恶：亏 1 块的痛 ≈ 赚 2 块的乐 → 亏损单扛得住、盈利单拿不住",
    "disposition": "处置效应：急于卖盈（兑现「我对了」的快感）、拖延卖亏（回避「我错了」的痛）→ 盈亏比倒挂",
    "anchoring": "锚定效应：锚定成本价（回本就卖）、锚定历史高低点（跌了 60% 就「便宜」）→ 位置感错乱",
    "recency": "近因外推：三根阳线就相信牛市，三根阴线就看到崩盘 → 在情绪极值处做方向",
    "fomo": "踏空焦虑：每天看着涨 = 每天都在亏钱的错觉 → 在最差盈亏比处追入",
    "fair_world": "公平世界幻觉：「跌这么久总该涨了」——把市场当道德主体；市场没有欠任何人一个反弹",
    "confirmation": "确认偏误：持仓后只找支持自己方向的证据，AI 和盘面都成了自我说服的工具",
    "illusion_of_control": "控制幻觉：盈利归因于技术，亏损归因于运气 → 系统性错误从不被修正",
}

# 各行情阶段激活的人性定律（散户画像的心理学标签）
NATURE_TAGS = {
    "高位加速": ["fomo", "recency", "fair_world"],
    "高位滞涨": ["confirmation", "anchoring"],
    "高位回落": ["anchoring", "loss_aversion", "disposition"],
    "趋势上行": ["illusion_of_control", "fair_world"],
    "区间震荡": ["illusion_of_control", "recency"],
    "趋势下行": ["fair_world", "anchoring"],
    "低位阴跌": ["loss_aversion", "disposition"],
    "低位恐慌": ["loss_aversion", "recency"],
    "低位企稳": ["confirmation", "fomo"],
}


# ---------------------------------------------------------------- 基础统计

def _ma(vals: list[float], n: int) -> Optional[float]:
    if len(vals) < n:
        return None
    return sum(vals[-n:]) / n


def trend_stats(daily: list[dict]) -> dict:
    """趋势与位置统计（只用价格与量仓，不涉及任何指标语言）"""
    rows = [r for r in daily[-120:] if _f(r.get("close"))]
    closes = [float(r["close"]) for r in rows]
    out = {
        "last": None,
        "pct60": None, "hi60": None, "lo60": None, "chg5": None, "chg20": None,
        "ma20": None, "ma20_prev": None, "ma20_rising": None,
        "above_ma20": None, "bias": "flat",
    }
    if len(closes) < 25:
        return out
    last = closes[-1]
    out["last"] = last
    win60 = closes[-60:] if len(closes) >= 60 else closes
    hi60, lo60 = max(win60), min(win60)
    out["pct60"] = round(sum(1 for c in win60 if c <= last) / len(win60) * 100, 1)
    out["hi60"], out["lo60"] = round(hi60, 2), round(lo60, 2)
    if len(closes) >= 6 and closes[-6]:
        out["chg5"] = round((last / closes[-6] - 1) * 100, 2)
    if len(closes) >= 21 and closes[-21]:
        out["chg20"] = round((last / closes[-21] - 1) * 100, 2)
    ma20 = _ma(closes, 20)
    ma20_prev = _ma(closes[:-3], 20)
    out["ma20"] = round(ma20, 2) if ma20 else None
    out["ma20_prev"] = round(ma20_prev, 2) if ma20_prev else None
    if ma20 and ma20_prev:
        out["ma20_rising"] = ma20 > ma20_prev
    if ma20:
        out["above_ma20"] = last > ma20
    # 大势偏向：位置+斜率+动量三票表决
    votes = 0
    if out["above_ma20"]:
        votes += 1
    elif out["above_ma20"] is False:
        votes -= 1
    if out["ma20_rising"]:
        votes += 1
    elif out["ma20_rising"] is False:
        votes -= 1
    if (out["chg20"] or 0) > 1:
        votes += 1
    elif (out["chg20"] or 0) < -1:
        votes -= 1
    out["bias"] = "up" if votes >= 2 else ("down" if votes <= -2 else "flat")
    return out


def capital_flow(daily: list[dict]) -> dict:
    """资金博弈（日线级）：价/量/持仓三要素的八状态矩阵 + 中期资金流向。
    这是推断主力行为的核心证据——持仓量变化=真金白银的仓位表态。"""
    rows = [r for r in daily[-60:] if _f(r.get("close")) and _f(r.get("volume")) is not None]
    out = {
        "state5": None, "price_chg5": None, "oi_chg5": None,
        "oi_trend20": None, "vol_ratio": None, "score": 0, "bias": "中性",
        "factors": [],
    }
    if len(rows) < 21:
        return out
    closes = [float(r["close"]) for r in rows]
    vols = [float(r.get("volume") or 0) for r in rows]
    holds = [float(r["hold"]) for r in rows if _f(r.get("hold")) is not None]

    out["price_chg5"] = round((closes[-1] / closes[-6] - 1) * 100, 2) if closes[-6] else None

    if not holds or sum(holds) == 0 or sum(vols) == 0:
        # 外盘数据源无持仓/成交量：降级为价格动量
        out["factors"].append("（数据源无持仓量，资金判断仅基于价格动量）")
        return out

    hold_all = [float(r.get("hold") or 0) for r in rows]
    # 换月保护：主连日线在主力合约切换日持仓会跳变（常 >40%），跨段比较无意义。
    # 从末尾向前找最后一个跳变点，只用其后同合约连续段做持仓统计。
    seg_start = 0
    for i in range(len(hold_all) - 1, 0, -1):
        a, b = hold_all[i], hold_all[i - 1]
        if a > 0 and b > 0 and abs(a / b - 1) > 0.4:
            seg_start = i
            break
    seg = hold_all[seg_start:]
    if len(seg) < 6:
        out["factors"].append(f"（主力合约近期换月（连续段仅 {len(seg)} 日），持仓类统计暂停）")
        out["state5"] = None
        return out
    # 持仓拥挤度：当前持仓在近 60 日的百分位（高位=拥挤，反转的燃料越充足）
    if seg[-1] > 0:
        out["oi_pct"] = round(sum(1 for h in hold_all if h <= seg[-1]) / len(hold_all) * 100, 1)
    win5 = seg[-5:]
    out["oi_chg5"] = round((win5[-1] - win5[0]) / win5[0] * 100, 2) if win5[0] else None
    if len(seg) >= 21 and seg[-21]:
        out["oi_trend20"] = round((seg[-1] - seg[-21]) / seg[-21] * 100, 2)
    elif seg[0]:
        # 连续段不足 21 日：用段内可比范围
        out["oi_trend20"] = round((seg[-1] - seg[0]) / seg[0] * 100, 2)

    v5 = sum(vols[-5:]) / 5
    v60 = sum(vols[-60:]) / 60
    out["vol_ratio"] = round(v5 / v60, 2) if v60 else None

    p5, o5 = out["price_chg5"], out["oi_chg5"]
    if p5 is not None and o5 is not None:
        up, adding = p5 > 0.3, o5 > 0.3
        if adding and up:
            out["state5"] = "增仓上行"
            out["factors"].append(f"5日涨 {p5:+.2f}% 且增仓 {o5:+.1f}%：新多资金主动进攻，趋势有真金背书")
        elif adding and not up:
            out["state5"] = "增仓下行"
            out["factors"].append(f"5日跌 {p5:+.2f}% 且增仓 {o5:+.1f}%：新空资金进场施压，勿急接飞刀")
        elif not adding and up:
            out["state5"] = "减仓上行"
            out["factors"].append(f"5日涨 {p5:+.2f}% 但减仓 {o5:+.1f}%：空头回补推涨，主力并未积极做多，涨势质量存疑")
        else:
            out["state5"] = "减仓下行"
            out["factors"].append(f"5日跌 {p5:+.2f}% 且减仓 {o5:+.1f}%：多头止损离场，空头获利兑现，跌势近尾声区")
    if out["oi_trend20"] is not None and abs(out["oi_trend20"]) >= 3:
        out["factors"].append(
            f"20日持仓{'增' if out['oi_trend20'] > 0 else '减'} {abs(out['oi_trend20']):.1f}%："
            f"中期资金{'持续进场（博弈升级）' if out['oi_trend20'] > 0 else '逐步撤离（博弈降温）'}")
    if out["vol_ratio"] is not None:
        if out["vol_ratio"] >= 1.5:
            out["factors"].append(f"量能为60日均量 {out['vol_ratio']} 倍：明显放量，关注度高")
        elif out["vol_ratio"] <= 0.7:
            out["factors"].append(f"量能仅为60日均量 {out['vol_ratio']} 倍：缩量，存量博弈")

    # 资金评分（-100~+100）：方向与持续性的粗刻度
    score = 0.0
    if out["state5"] == "增仓上行":
        score += 40
    elif out["state5"] == "增仓下行":
        score -= 40
    elif out["state5"] == "减仓上行":
        score += 10
    elif out["state5"] == "减仓下行":
        score -= 10
    if out["oi_trend20"] is not None:
        score += max(-20, min(20, out["oi_trend20"] * 2))
    out["score"] = int(max(-100, min(100, round(score))))
    out["bias"] = (
        "多头资金主导" if score >= 40 else "偏多" if score >= 15
        else "空头资金主导" if score <= -40 else "偏空" if score <= -15 else "资金分歧/中性"
    )
    return out


def intraday_flow(minute: list[dict]) -> dict:
    """日内量价仓结构（博弈的即时战场）：区间分位/短时动能/日内八状态/量能比"""
    out = {
        "day_high": None, "day_low": None, "pos_pct": None, "vwap": None, "vwap_dev": None,
        "chg5m": None, "chg15m": None, "chg30m": None, "pos_chg15": None, "pos_chg30": None,
        "state": None, "vol_ratio": None, "streak": 0,
    }
    rows = [r for r in minute if _f(r.get("close"))]
    if len(rows) < 20:
        return out
    day = rows[-1].get("datetime", "")[:10]
    today = [r for r in rows if str(r.get("datetime", "")).startswith(day)]
    if len(today) < 5:
        today = rows[-240:]
    last = float(rows[-1]["close"])
    out["day_high"] = max(float(r["high"] or r["close"]) for r in today)
    out["day_low"] = min(float(r["low"] or r["close"]) for r in today)
    rng = out["day_high"] - out["day_low"]
    out["pos_pct"] = round((last - out["day_low"]) / rng * 100, 1) if rng > 0 else 50.0
    vsum = sum(float(r.get("volume") or 0) for r in today)
    if vsum:
        out["vwap"] = round(sum(float(r["close"]) * float(r.get("volume") or 0) for r in today) / vsum, 2)
        out["vwap_dev"] = round((last / out["vwap"] - 1) * 100, 2)

    def _chg(n):
        if len(rows) >= n and float(rows[-n]["close"]):
            return round((last / float(rows[-n]["close"]) - 1) * 100, 2)
        return None

    out["chg5m"], out["chg15m"], out["chg30m"] = _chg(6), _chg(16), _chg(31)

    pos_now = _f(rows[-1].get("position"))
    p15 = _f(rows[-16].get("position")) if len(rows) >= 16 else None
    p30 = _f(rows[-31].get("position")) if len(rows) >= 31 else None
    if pos_now is not None and p15 is not None:
        out["pos_chg15"] = round(pos_now - p15)
    if pos_now is not None and p30 is not None:
        out["pos_chg30"] = round(pos_now - p30)

    # 量能比：近15分钟均量 vs 当日均量
    vols_day = [float(r.get("volume") or 0) for r in today]
    avg_day = sum(vols_day) / max(1, len(vols_day))
    avg15 = sum(float(r.get("volume") or 0) for r in rows[-15:]) / 15
    out["vol_ratio"] = round(avg15 / avg_day, 2) if avg_day > 0 else None

    # 连续同向分钟线（情绪惯性的直观刻度）
    streak = 0
    if rows[-1].get("close") and rows[-1].get("open"):
        d = 1 if float(rows[-1]["close"]) >= float(rows[-1]["open"]) else -1
        for r in reversed(rows):
            if not (r.get("close") and r.get("open")):
                break
            if (1 if float(r["close"]) >= float(r["open"]) else -1) == d:
                streak += 1
            else:
                break
        out["streak"] = streak if d > 0 else -streak

    # 日内八状态
    c15, pc15 = out["chg15m"], out["pos_chg15"]
    if c15 is not None and pc15 is not None:
        if c15 > 0.03 and pc15 > 0:
            out["state"] = "增仓上行"
        elif c15 > 0.03 and pc15 < 0:
            out["state"] = "减仓上行"
        elif c15 < -0.03 and pc15 > 0:
            out["state"] = "增仓下行"
        elif c15 < -0.03 and pc15 < 0:
            out["state"] = "减仓下行"
        else:
            out["state"] = "量价均衡"
    return out


# ---------------------------------------------------------------- 行情阶段判定

def _regime(ts: dict, cap: dict) -> str:
    pct, chg5 = ts.get("pct60"), ts.get("chg5")
    oi5 = cap.get("oi_chg5")
    vr = cap.get("vol_ratio")
    bias = ts.get("bias", "flat")
    if pct is None:
        return "区间震荡"
    # 高位区
    if pct >= 85 and (chg5 or 0) >= 3:
        return "高位加速"
    if pct >= 78 and abs(chg5 or 0) < 1.5 and (oi5 or 0) >= 2:
        return "高位滞涨"
    if pct >= 70 and (chg5 or 0) <= -2:
        return "高位回落"
    # 低位区
    if pct <= 15 and (chg5 or 0) <= -3:
        return "低位恐慌"
    if pct <= 25 and (chg5 or 0) < -1 and (oi5 is None or oi5 > -2):
        return "低位阴跌"
    if pct <= 30 and (vr or 0) >= 1.3 and (chg5 or 0) >= 1:
        return "低位企稳"
    if pct <= 30 and abs(chg5 or 0) < 1.5:
        return "低位阴跌" if bias == "down" else "区间震荡"
    # 中位区按大势
    if bias == "up" and (chg5 or 0) > -2:
        return "趋势上行"
    if bias == "down" and (chg5 or 0) < 2:
        return "趋势下行"
    return "区间震荡"


# ---------------------------------------------------------------- 博弈周期（吸筹→洗盘→主升→出货→出清）

def cycle_stage(ts: dict, cap: dict) -> dict:
    """用价格分位 × 持仓拥挤度 × 增减仓组合，定位当前处于博弈生命周期的哪一段"""
    oi_pct = cap.get("oi_pct")
    p = ts.get("pct60")
    st = cap.get("state5")
    chg20 = ts.get("chg20") or 0
    if p is None or oi_pct is None or not st:
        return {"stage": "观察期", "desc": "数据不足，周期定位待定"}
    if p >= 65 and oi_pct >= 70 and st in ("减仓上行", "减仓下行"):
        return {"stage": "出货退潮期", "desc": "价格高位 + 持仓从峰值回落：主力兑现进行中，趋势进入倒计时，每一次反弹都是撤退窗口"}
    if p >= 60 and st == "增仓下行":
        return {"stage": "高位转空期", "desc": "高位增仓下行：新空进场 + 高位多头踩踏，反转结构基本成立"}
    if p >= 60 and st == "增仓上行":
        return {"stage": "主升博弈期", "desc": "高位仍有新多进场：趋势未死，但接力棒正从主力传向情绪盘"}
    if oi_pct >= 75 and abs(chg20) < 3:
        return {"stage": "洗盘对峙期", "desc": "持仓高位横盘：多空主力对峙，谁先认输谁就当燃料；突破方向需持仓与量能共同表决"}
    if p <= 35 and oi_pct <= 35:
        if st == "增仓上行":
            return {"stage": "启动吸筹期", "desc": "价格与关注度双低 + 新多开始进场：周期最早的启动信号，可信度取决于增仓的持续性"}
        return {"stage": "冰点吸筹期", "desc": "价格与持仓双低：无人问津，恰是耐心资金建仓的温床（等持仓缓增确认）"}
    if p <= 35 and st == "减仓下行":
        return {"stage": "出清末期", "desc": "低位减仓下跌：多头陆续缴械，筹码在换手；反转要等新资金进场信号，不是「跌够了」"}
    if p <= 35 and st == "增仓下行":
        return {"stage": "空头压制期", "desc": "低位仍在增仓下行：空头还没吃饱，接多 = 挡在新空资金的路上"}
    if st == "增仓上行" and p < 60:
        return {"stage": "趋势展开期", "desc": "中低位增仓上行：新多进攻，趋势展开中，回踩是常态而非反转"}
    return {"stage": "观察期", "desc": "各要素未形成典型周期结构，等资金表态"}


# ---------------------------------------------------------------- 陷阱检测（可辨认的具体结构）

TRAP_NAMES = {
    "sweep_low": "🩸 下影扫损",
    "sweep_high": "🩸 上影扫损",
    "fake_break_up": "🎭 假突破（冲高跌回）",
    "fake_break_down": "🎭 假跌破（打穿收回）",
    "double_kill": "⚔️ 日内双杀",
    "crowded": "🔥 持仓拥挤",
    "tail_reversal": "⏰ 尾盘反向（两点半效应）",
    "round_zone": "🎯 整数关口扫损区",
}


def detect_traps(minute: list, ts: dict, cap: dict, intra: dict, regime_key: str) -> list[dict]:
    """用当日分钟线 + 持仓结构检测具体陷阱形态。返回 [{type, name, evidence, note}]"""
    traps: list[dict] = []
    rows = [r for r in minute if _f(r.get("close"))]

    def _add(t, evidence, note):
        traps.append({"type": t, "name": TRAP_NAMES[t], "evidence": evidence, "note": note})

    last = ts.get("last")
    if rows:
        day = str(rows[-1].get("datetime", ""))[:10]
        today = [r for r in rows if str(r.get("datetime", "")).startswith(day)]
        if len(today) >= 30 and last:
            now_t = str(today[-1].get("datetime", ""))[11:16]
            closes = [float(r["close"]) for r in today]
            # 陷阱判定统一用日内最新成交价（ts.last 是日线收盘，与分钟线口径不一致）
            last = float(today[-1]["close"]) or last
            day_high = max(float(r["high"] or r["close"]) for r in today)
            day_low = min(float(r["low"] or r["close"]) for r in today)
            hi_i = max(range(len(today)), key=lambda i: float(today[i]["high"] or today[i]["close"]))
            lo_i = min(range(len(today)), key=lambda i: float(today[i]["low"] or today[i]["close"]))
            hi_t = str(today[hi_i]["datetime"])[11:16]
            lo_t = str(today[lo_i]["datetime"])[11:16]
            opens = float(today[0]["open"] or today[0]["close"])
            ir = today[:30]
            ir_high = max(float(r["high"] or r["close"]) for r in ir)
            ir_low = min(float(r["low"] or r["close"]) for r in ir)

            def _vol_spike(idx, ratio=1.8):
                vols = [float(today[j].get("volume") or 0) for j in range(max(0, idx - 5), idx)]
                v_now = float(today[idx].get("volume") or 0)
                return vols and v_now > (sum(vols) / len(vols)) * ratio

            # T1 扫损：日内前低/前高被放量打穿后快速收回（止损被一笔收割）
            if lo_t >= "10:00" and (last / day_low - 1) * 100 >= 0.35 and _vol_spike(lo_i):
                _add("sweep_low",
                     f"{lo_t} 放量打穿 {day_low:g} 后收回，现价 {last:g}（低点距开盘 -{(1 - day_low / opens) * 100:.2f}%）",
                     "打穿关键低点又快速收回 = 大概率一笔大单扫掉了下方扎堆的止损，随后收回——追空的和割肉的同时被收割")
            if hi_t >= "10:00" and (1 - last / day_high) * 100 >= 0.35 and _vol_spike(hi_i):
                _add("sweep_high",
                     f"{hi_t} 放量冲高 {day_high:g} 后回落，现价 {last:g}（高点距开盘 +{(day_high / opens - 1) * 100:.2f}%）",
                     "冲高打穿上方止损/触发追涨后快速回落 = 典型上影扫损：追多盘被留在山顶")

            # T2 假突破：突破开盘区间后明显跌回（无持仓配合的突破）
            if day_high > ir_high and last < ir_high and (1 - last / day_high) * 100 > 0.35:
                _add("fake_break_up",
                     f"日内高点 {day_high:g} 曾上破开盘区间上沿 {ir_high:g}，现价已跌回区间内（{last:g}）",
                     "冲高跌回 + 若持仓未同步大增 = 诱多：突破追入盘此刻被套，区间上沿是收割线而非支撑线")
            if day_low < ir_low and last > ir_low and (last / day_low - 1) * 100 > 0.35:
                _add("fake_break_down",
                     f"日内低点 {day_low:g} 曾跌破开盘区间下沿 {ir_low:g}，现价已收回区间内（{last:g}）",
                     "打穿收回 + 若伴随放量长下影 = 打掉割肉盘后收回：跌破追空者被反手收割，下方「支撑破了」是错觉")

            # T3 双杀：日内高低点显著分离且都离开盘很远（双向收割日）
            if (day_high / opens - 1) > 0.006 and (1 - day_low / opens) > 0.006 and abs(hi_i - lo_i) >= 30:
                first, second = ("冲高", "跳水") if hi_i < lo_i else ("跳水", "拉升")
                _add("double_kill",
                     f"日内先{first}至{'高 ' + format(day_high, 'g') if hi_i < lo_i else '低 ' + format(day_low, 'g')}"
                     f"，后{second}至{'低 ' + format(day_low, 'g') if hi_i < lo_i else '高 ' + format(day_high, 'g')}"
                     f"（高低点相差 {abs(hi_i - lo_i)} 分钟）",
                     "双向打穿 = 双杀日：先扫一侧止损再反手扫另一侧，追单者两边挨打；此日不宜恋战，只做确认后的第二波")

            # T5 尾盘反向（用户验证过的「下午两点半效应」：趋势日尾盘常反向跳水）
            if now_t >= "14:15" and len(today) >= 40:
                tail = today[-30:]
                tail_chg = (tail[-1]["close"] / tail[0]["close"] - 1) * 100 if tail[0]["close"] else 0
                day_dir = 1 if last > opens else -1
                if abs(tail_chg) > 0.3 and tail_chg * day_dir < 0:
                    _add("tail_reversal",
                         f"尾盘 30 分钟 {tail_chg:+.2f}%，与日内方向（{'涨' if day_dir > 0 else '跌'}）相反",
                         "「两点半效应」：趋势日的尾盘反向急动高发——日内盈利单警惕尾盘回吐，勿在 14:30 后追加趋势单")

    # T4 拥挤：持仓拥挤度高位 + 单边阶段 → 一致预期反转时无人接盘
    oi_pct = cap.get("oi_pct")
    if oi_pct is not None and oi_pct >= 80 and regime_key in ("趋势上行", "趋势下行", "高位加速", "低位恐慌"):
        _add("crowded",
             f"持仓量处近 60 日 {oi_pct:.0f}% 分位（拥挤）+「{PLAYBOOKS[regime_key]['label']}」",
             "持仓拥挤 = 一致预期太满：方向延续时很爽，但反转时止损盘找不到对手盘，波动会被放大数倍——此时仓位纪律高于一切")

    # T6 整数关口：现价贴近散户止损扎堆区
    if last:
        step = 10 ** max(1, len(str(int(last))) - 2)
        nearest = round(last / step) * step
        if nearest and abs(last - nearest) / nearest < 0.004:
            side = "下方" if nearest < last else "上方"
            _add("round_zone",
                 f"现价 {last:g} 贴近整数关口 {nearest:g}",
                 f"{side} {nearest:g} 一带是散户止损扎堆区：最易被一笔大单打穿后再收回（把止损放关口上的单子是在替人递刀）")

    return traps[:5]


# ---------------------------------------------------------------- 四方立场推断

def _party_industry(ts: dict) -> dict:
    """产业资本：以价格在周期中的位置推断套保盘行为（无直接数据，标注推断）"""
    pct = ts.get("pct60")
    if pct is None:
        return {"stance": "未知", "evidence": "数据不足", "intent": "—", "confidence": "low"}
    if pct >= 78:
        return {
            "stance": "卖保压制（偏空）",
            "evidence": f"价格处 60 日 {pct:.0f}% 高位，产业卖出保值意愿强",
            "intent": "每一次冲高都会遇到套保卖单，上方空间被实盘压制",
            "confidence": "medium",
        }
    if pct <= 22:
        return {
            "stance": "买保支撑（偏多）",
            "evidence": f"价格处 60 日 {pct:.0f}% 低位，下游买保与产业惜售渐成支撑",
            "intent": "下方接盘变实，深跌需要更强的空头理由",
            "confidence": "medium",
        }
    return {
        "stance": "按需套保（中性）",
        "evidence": f"价格处 60 日 {pct:.0f}% 中位，产业不构成主导力量",
        "intent": "跟随现货节奏常规套保",
        "confidence": "low",
    }


def _party_institution(ts: dict, cap: dict, intra: dict) -> dict:
    """主力资金：以持仓量×价格的组合行为推断（证据最硬的一方）"""
    st = cap.get("state5")
    pct = ts.get("pct60") or 50
    ev = []
    if st:
        ev.append(f"日线{st}（5日价 {cap.get('price_chg5')}% / 持仓 {cap.get('oi_chg5')}%）")
    if cap.get("oi_trend20") is not None:
        ev.append(f"20日持仓{cap.get('oi_trend20'):+.1f}%")
    if intra.get("state") and intra["state"] != "量价均衡":
        ev.append(f"日内{intra['state']}（15分持仓 {intra.get('pos_chg15') or 0:+.0f}）")
    evidence = "；".join(ev) or "数据不足"

    if st == "增仓上行" and pct < 80:
        return {"stance": "多头进攻", "evidence": evidence,
                "intent": "新多持续进场推动趋势，逼空头回补；回调洗盘后倾向延续", "confidence": "high"}
    if st == "增仓上行" and pct >= 80:
        return {"stance": "高位多头拥挤（警惕）", "evidence": evidence,
                "intent": "涨势仍有钱推，但高位增量多为散户接力，主力随时转兑现", "confidence": "medium"}
    if st == "增仓下行" and pct > 20:
        return {"stance": "空头进攻", "evidence": evidence,
                "intent": "新空持续进场施压，逼多认输；反弹用于加空，勿接飞刀", "confidence": "high"}
    if st == "增仓下行" and pct <= 20:
        return {"stance": "低位空头拥挤（警惕）", "evidence": evidence,
                "intent": "空头仍在进攻但位置已低，获利回补随时引发暴力反弹", "confidence": "medium"}
    if st == "减仓上行":
        return {"stance": "空头回补（反弹质量差）", "evidence": evidence,
                "intent": "涨势靠空头止损而非新多，主力未积极做多，持续性存疑", "confidence": "medium"}
    if st == "减仓下行":
        return {"stance": "多头撤退 / 空头兑现", "evidence": evidence,
                "intent": "多头认输出清、空头开始获利了结，跌势进入尾声区但未反转", "confidence": "medium"}
    return {"stance": "无明确方向", "evidence": evidence,
            "intent": "持仓与价格未给出一致信号，等待资金表态", "confidence": "low"}


def _party_speculator(ts: dict, intra: dict) -> dict:
    """投机热钱：日内量能与短时动能的即时表态"""
    vr = intra.get("vol_ratio")
    c15 = intra.get("chg15m")
    streak = intra.get("streak") or 0
    if vr is None or c15 is None:
        return {"stance": "未知", "evidence": "日内数据不足", "intent": "—", "confidence": "low"}
    if vr >= 1.5 and c15 > 0.1:
        return {"stance": "放量追涨", "evidence": f"近15分钟量能 {vr}× 日均，15分 {c15:+.2f}%，连续 {abs(streak)} 根{'阳' if streak > 0 else '阴'}线",
                "intent": "热钱短线进攻，情绪升温——他们在赚情绪的钱，也在制造情绪", "confidence": "medium"}
    if vr >= 1.5 and c15 < -0.1:
        return {"stance": "放量杀跌", "evidence": f"近15分钟量能 {vr}× 日均，15分 {c15:+.2f}%",
                "intent": "热钱砸盘/止损潮，短线恐慌放大波动", "confidence": "medium"}
    if vr <= 0.7:
        return {"stance": "离场观望", "evidence": f"量能仅 {vr}× 日均，存量资金主导",
                "intent": "热钱不参与，波动缺乏燃料，追涨杀跌都难有延续", "confidence": "medium"}
    return {"stance": "正常参与", "evidence": f"量能 {vr}× 日均，15分 {c15:+.2f}%",
            "intent": "常规短线进出，无极端情绪", "confidence": "low"}


def _party_retail(regime_key: str, play: dict, ts: dict, cap: dict, intra: dict) -> dict:
    """散户：由行情阶段剧本 + 即时数据修正得出的群体心理画像（带人性定律标签）"""
    c15 = intra.get("chg15m") or 0
    thinking = list(play["retail_thinking"])
    actions = list(play["retail_actions"])
    # 即时情绪修正：日内急涨/急跌放大对应幻想
    if c15 >= 0.5:
        thinking.insert(0, f"「就在涨，现在不追就没了」——日内急涨 {c15:+.2f}% 正在实时制造踏空焦虑")
    elif c15 <= -0.5:
        thinking.insert(0, f"「跌成这样，博个反弹/割了吧」——日内急跌 {c15:+.2f}% 正在实时制造恐慌与抄底冲动")
    trap = play["trap_risk"]
    if abs(c15) >= 0.5:
        trap = min(100, trap + 5)
    nature = [
        {"tag": t, "text": HUMAN_NATURE[t]}
        for t in NATURE_TAGS.get(regime_key, [])
        if t in HUMAN_NATURE
    ]
    return {
        "stance": play["label"],
        "thinking": thinking,
        "actions": actions,
        "nature": nature,
        "trap_risk": trap,
        "confidence": "medium",
    }


# ---------------------------------------------------------------- 警告生成

def _warnings(regime_key: str, ts: dict, cap: dict, intra: dict) -> list[str]:
    out = []
    pct = ts.get("pct60")
    st5 = cap.get("state5")
    sti = intra.get("state")
    if regime_key == "高位加速":
        out.append("⛔ 禁止追多：高位急涨段入场=全区间最差盈亏比，你买到的大概率是主力的兑现盘")
    if regime_key == "高位滞涨":
        out.append("⛔ 禁止提前埋伏突破：高位增仓滞涨的「突破」多数是诱多；真突破需要缩量回踩+再放量增仓确认")
    if regime_key in ("低位阴跌", "低位恐慌") :
        out.append("⛔ 禁止抄底/摊平：低位不等于底部，空头仍在进攻时接多=逆资金方向；底部需要持仓出清+放量反攻确认")
    if regime_key == "高位回落":
        out.append("⚠ 多头勿扛单：高位回落中「等回本」的代价通常是更深的回撤；反弹是用来减仓的不是用来加仓的")
    if st5 == "减仓上行" and (pct or 50) >= 70:
        out.append("⚠ 反弹质量差：上行靠空头回补（减仓上行）而非新多，主力并未积极做多，追高谨慎")
    if sti == "增仓下行" and (intra.get("chg15m") or 0) < -0.2:
        out.append("⚠ 日内空头正在进攻（增仓下行）：此刻接多=和新空资金对赌，先让子弹飞")
    if sti == "增仓上行" and (intra.get("chg15m") or 0) > 0.2:
        out.append("ℹ 日内新多进场（增仓上行）：顺势方向偏多，但入场等回踩确认，不追急涨点")
    if regime_key == "趋势下行":
        out.append("⚠ 逆势多单=送流动性：趋势下行中每一次反弹都是主力加空的位置，你的多单就是对手盘")
    if regime_key == "趋势上行":
        out.append("ℹ 顺势方向偏多：可回调企稳后跟进，止损放结构位；勿摸顶做空")
    return out[:4]


# ---------------------------------------------------------------- 主入口

def analyze(symbol: str, name: str, quote: dict, daily: list, minute: list) -> dict:
    """四方心理博弈全景快照（纯计算）"""
    ts = trend_stats(daily)
    cap = capital_flow(daily)
    intra = intraday_flow(minute)
    regime_key = _regime(ts, cap)
    play = PLAYBOOKS[regime_key]

    # 今日持仓变化：实时持仓 vs 昨日日线持仓（跳变 >40% 视为换月污染，弃用）
    oi_now = _f(quote.get("position"))
    oi_chg_today = None
    if oi_now is not None:
        prev_holds = [_f(r.get("hold")) for r in daily[-3:-1]]
        prev_holds = [h for h in prev_holds if h is not None]
        if prev_holds and prev_holds[-1] > 0 and abs(oi_now / prev_holds[-1] - 1) <= 0.25:
            oi_chg_today = round(oi_now - prev_holds[-1])

    parties = {
        "industry": _party_industry(ts),
        "institution": _party_institution(ts, cap, intra),
        "speculator": _party_speculator(ts, intra),
        "retail": _party_retail(regime_key, play, ts, cap, intra),
    }

    fm = FORCE_MOTIVES.get(regime_key, {})
    cyc = cycle_stage(ts, cap)
    traps = detect_traps(minute, ts, cap, intra, regime_key)

    follow_map = {
        "增仓上行": "资金方向偏多——顺应多头，回调企稳做多",
        "增仓下行": "资金方向偏空——顺应空头，反弹衰竭做空",
        "减仓上行": "涨势缺真金——只持有不顺势加仓，不追高",
        "减仓下行": "跌势近尾声但未反转——空头锁利、多头等出清信号",
    }
    follow = follow_map.get(cap.get("state5"), "资金方向不明——降低频率，等持仓量表态")

    # 警告分层：先具体陷阱（有价位有时间的），后阶段泛化警告
    trap_warn_ids = {"sweep_low", "sweep_high", "fake_break_up", "fake_break_down", "double_kill", "tail_reversal", "crowded"}
    trap_warnings = [f"{t['name']}：{t['evidence']}——{t['note']}" for t in traps if t["type"] in trap_warn_ids]
    warnings = (trap_warnings + _warnings(regime_key, ts, cap, intra))[:5]

    snap = {
        "symbol": symbol,
        "name": name or "",
        "last": _f(quote.get("last")),
        "change_pct": _f(quote.get("change_pct")),
        "position": oi_now,
        "oi_chg_today": oi_chg_today,
        "volume": _f(quote.get("volume")),
        "time": quote.get("time", ""),
        "regime": {"key": regime_key, "label": play["label"], "desc": play["desc"]},
        "cycle": cyc,
        "traps": traps,
        "trend": ts,
        "capital": cap,
        "intraday": intra,
        "parties": parties,
        "playbook": {
            "main_force": play["main_force"],
            "force_motive": fm.get("motive", ""),
            "harvest_chain": fm.get("chain", ""),
            "fantasy": play["fantasy"],
            "follow": play["follow"],
            "risk": play.get("desc", ""),
        },
        "follow": follow,
        "warnings": warnings,
        "ts": None,  # 由调用方填
    }
    # 一句话结论
    pct = ts.get("pct60")
    snap["conclusion"] = (
        f"{play['label']}（60日{pct:.0f}%分位）"
        f"{'，' + cap['state5'] if cap.get('state5') else ''}"
        f"，{cyc['stage']}——散户陷阱指数 {parties['retail']['trap_risk']}/100，{follow}"
    )
    return snap


def to_context_text(snap: dict) -> str:
    """快照 → AI 上下文文字（紧凑、数值化）"""
    s = snap
    t, cap, intra = s["trend"], s["capital"], s["intraday"]
    lines = [
        f"【{s['symbol']}（{s['name']}）心理博弈快照（{s.get('time', '')}）】",
        f"- 行情阶段：{s['regime']['label']}——{s['regime']['desc']}",
        f"- 现价 {s['last']}（{s['change_pct']:+.2f}%），60日区间 {t.get('lo60')}~{t.get('hi60')}"
        f"（{t.get('pct60')}% 分位）；5日 {t.get('chg5') or 0:+.2f}% / 20日 {t.get('chg20') or 0:+.2f}%；"
        f"大势偏向：{ {'up': '上行', 'down': '下行', 'flat': '震荡'}[t.get('bias', 'flat')] }（20日中枢 {t.get('ma20')}）",
        f"- 资金博弈（日线）：{cap.get('state5') or '数据不足'}；20日持仓 {cap.get('oi_trend20') or 0:+.1f}%；"
        f"量能 {cap.get('vol_ratio') or 0}× 60日均量；资金评分 {cap['score']:+d}（{cap['bias']}）",
    ]
    for f in cap.get("factors", [])[:4]:
        lines.append(f"  - {f}")
    if intra.get("day_high"):
        lines.append(
            f"- 日内结构：区间 {intra['day_low']}~{intra['day_high']}（{intra.get('pos_pct')}% 分位），"
            f"VWAP {intra.get('vwap')}（偏离 {intra.get('vwap_dev') or 0:+.2f}%）；"
            f"15分 {intra.get('chg15m') or 0:+.2f}%，持仓15分 {intra.get('pos_chg15') or 0:+.0f}"
            f"（{intra.get('state') or '数据不足'}）；量能 {intra.get('vol_ratio') or 0}× 日均"
        )
    oi_t = s.get("oi_chg_today")
    if oi_t is not None:
        lines.append(f"- 今日持仓较昨收 {oi_t:+,.0f} 手（现 {s.get('position'):,.0f}）")
    p = s["parties"]
    lines.append(
        f"- 四方推断：产业[{p['industry']['stance']}]（{p['industry']['evidence']}）；"
        f"主力[{p['institution']['stance']}]（{p['institution']['evidence']}→{p['institution']['intent']}）；"
        f"投机[{p['speculator']['stance']}]（{p['speculator']['evidence']}）"
    )
    r = p["retail"]
    nature_txt = "；".join(n["text"] for n in (r.get("nature") or [])[:3])
    lines.append(
        f"- 散户画像：{r['stance']}，陷阱指数 {r['trap_risk']}/100；典型想法：{' / '.join(r['thinking'][:2])}；"
        f"可能操作：{' / '.join(r['actions'][:2])}"
        + (f"\n  激活的人性定律：{nature_txt}" if nature_txt else "")
    )
    lines.append(f"- 博弈周期：{s['cycle']['stage']}——{s['cycle']['desc']}")
    if s["playbook"].get("force_motive"):
        lines.append(f"- 主力动机：{s['playbook']['force_motive']}\n  收割链：{s['playbook']['harvest_chain']}")
    if s.get("traps"):
        for t in s["traps"]:
            lines.append(f"- 陷阱[{t['name']}]：{t['evidence']} → {t['note']}")
    lines.append(f"- 主力剧本：{s['playbook']['main_force']}")
    lines.append(f"- 程序结论：{s['conclusion']}")
    if s.get("warnings"):
        lines.append("- 程序警告：" + "；".join(s["warnings"]))
    return "\n".join(lines)
