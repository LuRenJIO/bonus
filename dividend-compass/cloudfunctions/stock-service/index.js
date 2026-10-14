/**
 * 云函数：stock-service —— 红利股息宝核心数据服务
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
  const cached = cacheGet(ck, 5 * 60 * 1000);
  if (cached) return ok(cached);

  // 并行抓取四路数据
  const [quote, financeAnnualAll, financeReportsAll, dividendRaw] = await Promise.all([
    ds.getQuote(code, market).catch(() => null),
    ds.getFinanceMain(code, 1).catch(() => []),   // 按年度
    ds.getFinanceMain(code, 0).catch(() => []),   // 按报告期
    ds.getDividendHistory(code).catch(() => []),
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

  // 年度视图合并（年度分红 + 派息率 + 当年净利）
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
  });

  const ttmYield = quote.price && ttm.perShare > 0 ? +((ttm.perShare / quote.price) * 100).toFixed(2) : null;

  // 最新每股未分配利润：优先最新报告期财报，其次最新分红记录
  let perUnassign = latestReport && isFinite(latestReport.perUnassignProfit) ? latestReport.perUnassignProfit : null;
  if (perUnassign === null && dividendRaw.length && isFinite(dividendRaw[0].perUnassignProfit)) {
    perUnassign = dividendRaw[0].perUnassignProfit;
  }
  const latestDebtRatio = latestReport && isFinite(latestReport.debtRatio) ? latestReport.debtRatio : null;

  // 预测（双模型 + 盈利修正）
  const totalShares = quote.totalShares || (implemented[0] && implemented[0].totalShares) || null;
  const prediction = pred.predict(
    annualAgg, payoutRatios, financeAnnual, financeReports, quote.price, totalShares
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
    prediction,
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

exports.main = async (event = {}) => {
  try {
    switch (event.action) {
      case 'search': return await handleSearch(event);
      case 'quote': return await handleQuote(event);
      case 'quotes': return await handleQuotes(event);
      case 'overview': return await handleOverview(event);
      default: return fail('未知 action: ' + event.action);
    }
  } catch (e) {
    return fail(e.message || '服务异常，请稍后重试');
  }
};
