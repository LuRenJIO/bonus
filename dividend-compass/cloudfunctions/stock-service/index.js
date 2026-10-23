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
const signal = require('./lib/signal');
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
    if (cached) {
      // 行业排名可能在 overview 缓存期间才就绪（筛选器数据集后台预热），命中时重算一次覆盖
      if (!cached.industryRank && cached.quote && cached.dividend) {
        const ir = buildIndustryRank(code, cached.quote, { perShare: cached.dividend.ttm ? cached.dividend.ttm.perShare : 0 });
        if (ir) cached.industryRank = ir;
      }
      return ok(cached);
    }
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
    industryRank: buildIndustryRank(code, quote, ttm),
    meta: {
      perUnassignProfit: perUnassign,
      totalShares,
      calcTime: new Date().toISOString(),
    },
  };

  // 行业排名数据集未就绪 → 七路请求已完成，此时后台预热不再与其竞争限流
  // （云函数环境下此异步任务可能被冻结，前端兜底会再静默调用一次 screener 保证构建）
  if (!result.industryRank) {
    buildScreenerDataset().catch(() => {});
  }

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
      signal: 'plain',
    };
  });
  // 黄金坑信号：触发高股息的股票按净利润同比分类（gold/warn/plain），财务 12h 缓存
  const triggeredList = out.filter((o) => o.triggered);
  await Promise.all(triggeredList.map(async (o) => {
    try {
      const fin = await getFinanceCached(o.code, 0);
      o.signal = signal.classifySignal(fin);
    } catch (e) { o.signal = 'plain'; }
  }));
  cacheSet(ck, out);
  return ok(out);
}

/** 财务数据 12h 缓存（黄金坑信号/体检共用，减少重复抓取） */
async function getFinanceCached(code, type) {
  const ck2 = 'fin:' + code + ':' + type;
  const cached = cacheGet(ck2, 12 * 3600 * 1000);
  if (cached) return cached;
  const list = await ds.getFinanceMain(code, type);
  cacheSet(ck2, list);
  return list;
}

