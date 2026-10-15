/**
 * 云函数：stock-service —— 拾息记核心数据服务
 *
 * action:
 *   search   {keyword}            模糊搜索沪深A股
 *   quote    {code, market?}      实时行情
 *   overview {code, market?, name?} 全量数据：行情+分红+财报+股息率+预测+体检
 *
 * 零外部依赖，无需 npm install，右键"上传并部署"即可。
 * 注意：请在云开发控制台将本函数超时时间调整为 20 秒（默认 3 秒不够）。
 */

const ds = require('./lib/dataSource');
const div = require('./lib/dividend');
const pred = require('./lib/prediction');
const { healthCheck } = require('./lib/health');
const { calcRiskMetrics } = require('./lib/risk');

/** 类型安全数字判断（注意 isFinite(null) === true 的 JS 陷阱，不可直接用 isFinite 判空） */
function isNum(v) { return typeof v === 'number' && isFinite(v); }

// 内存缓存（云函数实例存活期间有效）：行情 60s，其余 5min
const cache = new Map();
function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  if (hit) cache.delete(key);
  return undefined;
}
function cacheSet(key, v) { cache.set(key, { t: Date.now(), v }); }

function ok(data) { return { success: true, data }; }
function fail(msg) { return { success: false, error: msg }; }

/* ---------------- 搜索 ---------------- */
async function handleSearch(event) {
  const keyword = String(event.keyword || '').trim();
  if (!keyword) return ok([]);
  const list = await ds.searchStock(keyword);
  return ok(list.slice(0, 12));
}

/* ---------------- 行情 ---------------- */
async function handleQuote(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('股票代码格式错误');
  const ck = 'q:' + code;
  const cached = cacheGet(ck, 60 * 1000);
  if (cached) return ok(cached);
  const quote = await ds.getQuote(code, event.market);
  cacheSet(ck, quote);
  return ok(quote);
}

/* ---------------- 批量行情（自选列表） ---------------- */
async function handleQuotes(event) {
  const list = Array.isArray(event.list) ? event.list : [];
  const ck = 'qs:' + list.map((i) => i.code).join(',');
  const cached = cacheGet(ck, 60 * 1000);
  if (cached) return ok(cached);
  const quotes = await ds.quoteBatch(list);
  cacheSet(ck, quotes);
  return ok(quotes);
}

