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

/* ---------------- 5. 历史月K线（不复权，用于股息率曲线） ---------------- */

/**
 * 获取近 N 个月的月末收盘价（不复权——股息率=当时真实分红/当时真实股价）
 * 主源腾讯 proxy.finance.qq.com，备源东财 push2his
 * @returns [{ym:'2021-01', close: 1998.0}, ...] 升序；失败返回 null
 */
async function getMonthlyCloses(code, market, months) {
  const n = months || 66;
  const list = await getMonthlyTencent(code, market, n).catch(() => null);
  if (list && list.length) return list;
  return getMonthlyEast(code, market, n).catch(() => null);
}

async function getMonthlyTencent(code, market, n) {
  const sym = (market === 'SH' ? 'sh' : 'sz') + code;
  const url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=' +
    sym + ',month,,,' + n + ',';
  const j = await getJSON(url, { Referer: 'https://gu.qq.com/' });
  const node = j && j.data && j.data[sym];
  const rows = (node && (node.month || node.qfqmonth)) || [];
  const out = rows.map((r) => ({ ym: String(r[0]).slice(0, 7), close: parseFloat(r[2]) }))
    .filter((it) => it.ym && isFinite(it.close) && it.close > 0);
  return out.length >= 2 ? out : null;
}

async function getMonthlyEast(code, market, n) {
  const secid = (market === 'SH' ? '1.' : '0.') + code;
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=fa5fd1943c7b386f172d6893dbfba10b' +
    '&secid=' + secid + '&klt=103&fqt=0&lmt=' + n + '&end=20500101&fields1=f1,f2,f3&fields2=f51,f53';
  const j = await getJSON(url);
  const kl = (j && j.data && j.data.klines) || [];
  const out = kl.map((s) => {
    const parts = String(s).split(',');
    return { ym: (parts[0] || '').slice(0, 7), close: parseFloat(parts[1]) };
  }).filter((it) => it.ym && isFinite(it.close) && it.close > 0);
  return out.length >= 2 ? out : null;
}

/** 沪深300指数月末收盘价（Beta 计算基准，腾讯源） */
async function getIndexMonthlyCloses(n) {
  const sym = 'sh000300';
  const url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=' +
    sym + ',month,,,' + (n || 66) + ',';
  const j = await getJSON(url, { Referer: 'https://gu.qq.com/' });
  const node = j && j.data && j.data[sym];
  const rows = (node && node.month) || [];
  const out = rows.map((r) => ({ ym: String(r[0]).slice(0, 7), close: parseFloat(r[2]) }))
    .filter((it) => it.ym && isFinite(it.close) && it.close > 0);
  return out.length >= 2 ? out : null;
}

/** 指数日K收盘序列（近 n 个交易日）：腾讯双域名 → 新浪兜底（单源 6s 超时，防总耗时超函数上限） */
async function getDailyCloses(code, market, n) {
  const sym = String(market || 'SH').toLowerCase() + code;
  const want = n || 260;

  // 1) 腾讯 fqkline（web.ifzq / proxy.finance 同构，双域名防限流）
  for (const host of ['proxy.finance.qq.com', 'web.ifzq.gtimg.cn']) {
    try {
      const url = 'https://' + host + '/ifzqgtimg/appstock/app/fqkline/get?param=' +
        sym + ',day,,,' + want + ',';
      const text = await httpGet(url, { headers: { Referer: 'https://gu.qq.com/' }, timeout: 6000 });
      const j = JSON.parse(text);
      const node = j && j.data && j.data[sym];
      const rows = (node && (node.day || node.qfqday)) || [];
      const out = rows.map((r) => ({ date: String(r[0]), close: parseFloat(r[2]) }))
        .filter((it) => /^\d{4}-\d{2}-\d{2}$/.test(it.date) && isFinite(it.close) && it.close > 0);
      if (out.length >= 2) return out;
    } catch (e) { /* 尝试下一源 */ }
  }

  // 2) 新浪日K（jsonp 数组，取末 want 条）
  try {
    const url = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var/CN_MarketDataService.getKLineData' +
      '?symbol=' + sym + '&scale=240&ma=no&datalen=' + want;
    const text = await httpGet(url, { headers: { Referer: 'https://finance.sina.com.cn/' }, timeout: 6000 });
    const m = /\((\[[\s\S]*\])\)/.exec(text);
    const arr = m ? JSON.parse(m[1]) : [];
    const out = arr.map((r) => ({ date: String(r.day || ''), close: parseFloat(r.close) }))
      .filter((it) => /^\d{4}-\d{2}-\d{2}$/.test(it.date) && isFinite(it.close) && it.close > 0)
      .slice(-want);
    if (out.length >= 2) return out;
  } catch (e) { /* 全部失败 */ }
  return null;
}

