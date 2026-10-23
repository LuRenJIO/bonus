# 拾息记 UI 深色金融质感升级计划

> 方向已确认：保持深色金主题 → 质感升级；全部 9 页套用；图标 = 内联 SVG 线性风格（iconfont 视觉、零加载成本）。
> 铁律：不改动任何 JS 逻辑、数据流、云函数、页面路由；纯 WXML 类名/结构微调 + WXSS 升级。

## Summary

在不动业务逻辑的前提下，把"功能密度极好但视觉扁平"的 UI 升级为有层级的券商质感：
设计令牌体系化（金渐变/卡片两级/字号阶梯/间距节奏）→ 全局组件精修（卡片/标题锚点/按压反馈/骨架屏）→ 9 页统一套用 → 微动效（仅 transform/opacity，GPU 合成）。零图片资源、零字体文件、零 JS 动画库——加载速度只快不慢。

## Current State（探索结论）

- `app.wxss`：12 个全局变量（--bg/--card/--gold/--up/--down 等），.card 单一同质样式（同底色/16rpx 圆角/无阴影/无边框），.num 等宽数字已就位
- 图标现状：emoji 直接当图标（首页快捷入口 📅💰🔍、搜索 🔍、提醒 🔔、免责 ⓘ）——iOS/安卓渲染不一致、廉价感
- 交互反馈：全项目未使用 hover-class，点击无按压反馈；加载态为纯文字"加载中…"
- 9 页共用 .card/.card-title 体系 → 改 app.wxss 令牌可全局生效，各页仅做局部类名/图标替换
- 各页 WXSS 里大量页面级样式与全局类并存（需保持不动，只叠加增强类）

## Proposed Changes

### 1. 设计令牌升级 — `app.wxss`

- 金色体系：`--gold-hi:#F0D08A / --gold-deep:#9A7420 / --gold-grad:linear-gradient(135deg,#F0D08A,#D4A94E)`；数字辉光 `--gold-glow:0 0 18rpx rgba(212,169,78,.25)`
- 卡片两级：`.card` 升级为渐变底（180deg #1A2029→#161B22）+ 1rpx var(--border) 边 + 柔和阴影 `0 8rpx 24rpx rgba(0,0,0,.35)`；新增 `.card-accent`（金色左竖条渐变 mark，用于强调卡）
- 标题锚点：`.card-title::before` 3×26rpx 金渐变小竖条（全项目标题统一视觉锚）
- 字号阶梯：新增 `.t-hero`(44rpx/700) `.t-big`(36rpx) `.num-strong`(32rpx 700 金)——金融大数字表现力
- 按压反馈：`.press` 类（hover-class 用）`transform:scale(.985)` + 背景 var(--card-hover)，transition 0.12s
- 骨架屏：`.skeleton` shimmer 类（线性渐变背景位移动画，替代纯文字加载态）
- 圆角/间距节奏：`--radius-lg:20rpx --radius-md:12rpx`，卡片 margin 统一 24rpx

### 2. 图标组件 — 新建 `components/ui-icon/*`（js/json/wxml/wxss 四件套）

- **内联 SVG data-URI + CSS mask 实现**：视觉 = iconfont 线性风格（1.5px 描边、圆角端点），实现 = 零字体文件、零网络请求、金色着色随 mask 背景色
- 用法：`<ui-icon name="calendar" />`；首批 12 个：calendar/coin/funnel/gold/search/bell/chart/book/close/arrow/plus/star
- 所有页面快捷入口、搜索框、提醒横幅、页内功能链接统一替换 emoji → ui-icon

### 3. 首页 — `pages/index/*`

- 快捷入口：emoji → ui-icon（金渐变容器 40px）
- 搜索框：容器升级（卡底+边框+聚焦金边态）、内嵌 search 图标
- 速览卡：6 格改分组卡（涨跌 cell 淡色底/金色 cell 数字辉光）
- 自选行：金色 mark 竖条 + hover 按压 + 价格数字 .num-strong
- 金价条/提醒横幅/最近浏览 chips：卡片化统一
- 首屏 loading → 骨架屏（速览+自选两块占位）

### 4. 详情页 — `pages/stock/*`

- 股息率核心数字 hero 化（.t-hero + 金辉光），TTM 明细行重排
- 分区标题自动获得 marker（全局生效）；风险/体检卡套 .card-accent
- 分时/日K tab 与黄金页 g-tab 统一样式

### 5. 其余 7 页 — portfolio/report/calendar/screener/reinvest/taxcalc/gold/indexchart

- 卡片/标题/按钮/空态自动继承新体系（改令牌即生效）
- 局部：screener 筛选按钮金渐变化；report 分享按钮金渐变；portfolio 汇总数字 .t-big；gold 页沿用自己的 g-tab（已达标）；日历月份头升级
- 全部可点行补 hover-class="press"

### 6. 性能保障（用户硬性要求）

- 零新增网络请求：图标 SVG data-URI 内联（比 iconfont 少一次字体下载）
- 动画仅 transform/opacity（GPU 合成层，不触发重排）；每屏 box-shadow 控制在轻量级别（不叠多层大 blur）
- 无图片资源、无字体文件、无 JS 动画库；分包结构不变
- 骨架屏 shimmer 用 background-position 动画（合成器友好）

## Assumptions & Decisions

- 用户已确认：深色金融质感方向、9 页全量、iconfont 视觉
- 我的技术决策：用内联 SVG mask 组件而非真 iconfont 字体——视觉等价且快于 iconfont（少一次字体请求与 FOUT）；如后续确需扩展图标，往组件里加 path 即可
- WXML 结构只做类名替换与图标节点插入，不改变任何绑定/事件/数据流
- 逐页改动顺序：app.wxss → ui-icon 组件 → 首页 → 详情 → 其余 7 页

## Verification

1. `node local-test/check-wxml.js` + `check-config.js` 全过（每步必跑，全输出）
2. `test-stock-service / test-dividend-ttm / test-scan-core` 全绿（UI 改动不应影响，确认无副作用）
3. 开发者工具逐页编译预览：9 页视觉检查清单（卡片层级/图标渲染/按压反馈/骨架屏）
4. 性能：开发者工具 Audits 体验分不回退；切换页无卡顿；图标无网络请求（Network 面板确认）
5. 功能回归：搜索/加自选/除息弹层/切换走势模式/计算器等关键交互手测一遍