/* ---------------- 全量聚合 ---------------- */
async function handleOverview(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('股票代码格式错误');
  const market = event.market || (/^(6|9)/.test(code) ? 'SH' : 'SZ');

  const ck = 'ov:' + code;
  // 前端显式刷新（refresh=true）时绕过缓存，保证行情为最新
  if (!event.refresh) {
    const cached = cacheGet(ck, 5 * 60 * 1000);
    if (cached) return ok(cached);
  }

  // 并行抓取七路数据（沪深300月K 带12小时缓存，多个股票共享）
  const [quote, financeAnnualAll, financeReportsAll, dividendRaw, consensus, monthlyCloses, indexCloses] = await Promise.all([
    ds.getQuote(code, market).catch(() => null),
    ds.getFinanceMain(code, 1).catch(() => []),   // 按年度
    ds.getFinanceMain(code, 0).catch(() => []),   // 按报告期
    ds.getDividendHistory(code).catch(() => []),
    ds.getAnalystConsensus(code).catch(() => null), // 机构一致预期（研报聚合）
    ds.getMonthlyCloses(code, market, 66).catch(() => null), // 月末收盘价（股息率曲线）
    getIndexCloses(),                              // 沪深300月末收盘（Beta基准）
  ]);

  if (!quote) return fail('行情获取失败，请稍后重试');

  const financeAnnual = financeAnnualAll.filter((f) => f.reportDate).slice(0, 6);   // 最近6个年度
  const financeReports = financeReportsAll.filter((f) => f.reportDate).slice(0, 12); // 最近12个报告期
  const latestReport = financeReports[0] || null;

  // 分红解析与计算
  const { implemented, pending } = div.parseDividends(dividendRaw);
  const ttm = div.calcTTMDividend(implemented);
  const annualAgg = div.aggregateAnnual(implemented);
  const payoutRatios = div.calcPayoutRatios(annualAgg, financeAnnualAll);

  // 年度视图合并（年度分红 + 派息率 + 当年净利），按时间由近到远排列
  const annualView = annualAgg.slice(-6).map((a) => {
    const pr = payoutRatios.find((p) => p.year === a.year);
    return {
      year: a.year,
      perShare: +a.perShare.toFixed(4),
      times: a.times,
      payoutRatio: pr ? pr.payoutRatio : null,
      netProfit: pr ? pr.netProfit : null,
      yieldNow: quote.price ? +((a.perShare / quote.price) * 100).toFixed(2) : null, // 该年度分红/现价
      records: a.records,
    };
  }).reverse();

  const ttmYield = quote.price && ttm.perShare > 0 ? +((ttm.perShare / quote.price) * 100).toFixed(2) : null;

  // 最新每股未分配利润：优先最新报告期财报，其次最新分红记录
  let perUnassign = latestReport && isNum(latestReport.perUnassignProfit) ? latestReport.perUnassignProfit : null;
  if (perUnassign === null && dividendRaw.length && isNum(dividendRaw[0].perUnassignProfit)) {
    perUnassign = dividendRaw[0].perUnassignProfit;
  }
  const latestDebtRatio = latestReport && isNum(latestReport.debtRatio) ? latestReport.debtRatio : null;

  // 预测（多模型区间 + 盈利修正，含机构一致预期）
  const totalShares = quote.totalShares || (implemented[0] && implemented[0].totalShares) || null;
  const prediction = pred.predict(
    annualAgg, payoutRatios, financeAnnual, financeReports, quote.price, totalShares, consensus
  );

  // 分红可持续性体检
  const health = healthCheck({
    payoutRatios,
    annualAgg,
    financeAnnual,
    ttmDividend: ttm,
    perUnassignProfit: perUnassign,
    latestDebtRatio,
  });

  const name = quote.name || event.name || (dividendRaw[0] && dividendRaw[0].name) || '';

  const result = {
    name,
    code,
    market,
    quote,
    dividend: {
      ttm: { perShare: ttm.perShare, yield: ttmYield, detail: ttm.detail },
      annual: annualView,
      implementedRecent: implemented.slice(0, 12).map((it) => ({
        exDate: it.exDate, bonusYear: it.bonusYear, perShare: +it.perShare.toFixed(4),
        profile: it.profile, progress: it.progress,
      })),
      pending: pending.slice(0, 5).map((it) => ({
        planNoticeDate: it.planNoticeDate, bonusYear: it.bonusYear,
        perShare: +it.perShare.toFixed(4), profile: it.profile, progress: it.progress,
      })),
    },
    finance: {
      annual: financeAnnual.slice(0, 5),
      latest: latestReport,
    },
    consensus: consensus ? {           // 机构一致预期摘要（可能为 null：无研报覆盖）
      count: consensus.count,
      industryName: consensus.industryName || quote.industryName || null,
      latestDate: consensus.latestDate,
      ratings: consensus.ratings,
      medianByYear: consensus.medianByYear,
    } : null,
    prediction,
    yieldCurve: (() => {
      const yc = div.calcYieldSeries(
        implemented,
        monthlyCloses,
        prediction.enhanced ? prediction.enhanced.yields.neutral : (prediction.basic ? prediction.basic.yields.neutral : null)
      );
      if (yc) yc.percentile = div.yieldPercentile(yc.points);
      return yc;
    })(),
    risk: calcRiskMetrics(monthlyCloses, indexCloses),
    health,
    meta: {
      perUnassignProfit: perUnassign,
      totalShares,
      calcTime: new Date().toISOString(),
    },
  };

  cacheSet(ck, result);
  return ok(result);
}

