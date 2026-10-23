/**
 * 云函数：scan-remind —— 每日定时扫描（默认每天 08:30）
 *
 *   1. 股息率机会提醒：遍历所有用户的 alerts 规则，TTM股息率 >= 阈值 → 订阅消息推送
 *   2. 分红除息到账提醒：遍历所有用户的 holdings，今日除息 → 按持股数估算税前到账 → 推送
 *
 * 部署（3步，缺一不可）：
 *   1. 右键本目录 → 上传并部署：云端安装依赖；函数配置 → 超时时间改 20 秒
 *   2. 右键本目录 → 上传触发器（config.json 中的每日 08:30 定时器）
 *   3. 编辑 config-templates.js 填入订阅消息模板ID，并重新上传本函数
 *
 * 手动测试：云开发控制台 → 云函数 → scan-remind → 云端测试 → 事件 {"action":"scan"}
 * 未配置模板ID时推送自动跳过，不影响运行；小程序内红点横幅提醒始终可用。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const cfg = require('./config-templates');
const core = require('./lib/scan-core');
const https = require('https');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' }, headers || {}),
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const gzipMagic = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        try {
          if (enc === 'gzip' || gzipMagic) buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        } catch (e) { /* 保留原始 */ }
        resolve(buf.toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 腾讯行情（支持逗号分隔多标的，一次请求） */
async function getQuotes(syms) {
  const text = await httpGet('https://qt.gtimg.cn/q=' + syms.join(','));
  const out = {};
  const re = /v_(sh|sz)(\d{6})="([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = m[3].split('~');
    const price = parseFloat(p[3]);
    if (!isFinite(price) || price <= 0) continue;
    out[m[1] + m[2]] = { code: m[1] + m[2], price, changePercent: parseFloat(p[32]) };
  }
  return out;
}

/** 东财分红历史（仅取所需字段） */
async function getDividendHistory(code) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET' +
    '&columns=ALL&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")') +
    '&pageSize=100&pageNumber=1&sortColumns=PLAN_NOTICE_DATE&sortTypes=-1';
  const j = JSON.parse(await httpGet(url, { Referer: 'https://data.eastmoney.com/' }));
  return ((j && j.result && j.result.data) || []).map((r) => ({
    bonusPer10: r.PRETAX_BONUS_RMB,
    exDate: (r.EX_DIVIDEND_DATE || '').slice(0, 10),
    progress: r.ASSIGN_PROGRESS || '',
  }));
}

/** 近12个月每股分红（TTM） */
function ttmPerShare(rawList) {
  const cutoff = Date.now() - 365 * 24 * 3600 * 1000;
  let sum = 0;
  rawList.forEach((r) => {
    if (!r.bonusPer10 || !r.exDate) return;
    const t = new Date(r.exDate + 'T00:00:00').getTime();
    if (t >= cutoff) sum += r.bonusPer10 / 10;
  });
  return sum;
}

/** 东财 F10 财务主要指标（黄金坑信号用：最新报告期归母净利 + 上年同期） */
async function getFinanceMain(code) {
  const f10 = (/^(6|9)/.test(code) ? 'SH' : 'SZ') + code;
  const url = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=' + f10;
  const j = JSON.parse(await httpGet(url, { Referer: 'https://emweb.securities.eastmoney.com/' }));
  return ((j && j.data) || []).map((r) => ({
    reportDate: (r.REPORT_DATE || '').slice(0, 10),
    parentNetProfit: parseFloat(r.PARENTNETPROFIT),
  }));
}

async function safeList(col) {
  try {
    const res = await db.collection(col).limit(1000).get();
    return res.data || [];
  } catch (e) { return []; }
}

/** 发送订阅消息（失败仅记日志，不中断） */
async function send(openid, templateId, lines, whenStr, fieldMap) {
  if (!templateId) return { skipped: true };
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page: 'pages/index/index',
      data: core.buildMessageData(lines, whenStr, fieldMap),
    });
    return { sent: true };
  } catch (e) {
    console.log('订阅消息发送失败:', openid, e.errCode || e.message);
    return { error: e.errMsg || e.message };
  }
}

