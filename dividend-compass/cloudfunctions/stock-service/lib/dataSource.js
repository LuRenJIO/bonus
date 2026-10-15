/**
 * 数据源封装：东方财富 + 腾讯 + 新浪 免费公开接口
 * 零外部依赖，仅使用 Node 内置 https 模块（部署时无需安装依赖）
 *
 * 注意：腾讯/新浪行情返回 GBK 编码，其中 ASCII 字符（数字、~、,）与 GBK 兼容，
 * 因此只从中解析数字字段（价格/涨跌幅等），股票名称统一从东财 UTF-8 接口获取。
 */

const https = require('https');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function httpGet(url, { headers = {}, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Encoding': 'identity', // 优先要未压缩响应；个别 CDN 仍压缩时下方兜底解压
      }, headers),
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' ' + url.slice(0, 80)));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const gzipMagic = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        try {
          if (enc === 'gzip' || gzipMagic) buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) { /* 解压失败保留原始内容，由上层 JSON.parse 报错触发重试 */ }
        resolve(buf.toString('utf8'));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
  });
}

async function getJSON(url, headers) {
  const text = await httpGet(url, headers);
  return JSON.parse(text);
}

function withRetry(fn, retries = 2) {
  return async function () {
    const args = arguments;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn.apply(null, args);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  };
}

/* ---------------- 1. 股票搜索（腾讯 smartbox，支持中文/拼音/代码前缀） ---------------- */

async function searchStock(keyword) {
  // 返回示例：v_hint="sh~600519~\u8d35\u5dde\u8305\u53f0~gzmt~GP-A^sz~000001~...~GP-A"
  // 中文名以 \uXXXX 转义返回（纯 ASCII，天然规避 GBK 编码问题）
  const url = 'https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(keyword) + '&t=all';
  const text = await httpGet(url);
  const m = /v_hint="([^"]*)"/.exec(text);
  if (!m || !m[1] || m[1] === 'N') return [];
  const results = [];
  m[1].split('^').forEach((entry) => {
    const f = entry.split('~');
    if (f.length < 5) return;
    const mkt = f[0], code = f[1], nameEsc = f[2], pinyin = f[3], category = f[4];
    if (category.indexOf('GP-A') !== 0) return;   // 仅A股（GP-A / GP-A-KCB 科创板）
    if (mkt !== 'sh' && mkt !== 'sz') return;
    let name = code;
    try { name = JSON.parse('"' + nameEsc + '"'); } catch (e) { /* 保底用代码 */ }
    results.push({
      code,
      name,
      pinyin,
      market: mkt.toUpperCase(),
      secid: (mkt === 'sh' ? '1.' : '0.') + code,
      marketName: mkt === 'sh' ? '沪A' : '深A',
    });
  });
  return results;
}

/* ---------------- 2. 实时行情（push2 → 腾讯 → 新浪 三级回退） ---------------- */

function buildSecid(code) {
  // 沪市：6开头(主板) 68(科创) 9(B股)；北交所：4/8开头(smart忽略)；默认深市
  if (/^(6|9)/.test(code) || code.startsWith('68')) return '1.' + code;
  return '0.' + code;
}

async function quoteFromPush2(secid) {
  const fields = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f84,f85,f86,f116,f117,f127,f162,f163,f167,f168,f169,f170,f171,f292';
  const url = 'https://push2.eastmoney.com/api/qt/stock/get?ut=fa5fd1943c7b386f172d6893dbfba10b&invt=2&fltt=2&fields=' +
    fields + '&secid=' + encodeURIComponent(secid);
  const j = await getJSON(url);
  const d = j && j.data;
  if (!d || d.f43 === undefined || d.f43 === null || d.f43 === '-') return null;
  return {
    source: 'eastmoney',
    name: d.f58,
    code: d.f57,
    price: d.f43,          // 最新价
    prevClose: d.f60,      // 昨收
    open: d.f46,           // 今开
    high: d.f44,
    low: d.f45,
    volume: d.f47,         // 成交量(手)
    amount: d.f48,         // 成交额(元)
    change: d.f169,        // 涨跌额
    changePercent: d.f170, // 涨跌幅%
    turnoverRate: d.f168,  // 换手率%
    peTTM: d.f162,         // 市盈率TTM
    peLYR: d.f163,
    pb: d.f167,            // 市净率
    amplitude: d.f171,     // 振幅%
    totalShares: d.f84,    // 总股本(股)
    floatShares: d.f85,    // 流通股本(股)
    totalMarketCap: d.f116, // 总市值(元)
    floatMarketCap: d.f117,
    industryName: d.f127 || null, // 所属行业（东财分类，如"白酒Ⅱ"）
  };
}