/* ---------------- 首页红利速览（10分钟缓存） ---------------- */
async function handleHomeBrief() {
  const ck = 'brief';
  const cached = cacheGet(ck, 10 * 60 * 1000);
  if (cached) return ok(cached);

  const today = div.toDateStr(new Date());
  const [sh, csi, hs300, cal7] = await Promise.all([
    ds.getQuote('000001', 'SH').catch(() => null),   // 上证指数（大盘参照）
    ds.getQuote('000922', 'SH').catch(() => null),   // 中证红利指数
    ds.getQuote('000300', 'SH').catch(() => null),   // 沪深300指数
    ds.getExDividendCalendar(7).catch(() => []),
  ]);

  // 今日除息（按代码去重，防同股多条记录重复计派现）；7日除息总数
  const todayMap = {};
  let weekCount = 0;
  (cal7 || []).forEach((r) => {
    weekCount++;
    if (r.exDate === today && !todayMap[r.code]) todayMap[r.code] = r;
  });
  const exTodayList = Object.values(todayMap);
  let cashSum = 0;
  exTodayList.forEach((r) => {
    if (isNum(r.totalShares) && r.totalShares > 0) cashSum += r.perShare * r.totalShares;
  });

  const result = {
    date: today,
    shIndex: sh && isNum(sh.price) ? { price: sh.price, changePercent: sh.changePercent } : null,
    csiDividend: csi && isNum(csi.price) ? { price: csi.price, changePercent: csi.changePercent } : null,
    hs300: hs300 && isNum(hs300.price) ? { price: hs300.price, changePercent: hs300.changePercent } : null,
    exTodayCount: exTodayList.length,
    exTodayCash: cashSum > 0 ? +(cashSum / 1e8).toFixed(1) : null,   // 今日派现总额（亿元）
    exWeekCount: weekCount,
    exTodayTop: exTodayList.slice(0, 50).map((r) => ({ code: r.code, name: r.name, perShare: r.perShare })),
  };
  cacheSet(ck, result);
  return ok(result);
}

/* ---------------- 股息率提醒检查（前端红点降级方案 / 与定时扫描同口径） ---------------- */
async function handleCheckAlerts(event) {
  const rules = (Array.isArray(event.list) ? event.list : [])
    .filter((r) => r && /^\d{6}$/.test(String(r.code)) && isNum(Number(r.threshold)) && Number(r.threshold) > 0)
    .slice(0, 20);
  if (!rules.length) return ok([]);

  const list = rules.map((r) => ({
    code: String(r.code),
    name: r.name || '',
    threshold: +Number(r.threshold).toFixed(2),
  }));
  const ck = 'al:' + list.map((r) => r.code + ':' + r.threshold).join(',');
  const cached = cacheGet(ck, 5 * 60 * 1000);
  if (cached) return ok(cached);

  const [quotes, divLists] = await Promise.all([
    ds.quoteBatch(list.map((r) => ({ code: r.code, market: r.market || (/^(6|9)/.test(r.code) ? 'SH' : 'SZ') }))).catch(() => []),
    Promise.all(list.map((r) => ds.getDividendHistory(r.code).catch(() => []))),
  ]);
  const qMap = {};
  quotes.forEach((q) => { qMap[q.code] = q; });

  const out = list.map((r, idx) => {
    const quote = qMap[r.code] || {};
    const { implemented } = div.parseDividends(divLists[idx]);
    const ttm = div.calcTTMDividend(implemented);
    const ttmYield = isNum(quote.price) && quote.price > 0 && ttm.perShare > 0
      ? +((ttm.perShare / quote.price) * 100).toFixed(2)
      : null;
    return {
      code: r.code,
      name: quote.name || r.name || r.code,
      price: isNum(quote.price) ? quote.price : null,
      ttmYield,
      threshold: r.threshold,
      triggered: ttmYield !== null && ttmYield >= r.threshold,
    };
  });
  cacheSet(ck, out);
  return ok(out);
}