/** 指数昨收价：腾讯实时（p[4]）→ 新浪（现价−涨跌额）兜底，GBK 响应仅解析 ASCII 数字字段 */
async function getIndexPreClose(sym) {
  try {
    const t = await httpGet('https://qt.gtimg.cn/q=' + sym, {});
    const qm = /="([^"]*)"/.exec(t);
    if (qm) {
      const v = parseFloat(qm[1].split('~')[4]);
      if (isFinite(v) && v > 0) return v;
    }
  } catch (e) { /* 尝试新浪 */ }
  try {
    const t = await httpGet('https://hq.sinajs.cn/list=' + sym, { Referer: 'https://finance.sina.com.cn/' });
    const sm = /="([^"]*)"/.exec(t);
    if (sm) {
      const f = sm[1].split(',');
      const price = parseFloat(f[1]);
      const chg = parseFloat(f[2]);
      const pre = price - chg;   // 指数格式：名称,当前点位,涨跌额,涨跌率,...
      if (isFinite(pre) && pre > 0) return pre;
    }
  } catch (e) { /* 全部失败 */ }
  return null;
}

/**
 * 指数分时数据。源链（单源 5~6s 超时，防总耗时撞函数上限）：
 *   1. 腾讯 minute/query 双域名（proxy.finance 优先——云端同腾讯内网可达性最好）
 *   2. 东财 push2his trends2（云端可达；限流时返回200空数据，需校验点数）
 * 新浪 5 分钟K对中证系指数返回陈旧数据，已弃用。
 * @returns {preClose, points:[{t:'09:30', price}]} 或 null
 */
async function getIndexMinute(code, market) {
  const sym = String(market || 'SH').toLowerCase() + code;
  const secid = (String(market || 'SH').toUpperCase() === 'SH' ? '1.' : '0.') + code;

  // 腾讯 minute/query（双域名）
  const tencentMinute = async () => {
    for (const host of ['proxy.finance.qq.com', 'web.ifzq.gtimg.cn']) {
      try {
        const mText = await httpGet('https://' + host + '/ifzqgtimg/appstock/app/minute/query?code=' + sym,
          { headers: { Referer: 'https://gu.qq.com/' }, timeout: 5000 });
        const j = JSON.parse(mText);
        const node = j && j.data && j.data[sym];
        const arr = (node && node.data && node.data.data) || [];
        const points = arr.map((s) => {
          const f = String(s).split(' ');
          const hhmm = f[0] || '';
          return {
            t: hhmm.replace(/^(\d{2})(\d{2})$/, '$1:$2'),
            price: parseFloat(f[1]),
          };
        }).filter((x) => /^\d{2}:\d{2}$/.test(x.t) && isFinite(x.price) && x.price > 0);
        if (points.length >= 10) return points;   // 有效才返回，否则切下一源
      } catch (e) { /* 尝试下一源 */ }
    }
    return null;
  };

  // 东财 trends2（分时：data.trends = ["2026-10-15 09:30,5630.30,..."]）
  const emTrends = async () => {
    try {
      const text = await httpGet('https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
        '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53&iscr=0&ndays=1',
        { headers: { Referer: 'https://quote.eastmoney.com/' }, timeout: 6000 });
      const j = JSON.parse(text);
      const trends = (j && j.data && j.data.trends) || [];
      const points = trends.map((s) => {
        const f = String(s).split(',');
        return { t: (f[0] || '').slice(11, 16), price: parseFloat(f[1]) };
      }).filter((x) => /^\d{2}:\d{2}$/.test(x.t) && isFinite(x.price) && x.price > 0);
      if (points.length >= 10) return points;
    } catch (e) { /* 兜底失败 */ }
    return null;
  };

  const [points, preClose] = await Promise.all([
    (async () => (await tencentMinute()) || (await emTrends()))(),
    getIndexPreClose(sym),
  ]);
  if (!points || !preClose) return null;
  return { preClose, points };
}