async function quoteFromTencent(code, market) {
  // GBK：仅解析 ASCII 数字字段，字段序号固定
  const prefix = market === 'SH' ? 'sh' : 'sz';
  const text = await httpGet('https://qt.gtimg.cn/q=' + prefix + code);
  const m = /="([^"]+)"/.exec(text);
  if (!m) return null;
  const p = m[1].split('~');
  if (p.length < 47) return null;
  const price = parseFloat(p[3]);
  const prevClose = parseFloat(p[4]);
  if (!isFinite(price) || price <= 0) return null;
  return {
    source: 'tencent',
    code: p[2],
    price,
    prevClose,
    open: parseFloat(p[5]),
    high: parseFloat(p[33]),
    low: parseFloat(p[34]),
    volume: parseFloat(p[36]),      // 成交量(手)
    amount: parseFloat(p[37]) * 10000, // 成交额(元)
    change: parseFloat(p[31]),
    changePercent: parseFloat(p[32]),
    turnoverRate: parseFloat(p[38]),
    peTTM: parseFloat(p[39]),
    amplitude: parseFloat(p[43]),
    floatMarketCap: parseFloat(p[44]) * 1e8,  // 流通市值(亿→元)
    totalMarketCap: parseFloat(p[45]) * 1e8,  // 总市值(亿→元)
    pb: parseFloat(p[46]),
    totalShares: parseFloat(p[45]) * 1e8 / price, // 总市值/现价 反推总股本
  };
}

async function quoteFromSina(code, market) {
  const prefix = market === 'SH' ? 'sh' : 'sz';
  const text = await httpGet('https://hq.sinajs.cn/list=' + prefix + code, {
    Referer: 'https://finance.sina.com.cn/',
  });
  const m = /="([^"]+)"/.exec(text);
  if (!m) return null;
  const p = m[1].split(',');
  if (p.length < 32) return null;
  const price = parseFloat(p[3]);
  const prevClose = parseFloat(p[2]);
  if (!isFinite(price) || price <= 0) return null;
  return {
    source: 'sina',
    code: code,
    price,
    prevClose,
    open: parseFloat(p[1]),
    high: parseFloat(p[4]),
    low: parseFloat(p[5]),
    volume: parseFloat(p[8]) / 100,
    amount: parseFloat(p[9]),
    change: +(price - prevClose).toFixed(2),
    changePercent: +(((price - prevClose) / prevClose) * 100).toFixed(2),
    tradeDate: p[30],
    tradeTime: p[31],
  };
}

async function getQuote(code, market) {
  const secid = buildSecid(code);
  const tryList = [
    () => quoteFromPush2(secid),
    () => quoteFromTencent(code, market || (/^(6|9)/.test(code) ? 'SH' : 'SZ')),
    () => quoteFromSina(code, market || (/^(6|9)/.test(code) ? 'SH' : 'SZ')),
  ];
  for (const fn of tryList) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) { /* 尝试下一数据源 */ }
  }
  throw new Error('行情获取失败：三个数据源均不可用 ' + code);
}