/* ---------------- 指数走势（分时/历史） ---------------- */
async function handleIndexChart(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('指数代码格式错误');
  const market = event.market || 'SH';

  if (event.mode === 'history') {
    const range = event.range === '5y' ? '5y' : '1y';
    const ck = 'ih:' + code + ':' + range;
    const cached = cacheGet(ck, 12 * 3600 * 1000);
    if (cached) return ok(cached);
    let points = null;
    if (range === '1y') {
      const daily = await ds.getDailyCloses(code, market, 260).catch(() => null);
      points = daily ? daily.map((x) => ({ d: x.date, price: x.close })) : null;
    } else {
      const monthly = await ds.getMonthlyCloses(code, market, 66).catch(() => null);
      points = monthly ? monthly.map((x) => ({ d: x.ym, price: x.close })) : null;
    }
    if (!points || points.length < 10) return fail('历史数据获取失败');
    const result = { kind: 'history', range, points };
    cacheSet(ck, result);
    return ok(result);
  }

  // 分时（交易时段内 60 秒缓存）
  const ckm = 'im:' + code;
  const cachedM = cacheGet(ckm, 60 * 1000);
  if (cachedM) return ok(cachedM);
  const d = await ds.getIndexMinute(code, market).catch(() => null);
  if (!d) return fail('分时数据获取失败');
  const resultM = { kind: 'minute', preClose: d.preClose, points: d.points };
  cacheSet(ckm, resultM);
  return ok(resultM);
}

/* ---------------- 沪深300月K（12小时缓存，全股票共享） ---------------- */
async function getIndexCloses() {
  const cached = cacheGet('idx:hs300', 12 * 3600 * 1000);
  if (cached) return cached;
  const list = await ds.getIndexMonthlyCloses(66).catch(() => null);
  if (list) cacheSet('idx:hs300', list);
  return list;
}

/* ---------------- 分红日历 ---------------- */
async function handleCalendar(event) {
  let days = parseInt(event.days, 10);
  if (!isNum(days)) days = 30;
  days = Math.max(7, Math.min(days, 90));

  // 全市场未来除息（12小时缓存）
  const ck = 'cal:' + days;
  let market = cacheGet(ck, 12 * 3600 * 1000);
  if (!market) {
    market = await ds.getExDividendCalendar(days).catch(() => []);
    if (market.length) cacheSet(ck, market);
  }

  // 自选股近期分红（含预案），前端传入 codes: [{code, name, market}]
  let fav = [];
  const codes = (Array.isArray(event.codes) ? event.codes : [])
    .filter((c) => c && /^\d{6}$/.test(String(c.code))).slice(0, 20);
  if (codes.length) {
    const results = await Promise.all(codes.map(async (c) => {
      try {
        const raw = await ds.getDividendHistory(c.code);
        const list = div.upcomingDividends(raw, 90);
        return list.length ? { code: c.code, name: c.name || (raw[0] && raw[0].name) || c.code, items: list } : null;
      } catch (e) { return null; }
    }));
    fav = results.filter(Boolean);
  }

  return ok({ days, market, fav });
}