/* ---------------- 指数/个股走势（分时/历史） ---------------- */
async function handleIndexChart(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('指数代码格式错误');
  const market = event.market || (/^(6|9)/.test(code) ? 'SH' : 'SZ');

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

/** 日期 → 'YYYY-MM-DD'（本地时区） */
function toDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = dt.getMonth() + 1;
  const day = dt.getDate();
  return dt.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/** 行业股息率排名：读全市场数据集聚合同行业；未就绪时返回 null（预热由调用方在主请求完成后触发，避免竞争限流） */
function buildIndustryRank(code, quote, ttm) {
  try {
    const dataset = cacheGet('scr:full', 12 * 3600 * 1000);
    if (!dataset || !dataset.rows || !dataset.rows.length) return null;
    // 行业名与我的股息率：优先实时行情/实时TTM，缺失时从数据集自身反查兜底
    const self = dataset.rows.find((r) => r.code === code) || null;
    const board = (quote && quote.industryName) || (self && self.board) || null;
    let mine = ttm && ttm.perShare > 0 && quote && quote.price > 0
      ? +((ttm.perShare / quote.price) * 100).toFixed(2)
      : (self && self.ttmYield > 0 ? self.ttmYield : null);
    if (!board || mine === null) return null;
    const peers = dataset.rows.filter((r) => r.board === board && r.ttmYield > 0);
    if (peers.length < 3) return null;
    const rank = peers.filter((r) => r.ttmYield > mine).length + 1;
    const top = peers.slice(0, 3).map((r) => ({ code: r.code, name: r.name, ttmYield: r.ttmYield }));
    return { board, rank, total: peers.length, top, myYield: mine };
  } catch (e) { return null; }
}

/* ---------------- 红利筛选器（全市场 TTM 股息率，12小时缓存） ---------------- */
const TREASURY_10Y = {
  value: 1.75,             // 10年期国债收益率（%），手动维护：中国债券信息网 chinabond.com.cn 首页可查
  asOf: '2026-10-15',      // 配置日期
};

/** 构建全市场 TTM 股息率数据集（估值快照 × 分红事件聚合，报告期口径与详情页一致） */
async function buildScreenerDataset() {
  const cached = cacheGet('scr:full', 12 * 3600 * 1000);
  if (cached) return cached;

  const [valuation, events] = await Promise.all([
    ds.getValuationSnapshot().catch(() => null),
    ds.getMarketDividendEvents(800).catch(() => []),   // 800天窗口：覆盖"最近4个季度报告期"的最坏实施滞后
  ]);
  if (!valuation || !valuation.length) throw new Error('全市场估值快照获取失败');

  // 按 code 分组（供报告期口径 TTM 计算）
  const listByCode = {};
  const nameByCode = {};
  events.forEach((e) => {
    if (!/^\d{6}$/.test(e.code) || !(e.perShare > 0) || !e.exDate) return;
    (listByCode[e.code] || (listByCode[e.code] = [])).push({
      reportDate: e.reportDate,
      exDate: e.exDate,
      perShare: e.perShare,
      hasCash: true,
    });
    if (!nameByCode[e.code]) nameByCode[e.code] = e.name;
  });

  const rows = [];
  valuation.forEach((v) => {
    const list = listByCode[v.code];
    if (!list || !list.length) return;   // 窗口内无现金分红的不入池
    const ttm = div.calcTTMByReport(list);   // 报告期口径，与详情页一致
    if (!ttm || !(ttm.perShare > 0)) return;
    rows.push({
      code: v.code,
      name: v.name || nameByCode[v.code] || v.code,
      price: v.price,
      ttmPerShare: ttm.perShare,
      ttmYield: +((ttm.perShare / v.price) * 100).toFixed(2),
      peTTM: v.peTTM,
      pb: v.pb,
      board: v.board,
      marketCap: v.marketCap,
    });
  });
  rows.sort((a, b) => b.ttmYield - a.ttmYield);

  // 市场画像：股息率中位数、>4% 家数、分红公司数
  const yields = rows.map((r) => r.ttmYield).sort((a, b) => a - b);
  const median = yields.length ? yields[Math.floor(yields.length / 2)] : null;
  const dataset = {
    updatedAt: new Date().toISOString(),
    count: rows.length,
    medianYield: median,
    gte4Count: yields.filter((y) => y >= 4).length,
    rows,
  };
  cacheSet('scr:full', dataset);
  return dataset;
}

async function handleScreener(event) {
  const dataset = await buildScreenerDataset();
  const minYield = isNum(Number(event.minYield)) ? Math.max(0, Number(event.minYield)) : 0;
  const board = String(event.board || '').trim();
  const page = Math.max(1, parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(10, parseInt(event.pageSize, 10) || 30));

  let rows = dataset.rows;
  if (minYield > 0) rows = rows.filter((r) => r.ttmYield >= minYield);
  if (board) rows = rows.filter((r) => r.board && r.board.indexOf(board) >= 0);

  const start = (page - 1) * pageSize;
  return ok({
    updatedAt: dataset.updatedAt,
    totalMatched: rows.length,
    page,
    pageSize,
    rows: rows.slice(start, start + pageSize),
  });
}

/* ---------------- 股债利差（全A中位数股息率 vs 10Y国债） ---------------- */
async function handleSpread() {
  const dataset = await buildScreenerDataset();
  const spread = dataset.medianYield !== null ? +(dataset.medianYield - TREASURY_10Y.value).toFixed(2) : null;
  return ok({
    medianYield: dataset.medianYield,
    count: dataset.count,
    gte4Count: dataset.gte4Count,
    treasury10y: TREASURY_10Y.value,
    treasuryAsOf: TREASURY_10Y.asOf,
    spread,
    updatedAt: dataset.updatedAt,
  });
}

/* ---------------- 年度收息报告（基于持仓） ---------------- */
async function handleAnnualReport(event) {
  const holdings = (Array.isArray(event.holdings) ? event.holdings : [])
    .filter((h) => h && /^\d{6}$/.test(String(h.code)) && isNum(Number(h.shares)) && Number(h.shares) > 0)
    .slice(0, 20);
  if (!holdings.length) return ok(null);

  const year = String(event.year || new Date().getFullYear());
  const list = holdings.map((h) => ({
    code: String(h.code),
    name: h.name || '',
    shares: Number(h.shares),
  }));

  const divLists = await Promise.all(list.map((h) => ds.getDividendHistory(h.code).catch(() => [])));
  const byMonth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const byStock = {};
  let total = 0;
  let topStock = null;

  list.forEach((h, idx) => {
    const { implemented } = div.parseDividends(divLists[idx]);
    let stockSum = 0;
    implemented.forEach((it) => {
      if (!it.hasCash || !it.exDate || String(it.exDate).slice(0, 4) !== year) return;
      const amount = it.perShare * h.shares;
      const month = parseInt(String(it.exDate).slice(5, 7), 10) - 1;
      if (month >= 0 && month <= 11) byMonth[month] += amount;
      stockSum += amount;
    });
    if (stockSum > 0) {
      byStock[h.code] = { code: h.code, name: h.name || (dividendName(divLists[idx]) || h.code), amount: +stockSum.toFixed(2) };
      total += stockSum;
    }
  });

  const stocks = Object.values(byStock).sort((a, b) => b.amount - a.amount);
  if (stocks.length) topStock = stocks[0];
  const monthsActive = byMonth.filter((m) => m > 0.005).length;

  return ok({
    year,
    total: +total.toFixed(2),
    byMonth: byMonth.map((m) => +m.toFixed(2)),
    monthsActive,
    stocks,
    topStock,
    holdingCount: list.length,
  });
}

function dividendName(rawList) {
  return rawList && rawList.length ? rawList[0].name : '';
}

/* ---------------- 分红再投资模拟（真实历史价格+分红，不含税费） ---------------- */
async function handleReinvest(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('股票代码格式错误');
  const market = event.market || (/^(6|9)/.test(code) ? 'SH' : 'SZ');
  let years = parseInt(event.years, 10);
  if (!isNum(years)) years = 5;
  years = Math.max(2, Math.min(years, 5));
  let capital = Number(event.capital);
  if (!isNum(capital) || capital <= 0) capital = 100000;

  // 买入回放：可选起点日（YYYY-MM-DD），给定后从该日起模拟
  let startReq = String(event.startDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startReq) || isNaN(new Date(startReq + 'T00:00:00').getTime())) startReq = '';

  const ck = 'ri:' + code + ':' + years + ':' + (startReq || 'auto');
  const cached = cacheGet(ck, 12 * 3600 * 1000);
  if (cached) return ok(cached);

  // 拉取量：指定起点时按跨度估算，否则按年限
  let n = years * 250 + 20;
  if (startReq) {
    const days = Math.max(30, Math.round((Date.now() - new Date(startReq + 'T00:00:00').getTime()) / 86400000));
    n = Math.min(1300, Math.ceil(days * 5 / 7) + 20);
  }

  const [daily, dividendRaw] = await Promise.all([
    ds.getDailyCloses(code, market, n).catch(() => null),
    ds.getDividendHistory(code).catch(() => []),
  ]);
  if (!daily || daily.length < 120) return fail('历史价格数据不足');

  // 窗口：起点 = 指定日（早于数据则取首日；过近则至少保留60个交易日），截取约 years 年
  let winStartIdx = 0;
  if (startReq) {
    const idx = daily.findIndex((d) => d.date >= startReq);
    winStartIdx = idx < 0 ? 0 : idx;
    if (winStartIdx > daily.length - 60) winStartIdx = Math.max(0, daily.length - 60);
  }
  const endIdx = Math.min(daily.length - 1, winStartIdx + years * 250);
  const window = daily.slice(winStartIdx, endIdx + 1);
  const startDate = window[0].date;
  const endDate = window[window.length - 1].date;

  // 窗口内已实施的每股分红（除息日 → 再投资于当日收盘价）
  const { implemented } = div.parseDividends(dividendRaw);
  const divEvents = implemented
    .filter((it) => it.hasCash && it.exDate && it.exDate >= startDate && it.exDate <= endDate)
    .map((it) => ({ exDate: it.exDate, perShare: it.perShare }))
    .sort((a, b) => (a.exDate > b.exDate ? 1 : -1));

  const price0 = window[0].close;
  let sharesR = capital / price0;      // 再投策略持股数
  const sharesP = capital / price0;    // 不再投策略持股数（固定）
  let cashP = 0;                       // 不再投累计现金分红
  let divCount = 0;

  // 每月采样序列（图表用）
  const series = [];
  let nextSample = 0;
  const sampleStep = Math.max(1, Math.floor(window.length / 60));

  window.forEach((d, i) => {
    // 当日及之前未处理的除息分红：收息 → 再投（不再投则累计现金）
    while (divCount < divEvents.length && divEvents[divCount].exDate <= d.date) {
      const ev = divEvents[divCount];
      sharesR += (sharesR * ev.perShare) / d.close;
      cashP += sharesP * ev.perShare;
      divCount++;
    }
    if (i >= nextSample) {
      series.push({
        d: d.date.slice(0, 7),
        vr: +(sharesR * d.close).toFixed(0),          // 再投组合市值
        vp: +(sharesP * d.close + cashP).toFixed(0),  // 不再投市值+现金
      });
      nextSample = i + sampleStep;
    }
  });

  const priceN = window[window.length - 1].close;
  const valueR = sharesR * priceN;
  const valueP = sharesP * priceN + cashP;
  // 三层收益拆解（之和 = 再投策略总收益，自洽可验）：
  //   价差 = 期末股价×初始股数 − 本金；分红 = 不再投累计现金；再投增益 = 再投买入股份的期末价值 − 再投投入的现金
  const bPrice = priceN * sharesP - capital;
  const bDividend = cashP;
  const bReinvestGain = sharesR * priceN - sharesP * priceN - cashP;
  const result = {
    code, market,
    startDate, endDate, years,
    startDateReq: startReq || null,
    price0, priceN,
    capital: +capital.toFixed(0),
    sharesStart: +(capital / price0).toFixed(2),
    sharesReinvest: +sharesR.toFixed(2),
    valueReinvest: +valueR.toFixed(0),
    valuePlain: +valueP.toFixed(0),
    cashPlain: +cashP.toFixed(0),
    dividendCount: divEvents.length,
    gainR: +((valueR / capital - 1) * 100).toFixed(1),
    gainP: +((valueP / capital - 1) * 100).toFixed(1),
    breakdown: {
      price: +bPrice.toFixed(0),
      dividend: +bDividend.toFixed(0),
      reinvestGain: +bReinvestGain.toFixed(0),
      total: +(valueR - capital).toFixed(0),
    },
    series,
  };
  cacheSet(ck, result);
  return ok(result);
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

  // 5分钟缓存（同一组合重复刷新不重复抓取；键含成本价——改成本即时失效）
  const ck = 'pf:' + holdings.map((h) => h.code + ':' + h.shares + ':' + (h.cost || 0)).join(',');
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
  const now = new Date();
  const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const cashflow = { months: [], pendingTotal: 0, pendingCount: 0, pendingItems: [] };
  const pendingMap = {};   // ym → confirmed 金额
  const estMap = {};       // ym → estimated 金额

  const items = list.map((h, idx) => {
    const quote = qMap[h.code] || {};
    const price = isNum(quote.price) ? quote.price : null;
    const parsed = div.parseDividends(dividendLists[idx]);
    const implemented = parsed.implemented;
    const pending = parsed.pending;
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

    // 除息倒计时：未来 90 天内最近一次已定除息
    let nextEx = null;
    const upcoming = div.upcomingDividends(dividendLists[idx], 90, now);
    for (const u of upcoming) {
      if (u.exDate && u.exDate >= todayStr) {
        nextEx = {
          date: u.exDate,
          perShare: u.perShare,
          profile: u.profile,
          daysLeft: Math.round((new Date(u.exDate + 'T00:00:00').getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86400000),
        };
        break;
      }
    }

    // 待实施分红（已公告未除息的现金分红）
    const pendCash = pending.filter((p) => p.hasCash && p.perShare > 0);
    const pendingAmount = pendCash.reduce((s, p) => s + p.perShare * h.shares, 0);
    cashflow.pendingTotal += pendingAmount;
    cashflow.pendingCount += pendCash.length;
    pendCash.forEach((p) => {
      cashflow.pendingItems.push({
        code: h.code, name: quote.name || h.code,
        exDate: p.exDate || null, perShare: p.perShare,
        amount: +(p.perShare * h.shares).toFixed(2), profile: p.profile,
      });
      // 已定除息日 → 现金流月历"确定层"（未来12个月）
      if (p.exDate && p.exDate >= todayStr) {
        const ym = p.exDate.slice(0, 7);
        pendingMap[ym] = (pendingMap[ym] || 0) + p.perShare * h.shares;
      }
    });

    // 历史除息月份分布（近3年）→ 估算层权重：年度预期(TTM×份额)按月分摊
    const monthCount = {};
    let histTotal = 0;
    const histStart = toDateStr(now.getTime() - 3 * 365 * 24 * 3600 * 1000);
    implemented.forEach((it) => {
      if (it.hasCash && it.exDate && it.exDate >= histStart && it.exDate <= todayStr) {
        const mo = it.exDate.slice(5, 7);
        monthCount[mo] = (monthCount[mo] || 0) + 1;
        histTotal += 1;
      }
    });
    if (histTotal > 0 && ttm.perShare > 0) {
      const annualEst = ttm.perShare * h.shares;
      Object.keys(monthCount).forEach((mo) => {
        const w = monthCount[mo] / histTotal;
        // 从下月起 12 个月：落在该自然月（任意年）的估算
        for (let k = 1; k <= 12; k++) {
          const dt = new Date(now.getFullYear(), now.getMonth() + k, 1);
          const mo2 = String(dt.getMonth() + 1).padStart(2, '0');
          if (mo2 === mo) {
            const ym2 = dt.getFullYear() + '-' + mo2;
            estMap[ym2] = (estMap[ym2] || 0) + annualEst * w;
          }
        }
      });
    }

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
      nextEx,                                                 // 除息倒计时
      pendingAmount: +pendingAmount.toFixed(2),               // 该持仓待实施金额
    };
  });

  // 现金流月历：下月起 12 个月
  for (let k = 1; k <= 12; k++) {
    const dt = new Date(now.getFullYear(), now.getMonth() + k, 1);
    const ym = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
    cashflow.months.push({
      ym,
      label: (dt.getMonth() + 1) + '月',
      confirmed: +(pendingMap[ym] || 0).toFixed(2),
      estimated: +((estMap[ym] || 0)).toFixed(2),
    });
  }
  cashflow.pendingTotal = +cashflow.pendingTotal.toFixed(2);
  cashflow.pendingItems = cashflow.pendingItems
    .sort((a, b) => ((a.exDate || '9999') > (b.exDate || '9999') ? 1 : -1)).slice(0, 6);

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
  const result = { items, summary, cashflow };
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
      case 'screener': return await handleScreener(event);
      case 'spread': return await handleSpread(event);
      case 'annualReport': return await handleAnnualReport(event);
      case 'reinvest': return await handleReinvest(event);
      default: return fail('未知 action: ' + event.action);
    }
  } catch (e) {
    return fail(e.message || '服务异常，请稍后重试');
  }
};
