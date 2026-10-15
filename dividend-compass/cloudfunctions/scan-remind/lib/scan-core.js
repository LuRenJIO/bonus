/**
 * 定时扫描纯逻辑（无 wx-server-sdk 依赖，可本地单测）
 *
 * 两个推送场景：
 *   1. 股息率机会提醒：自选股 TTM股息率 >= 用户设定阈值（股息率升高 = 股价下跌 = 红利策略买点）
 *   2. 分红除息到账提醒：持仓股今日除息 → 按持股数估算税前到账金额
 *
 * 微信订阅消息 thing 字段限 20 字符，所有内容行在此截断。
 */

/** 格式化百分比：4.04 → '4.04%' */
function fmtPct(v) {
  return (Math.round(v * 100) / 100) + '%';
}

/**
 * 匹配股息率机会
 * @param rules [{code, name, threshold}]
 * @param quotes {code: {price, name}}
 * @param ttmByCode {code: 每股TTM分红(元)}
 * @returns [{code, name, price, ttmYield, threshold}] 仅含触发的
 */
function matchAlerts(rules, quotes, ttmByCode) {
  const hits = [];
  (rules || []).forEach((r) => {
    const q = quotes[r.code];
    const perShare = ttmByCode[r.code];
    if (!q || !isFinite(q.price) || q.price <= 0) return;
    if (!isFinite(perShare) || perShare <= 0) return;
    const ttmYield = +((perShare / q.price) * 100).toFixed(2);
    if (ttmYield >= r.threshold) {
      hits.push({ code: r.code, name: q.name || r.name || r.code, price: q.price, ttmYield, threshold: r.threshold });
    }
  });
  return hits;
}

/** 截断到微信 thing 字段 20 字符上限 */
function clip20(s) {
  return String(s).length <= 20 ? String(s) : String(s).slice(0, 20);
}

/**
 * 组装机会提醒内容行："茅台4.04%、平安5.21%"（≤20字符）
 * @param hits matchAlerts 结果
 */
function buildRemindLines(hits) {
  if (!hits || !hits.length) return '';
  const parts = [];
  let joined = '';
  hits.forEach((h) => {
    const seg = h.name + fmtPct(h.ttmYield);
    const candidate = joined ? joined + '、' + seg : seg;
    if (candidate.length > 20) return;   // 放不下的舍弃（每日红点可见全量）
    joined = candidate;
    parts.push(seg);
  });
  return joined || clip20(parts[0] || '');
}

/**
 * 组装除息到账内容行："茅台5196元、长电2000元"（≤20字符）
 * @param items [{name, amount}] amount=shares×perShare（税前）
 */
function buildExDivLines(items) {
  if (!items || !items.length) return '';
  let joined = '';
  items.forEach((it) => {
    const seg = it.name + Math.round(it.amount) + '元';
    const candidate = joined ? joined + '、' + seg : seg;
    if (candidate.length > 20) return;
    joined = candidate;
  });
  return joined;
}

/**
 * 组装订阅消息 data（按字段代号映射）
 * @param lines 内容字符串
 * @param whenStr 时间字符串（如 "10月15日 08:30"）
 * @param fieldMap {content:'thing1', time:'time2'}
 */
function buildMessageData(lines, whenStr, fieldMap) {
  const fm = fieldMap || { content: 'thing1', time: 'time2' };
  const data = {};
  if (fm.content) data[fm.content] = { value: clip20(lines || '无') };
  if (fm.time) data[fm.time] = { value: clip20(whenStr) };
  return data;
}

/** 本地日期 YYYY-MM-DD（东八区安全：按传入 Date 的本地时区取分量） */
function localDateStr(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

/** 本地时间 "10月15日 08:30" */
function localWhenStr(d) {
  const dt = d || new Date();
  return (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' +
    String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
}

module.exports = { fmtPct, matchAlerts, clip20, buildRemindLines, buildExDivLines, buildMessageData, localDateStr, localWhenStr };