/* ---------------- 收息记账（组合计算） ---------------- */
async function handlePortfolio(event) {
  const holdings = (Array.isArray(event.holdings) ? event.holdings : [])
    .filter((h) => h && /^\d{6}$/.test(String(h.code)) && isNum(Number(h.shares)) && Number(h.shares) > 0)
    .slice(0, 20);
  if (!holdings.length) return ok({ items: [], summary: null });

  // 5分钟缓存（同一组合重复刷新不重复抓取）
  const ck = 'pf:' + holdings.map((h) => h.code + ':' + h.shares).join(',');
  const cached = cacheGet(ck, 5 * 60 * 1000);
  if (cached) return ok(cached);

  const year = new Date().getFullYear();
  const list = holdings.map((h) => ({
    code: String(h.code),
    market: h.market || (/^(6|9)/.test(h.code) ? 'SH' : 'SZ'),
    shares: Number(h.shares),
    cost: isNum(Number(h.cost)) && Number(h.cost) > 0 ? Number(h.cost) : null,
  }));

  const [quotes, dividendLists] = await Promise.all([
    ds.quoteBatch(list.map((h) => ({ code: h.code, market: h.market }))).catch(() => []),
    Promise.all(list.map((h) => ds.getDividendHistory(h.code).catch(() => []))),
  ]);
  const qMap = {};
  quotes.forEach((q) => { qMap[q.code] = q; });

  let totalValue = 0, costedValue = 0, costedCost = 0, hasAnyCost = false, yearTotal = 0, ttmTotal = 0;
  const items = list.map((h, idx) => {
    const quote = qMap[h.code] || {};
    const price = isNum(quote.price) ? quote.price : null;
    const { implemented } = div.parseDividends(dividendLists[idx]);
    const ttm = div.calcTTMDividend(implemented);
    // 今年已除息的每股分红合计（税前）
    let yearPerShare = 0;
    implemented.forEach((it) => {
      if (it.hasCash && it.exDate && String(it.exDate).slice(0, 4) === String(year)) yearPerShare += it.perShare;
    });
    const value = price !== null ? price * h.shares : null;
    if (value !== null) totalValue += value;
    // 盈亏仅对"有成本且有行情"的持仓计算（券商惯例，缺失成本的持仓不参与）
    if (h.cost !== null && value !== null) {
      costedCost += h.cost * h.shares;
      costedValue += value;
      hasAnyCost = true;
    }
    yearTotal += yearPerShare * h.shares;
    ttmTotal += ttm.perShare * h.shares;
    return {
      code: h.code,
      name: quote.name || (dividendLists[idx][0] && dividendLists[idx][0].name) || h.code,
      market: h.market,
      shares: h.shares,
      cost: h.cost,
      price,
      changePercent: isNum(quote.changePercent) ? quote.changePercent : null,
      ttmPerShare: ttm.perShare,
      ttmYield: price !== null && ttm.perShare > 0 ? +((ttm.perShare / price) * 100).toFixed(2) : null,
      yearDividend: +(yearPerShare * h.shares).toFixed(2),   // 今年已收息（税前）
      ttmDividend: +(ttm.perShare * h.shares).toFixed(2),    // 近12个月分红（税前）
    };
  });

  const summary = {
    count: items.length,
    totalValue: +totalValue.toFixed(2),
    totalCost: hasAnyCost ? +costedCost.toFixed(2) : null,
    pnl: hasAnyCost ? +(costedValue - costedCost).toFixed(2) : null,
    pnlPercent: hasAnyCost && costedCost > 0 ? +((costedValue / costedCost - 1) * 100).toFixed(2) : null,
    yearReceived: +yearTotal.toFixed(2),                     // 今年已收息（税前）
    expectedAnnual: +ttmTotal.toFixed(2),                    // 预期年度分红（按TTM口径）
    portfolioYield: totalValue > 0 ? +((ttmTotal / totalValue) * 100).toFixed(2) : null, // 组合TTM股息率
  };
  const result = { items, summary };
  cacheSet(ck, result);
  return ok(result);
}

exports.main = async (event = {}) => {
  try {
    switch (event.action) {
      case 'search': return await handleSearch(event);
      case 'quote': return await handleQuote(event);
      case 'quotes': return await handleQuotes(event);
      case 'overview': return await handleOverview(event);
      case 'calendar': return await handleCalendar(event);
      case 'portfolio': return await handlePortfolio(event);
      case 'homebrief': return await handleHomeBrief(event);
      case 'checkAlerts': return await handleCheckAlerts(event);
      case 'indexChart': return await handleIndexChart(event);
      default: return fail('未知 action: ' + event.action);
    }
  } catch (e) {
    return fail(e.message || '服务异常，请稍后重试');
  }
};