async function runScan() {
  const now = new Date();
  const today = core.localDateStr(now);
  const whenStr = core.localWhenStr(now);
  const summary = { users_alert: 0, users_exdiv: 0, alert_hits: 0, exdiv_hits: 0, sent_alert: 0, sent_exdiv: 0, errors: 0 };

  // ---------- 1. 股息率机会提醒 ----------
  const alerts = await safeList('alerts');
  if (alerts.length) {
    // 按 openid 分组
    const byUser = {};
    alerts.forEach((a) => {
      const uid = a._openid;
      if (!uid) return;
      (byUser[uid] = byUser[uid] || []).push(a);
    });

    // 本次运行共享缓存
    const quoteCache = {};   // sym → {price, name?}
    const ttmCache = {};     // code → 每股TTM分红
    const symOf = (code, market) => ((market || (/^(6|9)/.test(code) ? 'SH' : 'SZ')).toLowerCase()) + code;

    for (const uid of Object.keys(byUser)) {
      const rules = byUser[uid].slice(0, 20);
      summary.users_alert++;
      try {
        // 批量行情（缺的补抓）
        const syms = [];
        rules.forEach((r) => {
          const sym = symOf(r.code, r.market);
          if (!quoteCache[sym]) syms.push(sym);
        });
        if (syms.length) {
          const fetched = await getQuotes(syms);
          Object.keys(fetched).forEach((sym) => { quoteCache[sym] = fetched[sym]; });
        }
        // TTM 分红（缺的补抓）
        for (const r of rules) {
          if (ttmCache[r.code] === undefined) {
            ttmCache[r.code] = await getDividendHistory(r.code).then(ttmPerShare).catch(() => 0);
          }
        }
        const quotes = {};
        rules.forEach((r) => {
          const sym = symOf(r.code, r.market);
          if (quoteCache[sym]) quotes[r.code] = { price: quoteCache[sym].price, name: r.name };
        });
        const ttmMap = {};
        rules.forEach((r) => { ttmMap[r.code] = ttmCache[r.code]; });

        const hits = core.matchAlerts(rules, quotes, ttmMap);
        if (hits.length) {
          summary.alert_hits += hits.length;
          // 黄金坑信号：按净利同比分成色，名称加前缀（本次运行内缓存财务）
          const finCache = {};
          for (const h of hits) {
            try {
              if (finCache[h.code] === undefined) {
                finCache[h.code] = await getFinanceMain(h.code).catch(() => null);
              }
              h.signal = core.classifySignal(finCache[h.code]);
            } catch (e) { h.signal = 'plain'; }
            h.name = core.signalPrefix(h.signal) + h.name;
          }
          const r = await send(uid, cfg.TEMPLATE_ID_REMIND,
            core.buildRemindLines(hits) || '自选股息率机会', whenStr, cfg.FIELD_MAP.REMIND);
          if (r.sent) summary.sent_alert++;
          if (r.error) summary.errors++;
        }
      } catch (e) {
        summary.errors++;
        console.log('用户提醒扫描失败:', uid, e.message);
      }
    }
  }

  // ---------- 2. 分红除息到账提醒 ----------
  const holdings = await safeList('holdings');
  if (holdings.length) {
    const byUser = {};
    holdings.forEach((h) => {
      if (!h._openid) return;
      (byUser[h._openid] = byUser[h._openid] || []).push(h);
    });

    // 今日除息表（一次抓取全市场）
    const exTodayMap = {};
    try {
      const start = today;
      const end = core.localDateStr(new Date(now.getTime() + 24 * 3600 * 1000));
      const filter = "(EX_DIVIDEND_DATE>='" + start + "')(EX_DIVIDEND_DATE<='" + end + "')";
      const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET' +
        '&columns=ALL&filter=' + encodeURIComponent(filter) + '&pageSize=500&pageNumber=1&sortColumns=EX_DIVIDEND_DATE&sortTypes=1';
      const j = JSON.parse(await httpGet(url, { Referer: 'https://data.eastmoney.com/' }));
      ((j && j.result && j.result.data) || []).forEach((r) => {
        const exDate = (r.EX_DIVIDEND_DATE || '').slice(0, 10);
        if (exDate === today && r.PRETAX_BONUS_RMB > 0) {
          exTodayMap[r.SECURITY_CODE] = { perShare: r.PRETAX_BONUS_RMB / 10, name: r.SECURITY_NAME_ABBR };
        }
      });
    } catch (e) {
      console.log('除息表抓取失败:', e.message);
    }

    for (const uid of Object.keys(byUser)) {
      const list = byUser[uid].filter((h) => exTodayMap[h.code]).slice(0, 10);
      if (!list.length) continue;
      summary.users_exdiv++;
      const items = list.map((h) => ({
        name: h.name || exTodayMap[h.code].name || h.code,
        amount: h.shares * exTodayMap[h.code].perShare,
      }));
      summary.exdiv_hits += items.length;
      const r = await send(uid, cfg.TEMPLATE_ID_EXDIV,
        core.buildExDivLines(items) || '今日有持仓除息', whenStr, cfg.FIELD_MAP.EXDIV);
      if (r.sent) summary.sent_exdiv++;
      if (r.error) summary.errors++;
    }
  }

  console.log('scan完成:', JSON.stringify(summary));
  return summary;
}

exports.main = async (event = {}) => {
  // 定时触发器 / 手动 {"action":"scan"} / 云端测试空事件 均执行扫描
  if (event.action === 'scan' || event.Type === 'Timer' || event.TriggerName || !event.action) {
    try {
      return await runScan();
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: '未知 action: ' + event.action };
};
