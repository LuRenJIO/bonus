# 第五批开发方案（待执行）

> 状态：方案已确认（A+B+C+D），等指令开工。
> 四项共同特点：数据全部现成（成本/分红历史/日K/财务），无新数据源风险。

---

## A. 分红回本进度（收息记账页）

**视角**：把股息率翻译成"回本时间"——身体能感知的语言。

- **持仓行**新增：`回本 X.X 年`（成本 ÷ TTM 年分红）+ `今年已收回 x%`（yearDividend ÷ 持仓成本，有 cost 时）
- 后端：`handlePortfolio` items 内追加 `paybackYears`（cost×shares ÷ ttmDividend，ttm>0 时）、`recoveredPct`（今年口径）
- 无 cost 的持仓不显示；无改动风险
- 验收：portfolio 组新增断言 paybackYears 合理（0~100 年）

## B. 分红涨薪史 / A股股息贵族（详情页）

**视角**：A 股几乎没有产品做"每股分红增长史"。DPS 逐年增长 = "给你涨工资"。

- 详情页**分红历史卡之前**新增"分红涨薪史"卡：
  - 最近 8 个分红年度每股分红柱状图（wxml 柱状，复用 report 风格；数据 = `d.dividend.annual` 已有 [{year, perShare, times}]，**后端零改动**）
  - 每柱顶同比箭头（↑+12% / ↓-5%）
  - **徽章**：从最新年度往前数连续增长年数 g——g≥5 认证"🏆 股息贵族"，g≥3 "📈 增长稳定"，否则不显示
- 纯前端（stock 页三件套 + 柱高/同比 JS 预算，注意 WXML 禁函数调用教训）
- 验收：茅台应有 8 年柱 + 贵族徽章

## C. 买入回放器（再投模拟升级）

**视角**：回答"如果我在那个低点买了"——任选起点日 + 三层收益拆解。

- 后端 `handleReinvest` 加 `event.startDate`（可选 YYYY-MM-DD）：
  - `getDailyCloses` n = min(1300, ceil((today - startDate) 天 × 5/7) + 20)；startDate 早于数据则 clamp 到首日
  - 窗口 = [startDate, startDate + years×250 交易日] 与"今天"取近者
  - 缓存键加 startDate：`'ri:' + code + ':' + years + ':' + startDate`
  - 输出新增 `breakdown`：{ price: 价差收益, dividend: 现金分红（不再投）, reinvestGain: 再投增益 }（三者之和 = gainR 对应市值增量）
- 前端 reinvest 页：日期 picker（min = 数据最早日，默认 5 年前）替换/并列年限快捷键；结果卡加三层拆解（堆叠条：价差/分红/再投增益）
- 验收：startDate 参数生效断言 + 三层之和与 gainR 自洽断言

## D. 黄金坑信号（提醒引擎升级）

**视角**：持仓股跌出高股息时，区分"黄金坑"与"基本面恶化"。

- `checkAlerts`：触发阈值时补拉 `getFinanceMain(code, 0)` 最新报告期净利润同比：
  - 净利同比 ≥ 0 → `signal: 'gold'`（🟡 黄金坑：跌出来的高股息）
  - 净利同比 < 0 → `signal: 'warn'`（🔴 警惕：分红可持续性存疑）
  - 财务缺失 → `signal: 'plain'`
- `getFinanceMain` 加 12h 内存缓存（'fin:' + code，避免扫描时逐股重复拉取）
- 前端：首页横幅文案带信号 emoji；订阅消息 title 前缀"黄金坑/警惕"
- 纯逻辑单测进 test-scan-core 或新建：signal 分类函数三态
- 验收：现有 scan 断言不破 + 分类函数单测

---

## 执行顺序（开工时）

1. A + B（最小改动，先见效）→ 2. C（后端参数化 + 前端 picker）→ 3. D（提醒引擎）→ 4. 全量回归 + README + zip
2. 每步跑：check-wxml（全输出！）+ check-config + test-stock-service + test-dividend-ttm + test-scan-core