/** 批量行情（腾讯，自选列表用）：list: [{code, market}]，返回 [{code, price, change, changePercent}] */
async function quoteBatch(list) {
  const items = (list || []).slice(0, 50).map((it) => {
    const mkt = it.market || (/^(6|9)/.test(it.code) ? 'SH' : 'SZ');
    return (mkt === 'SH' ? 'sh' : 'sz') + it.code;
  });
  if (!items.length) return [];
  const text = await httpGet('https://qt.gtimg.cn/q=' + items.join(','));
  const result = [];
  String(text).split('\n').forEach((line) => {
    const m = /v_(?:sh|sz)(\d{6})="([^"]*)"/.exec(line);
    if (!m) return;
    const p = m[2].split('~');
    if (p.length < 47) return;
    const price = parseFloat(p[3]);
    const prevClose = parseFloat(p[4]);
    if (!isFinite(price) || price <= 0) return;
    result.push({
      code: m[1],
      price,
      prevClose,
      change: parseFloat(p[31]),
      changePercent: parseFloat(p[32]),
    });
  });
  return result;
}

/* ---------------- 3. 财务主要指标（东财 F10，UTF-8 JSON） ---------------- */

function f10Code(code) {
  return (/^(6|9)/.test(code) ? 'SH' : 'SZ') + code;
}

/**
 * 获取财务主要指标
 * @param type 1=按年度（年报），0=按报告期（一季报/半年报/三季报/年报，降序）
 */
async function getFinanceMain(code, type) {
  const url = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=' +
    type + '&code=' + f10Code(code);
  const j = await getJSON(url, { Referer: 'https://emweb.securities.eastmoney.com/' });
  const rows = (j && j.data) || [];
  return rows.map((r) => ({
    reportDate: (r.REPORT_DATE || '').slice(0, 10),
    reportType: r.REPORT_TYPE || '',
    noticeDate: (r.NOTICE_DATE || '').slice(0, 10),
    // 每股指标
    eps: r.EPSJB,                    // 基本每股收益
    epsDeducted: r.EPSKCJB,          // 扣非每股收益
    bps: r.BPS,                      // 每股净资产
    perUnassignProfit: r.MGWFPLR,    // 每股未分配利润
    perOperateCashflow: r.MGJYXJJE,  // 每股经营现金流
    // 规模指标（元）
    revenue: r.TOTALOPERATEREVE,     // 营业总收入
    parentNetProfit: r.PARENTNETPROFIT, // 归母净利润
    netProfitDeducted: r.KCFJCXSYJLR,   // 扣非归母净利润
    // 增速（%）
    revenueYoy: r.TOTALOPERATEREVETZ,
    netProfitYoy: r.PARENTNETPROFITTZ,
    // 比率（%）
    roeWeighted: r.ROEJQ,            // 加权ROE
    grossMargin: r.XSMLL,            // 销售毛利率
    netMargin: r.XSJLL,              // 销售净利率
    debtRatio: r.ZCFZL,              // 资产负债率
  }));
}

/* ---------------- 4. 机构一致预期（东财研报列表，近1年） ---------------- */

/**
 * 聚合机构研报的一致预期 EPS 与评级分布
 * 研报的 predictThisYearEps / predictNextYearEps 以发布年份为基准：
 * 发布年份 == Y 时，"今年"=Y、"次年"=Y+1，据此对齐到自然年
 * @returns {count, epsByYear: {2026: 65.1, 2027: 68.2}, medianEps, ratings, industryName, latestDate}
 */