/* ---------------- 8. 全市场估值快照（东财 datacenter 估值分析报表） ---------------- */

/** 最新交易日的全市场估值快照：[{code, name, price, peTTM, pb, board, marketCap}] */
async function getValuationSnapshot() {
  // 先取单股最新 TRADE_DATE（避免硬编码日期在非交易日取不到数据）
  const probe = await getJSON(
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET' +
    '&columns=TRADE_DATE&filter=' + encodeURIComponent('(SECURITY_CODE="600519")') +
    '&pageSize=1&sortColumns=TRADE_DATE&sortTypes=-1',
    { Referer: 'https://data.eastmoney.com/' }
  );
  const probeRows = (probe && probe.result && probe.result.data) || [];
  const tradeDate = probeRows.length ? String(probeRows[0].TRADE_DATE).slice(0, 10) : null;
  if (!tradeDate) return null;

  // 第一页拿总数，然后并行抓全部页
  const pageOf = (pn) => getJSON(
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET' +
    '&columns=SECURITY_CODE,SECURITY_NAME_ABBR,CLOSE_PRICE,PE_TTM,PB_MRQ,BOARD_NAME,TOTAL_MARKET_CAP' +
    '&filter=' + encodeURIComponent("(TRADE_DATE='" + tradeDate + "')") +
    '&pageSize=500&pageNumber=' + pn + '&sortColumns=SECURITY_CODE&sortTypes=1',
    { Referer: 'https://data.eastmoney.com/' }
  ).catch(() => null);

  const first = await pageOf(1);
  const pages = (first && first.result && first.result.pages) || 0;
  if (!first || !first.result || !first.result.data || !first.result.data.length) return null;
  const results = [first];
  const others = [];
  for (let pn = 2; pn <= pages && pn <= 14; pn++) others.push(pageOf(pn));
  const settled = await Promise.all(others);
  settled.forEach((r) => { if (r && r.result && r.result.data) results.push(r); });

  const seen = {};
  const out = [];
  results.forEach((r) => {
    (r.result.data || []).forEach((row) => {
      const code = row.SECURITY_CODE;
      const price = parseFloat(row.CLOSE_PRICE);
      if (seen[code] || !/^\d{6}$/.test(code) || !isFinite(price) || price <= 0) return;
      seen[code] = true;
      out.push({
        code,
        name: row.SECURITY_NAME_ABBR || code,
        price,
        peTTM: isFinite(parseFloat(row.PE_TTM)) ? +parseFloat(row.PE_TTM).toFixed(2) : null,
        pb: isFinite(parseFloat(row.PB_MRQ)) ? +parseFloat(row.PB_MRQ).toFixed(2) : null,
        board: row.BOARD_NAME || '',
        marketCap: parseFloat(row.TOTAL_MARKET_CAP) || null,
      });
    });
  });
  return out.length >= 100 ? out : null;
}

/* ---------------- 9. 全市场分红事件（近 N 天，分页并行） ---------------- */

