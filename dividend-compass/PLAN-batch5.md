# 第五批开发方案（已完成 ✅）

> 状态：**B + C + D 已全部落地并通过全量回归**（A 回本进度经评审不做）。
> 实测：回放器三层拆解自洽（长电 2022-04-27 起点：价差30245+分红11795+再投增益2772=44812元）；signal 三态单测 9 例全过。

---

## B. 分红涨薪史 / A股股息贵族（详情页）

**视角**：A 股几乎没有产品做"每股分红增长史"。DPS 逐年增长 = "给你涨工资"。

- 详情页**分红历史卡之前**新增"分红涨薪史"卡：
  - 最近 8 个分红年度每股分红柱状图（wxml 柱状，复用 report 风格；数据 = `d.dividend.annual` 已有 [{year, perShare, times}]，**后端零改动**）
  - 每柱顶同比箭头（↑+12% / ↓-5%）
  - **徽章**：从最新年度往前数连续增长年数 g——g≥5 认证"🏆 股息贵族"，g≥3 "📈 增长稳定"，否则不显示
- 纯前端（stock 页三件套 + 柱高/同比 JS 预算，注意 WXML 禁函数调用教训）
- 已知局限：大额特别分红会干扰连续性判断（v1 按年度合计，卡内注明；v2 可识别特别分红单独标注）
- 验收：茅台应有 8 年柱 + 贵族徽章

## C. 买入回放器（再投模拟升级）

**视角**：回答"如果我在那个低点买了"——任选起点日 + 三层收益拆解（价差/现金分红/再投增益）。

- 后端 `handleReinvest` 加 `event.startDate`（可选 YYYY-MM-DD）：
  - `getDailyCloses` n = min(1300, ceil((today - startDate) 天 × 5/7) + 20)；startDate 早于数据则 clamp 到首日
  - 窗口 = [startDate, startDate + years×250 交易日] 与"今天"取近者
  - 缓存键加 startDate：`'ri:' + code + ':' + years + ':' + startDate`
  - 输出新增 `breakdown`：{ price: 价差收益, dividend: 现金分红（不再投）, reinvestGain: 再投增益 }（三者之和 = 再投策略市值增量，自洽校验）
- 前端 reinvest 页：日期 picker（min = 数据最早日，默认 5 年前）与年限快捷键并列；结果卡加三层拆解（堆叠条 + 图例行）
- 验收：startDate 参数生效断言 + 三层之和与 gainR 自洽断言

## D. 黄金坑信号（提醒引擎升级）

**视角**：持仓股跌出高股息时，区分"黄金坑"与"基本面恶化"。

- `checkAlerts`：触发阈值时补拉 `getFinanceMain(code, 0)` 最新报告期净利润同比：
  - 净利同比 ≥ 0 → `signal: 'gold'`（🟡 黄金坑：跌出来的高股息）
  - 净利同比 < 0 → `signal: 'warn'`（🔴 警惕：分红可持续性存疑）
  - 财务缺失 → `signal: 'plain'`
- `getFinanceMain` 加 12h 内存缓存（'fin:' + code，避免扫描时逐股重复拉取）
- 前端：首页横幅文案带信号 emoji；订阅消息 title 前缀"黄金坑/警惕"；文案带"仅供研究参考"
- 已知局限：净利润同比为滞后指标（季报/年报更新节奏）
- 验收：现有 scan 断言不破 + 分类函数三态单测

---

## 执行顺序（开工时）

1. B（纯前端，先见效）→ 2. C（后端参数化 + 前端 picker + 拆解）→ 3. D（提醒引擎 + 缓存）→ 4. 全量回归 + README 功能表 + zip
2. 每步跑：check-wxml（全输出，不吞结果！）+ check-config + test-stock-service + test-dividend-ttm + test-scan-core