async function getAnalystConsensus(code) {
  const end = new Date();
  const begin = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = 'https://reportapi.eastmoney.com/report/list?pageSize=100&industry=*&rating=*&ratingChange=*' +
    '&beginTime=' + fmt(begin) + '&endTime=' + fmt(end) + '&pageNo=1&qType=0&code=' + code;
  const j = await getJSON(url, { Referer: 'https://data.eastmoney.com/report/' });
  const rows = (j && j.data) || [];
  if (!rows.length) return null;

  const epsByYear = {};   // 自然年 → EPS 预测数组
  const ratings = { buy: 0, increase: 0, neutral: 0, reduce: 0, sell: 0 };
  let industryName = null;
  let latestDate = '';

  rows.forEach((r) => {
    const pubYear = parseInt((r.publishDate || '').slice(0, 4), 10);
    if (!pubYear) return;
    // 按发布年份把"今年/次年"预测对齐到自然年
    if (r.predictThisYearEps) pushEps(epsByYear, pubYear, r.predictThisYearEps);
    if (r.predictNextYearEps) pushEps(epsByYear, pubYear + 1, r.predictNextYearEps);
    // 评级分布
    const rt = r.emRatingName || '';
    if (rt.indexOf('买入') >= 0) ratings.buy++;
    else if (rt.indexOf('增持') >= 0 || rt.indexOf('推荐') >= 0 || rt.indexOf('优于') >= 0) ratings.increase++;
    else if (rt.indexOf('中性') >= 0 || rt.indexOf('持有') >= 0) ratings.neutral++;
    else if (rt.indexOf('减持') >= 0) ratings.reduce++;
    else if (rt.indexOf('卖出') >= 0) ratings.sell++;
    if (!industryName && r.indvInduName) industryName = r.indvInduName;
    if (r.publishDate > latestDate) latestDate = (r.publishDate || '').slice(0, 10);
  });

  // 各年中位数
  const medianByYear = {};
  Object.keys(epsByYear).forEach((y) => {
    const arr = epsByYear[y].filter((v) => isFinite(v) && v > 0).sort((a, b) => a - b);
    if (arr.length) medianByYear[y] = +arr[Math.floor(arr.length / 2)].toFixed(4);
  });

  return {
    count: rows.length,
    medianByYear,         // 如 {"2026":65.1, "2027":68.2}
    ratings,              // 评级分布
    industryName,         // 所属行业（如"白酒Ⅱ"）
    latestDate,           // 最新研报日期
  };
}

function pushEps(map, year, val) {
  const v = parseFloat(val);
  if (!isFinite(v) || v <= 0) return;
  if (!map[year]) map[year] = [];
  map[year].push(v);
}

/* ---------------- 5. 分红送配历史（东财 datacenter） ---------------- */

async function getDividendHistory(code) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET' +
    '&columns=ALL&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")') +
    '&pageSize=100&pageNumber=1&sortColumns=PLAN_NOTICE_DATE&sortTypes=-1';
  const j = await getJSON(url, { Referer: 'https://data.eastmoney.com/' });
  const rows = (j && j.result && j.result.data) || [];
  return rows.map((r) => ({
    code: r.SECURITY_CODE,
    name: r.SECURITY_NAME_ABBR,
    // 每10股税前现金股利（元），每股 = /10
    bonusPer10: r.PRETAX_BONUS_RMB,
    // 每10股送股 / 转增（股）
    bonusShares: r.BONUS_RATIO,
    transferShares: r.IT_RATIO,
    planNoticeDate: (r.PLAN_NOTICE_DATE || '').slice(0, 10),  // 预案公告日
    recordDate: (r.EQUITY_RECORD_DATE || '').slice(0, 10),    // 股权登记日
    exDate: (r.EX_DIVIDEND_DATE || '').slice(0, 10),          // 除权除息日
    reportDate: (r.REPORT_DATE || '').slice(0, 10),           // 分红对应的报告期
    progress: r.ASSIGN_PROGRESS || '',                        // 实施分配/预案/股东大会通过 等
    profile: r.IMPL_PLAN_PROFILE || '',                       // 方案全文，如 "10派280.2423元(含税)"
    totalShares: r.TOTAL_SHARES,                              // 总股本(股)
    basicEps: r.BASIC_EPS,
    perUnassignProfit: r.PER_UNASSIGN_PROFIT,                 // 每股未分配利润
  }));
}

module.exports = {
  searchStock: withRetry(searchStock, 2),
  getQuote: withRetry(getQuote, 2),
  quoteBatch: withRetry(quoteBatch, 2),
  getFinanceMain: withRetry(getFinanceMain, 2),
  getAnalystConsensus: withRetry(getAnalystConsensus, 1),
  getDividendHistory: withRetry(getDividendHistory, 2),
  buildSecid,
};