/** 近 days 天内除息的全市场分红事件：[{code, name, perShare, exDate, reportDate}] */
async function getMarketDividendEvents(days) {
  const fmt = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  const start = fmt(new Date(Date.now() - days * 24 * 3600 * 1000));
  const end = fmt(new Date());
  const filter = "(EX_DIVIDEND_DATE>='" + start + "')(EX_DIVIDEND_DATE<='" + end + "')";
  const pageOf = (pn) => getJSON(
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET' +
    '&columns=SECURITY_CODE,SECURITY_NAME_ABBR,PRETAX_BONUS_RMB,EX_DIVIDEND_DATE,REPORT_DATE&filter=' + encodeURIComponent(filter) +
    '&pageSize=500&pageNumber=' + pn + '&sortColumns=EX_DIVIDEND_DATE&sortTypes=1',
    { Referer: 'https://data.eastmoney.com/' }
  ).catch(() => null);

  const first = await pageOf(1);
  const pages = (first && first.result && first.result.pages) || 0;
  if (!first || !first.result || !first.result.data) return [];
  const others = [];
  for (let pn = 2; pn <= pages && pn <= 20; pn++) others.push(pageOf(pn));
  const settled = await Promise.all(others);
  const out = [];
  [first].concat(settled).forEach((r) => {
    (r && r.result && r.result.data || []).forEach((row) => {
      const per10 = parseFloat(row.PRETAX_BONUS_RMB);
      if (!(per10 > 0)) return;
      out.push({
        code: row.SECURITY_CODE,
        name: row.SECURITY_NAME_ABBR || row.SECURITY_CODE,
        perShare: +(per10 / 10).toFixed(4),
        exDate: String(row.EX_DIVIDEND_DATE || '').slice(0, 10),
        reportDate: row.REPORT_DATE ? String(row.REPORT_DATE).slice(0, 10) : null,
      });
    });
  });
  return out;
}

/* ---------------- 10. 分红送配历史（东财 datacenter） ---------------- */

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

/** 全市场未来 N 天除权除息日程（东财 datacenter，按除息日升序，仅现金分红） */
async function getExDividendCalendar(days) {
  const start = new Date();
  const end = new Date(Date.now() + days * 24 * 3600 * 1000);
  // 本地时区日期（与 dividend.toDateStr 口径一致，避免 UTC 跨日错位）
  const fmt = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  const filter = "(EX_DIVIDEND_DATE>='" + fmt(start) + "')(EX_DIVIDEND_DATE<='" + fmt(end) + "')";
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET' +
    '&columns=ALL&filter=' + encodeURIComponent(filter) +
    '&pageSize=500&pageNumber=1&sortColumns=EX_DIVIDEND_DATE&sortTypes=1';
  const j = await getJSON(url, { Referer: 'https://data.eastmoney.com/' });
  const rows = (j && j.result && j.result.data) || [];
  return rows
    .filter((r) => r.PRETAX_BONUS_RMB > 0)
    .map((r) => ({
      code: r.SECURITY_CODE,
      name: r.SECURITY_NAME_ABBR,
      exDate: (r.EX_DIVIDEND_DATE || '').slice(0, 10),
      perShare: +(r.PRETAX_BONUS_RMB / 10).toFixed(4),  // 每10股 → 每股
      progress: r.ASSIGN_PROGRESS || '',
      totalShares: r.TOTAL_SHARES,                       // 总股本(股)，用于估算派现总额
    }))
    .filter((r) => r.exDate && r.code);
}

module.exports = {
  searchStock: withRetry(searchStock, 2),
  getQuote: withRetry(getQuote, 2),
  quoteBatch: withRetry(quoteBatch, 2),
  getFinanceMain: withRetry(getFinanceMain, 2),
  getAnalystConsensus: withRetry(getAnalystConsensus, 1),
  getMonthlyCloses: withRetry(getMonthlyCloses, 1),
  getIndexMonthlyCloses: withRetry(getIndexMonthlyCloses, 1),
  getDailyCloses: getDailyCloses,       // 内部已多源回退+限时，不再外层重试（防撞函数超时）
  getIndexMinute: getIndexMinute,       // 同上
  getExDividendCalendar: withRetry(getExDividendCalendar, 1),
  getValuationSnapshot: withRetry(getValuationSnapshot, 1),
  getMarketDividendEvents: withRetry(getMarketDividendEvents, 1),
  getDividendHistory: withRetry(getDividendHistory, 2),
  buildSecid,
};
