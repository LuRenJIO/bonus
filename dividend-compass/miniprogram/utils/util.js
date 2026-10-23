/**
 * 工具：云函数调用封装 + 数据格式化
 */

/** 贵金属现货虚拟自选代码（market='GOLD'，行情由 goldBrief 填充） */
const GOLD_FAV = [
  { code: '999901', market: 'GOLD', name: '上海金 Au9999', key: 'shanghai', unit: '元/克' },
  { code: '999902', market: 'GOLD', name: 'Au(T+D)', key: 'autd', unit: '元/克' },
  { code: '999903', market: 'GOLD', name: '伦敦金', key: 'xau', unit: '美元/盎司' },
];

/**
 * 用 goldBrief 数据填充自选列表中的贵金属现货条目（GOLD 市场）
 * @returns {list, goldItems} 补全行情后的完整自选列表 + 其中 GOLD 条目
 */
function enrichGoldFavorites(list, gold) {
  const arr = (list || []).map((it) => {
    const def = GOLD_FAV.find((g) => g.code === it.code && it.market === 'GOLD');
    if (!def || !gold || !gold[def.key]) return it;
    const o = gold[def.key];
    return Object.assign({}, it, {
      name: def.name,
      price: o.price,
      changePercent: o.chgPct === undefined ? null : o.chgPct,
      isGold: true,
      unit: def.unit,
    });
  });
  return { list: arr, goldItems: arr.filter((x) => x.isGold) };
}

/** 调用 stock-service 云函数 */
function callService(action, data) {
  return wx.cloud
    .callFunction({
      name: 'stock-service',
      data: Object.assign({ action: action }, data || {}),
    })
    .then((res) => {
      const r = res.result;
      if (r && r.success) return r.data;
      throw new Error((r && r.error) || '服务异常');
    });
}

/** 调用 favorites 云函数 */
function callFavorites(action, data) {
  return wx.cloud
    .callFunction({
      name: 'favorites',
      data: Object.assign({ action: action }, data || {}),
    })
    .then((res) => {
      const r = res.result;
      if (r && r.success) return r.data;
      throw new Error((r && r.error) || '收藏服务异常');
    });
}

/** 亿元格式化：12345678901 → 123.46亿；保留 null */
function fmtYi(v, digits) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  return (v / 1e8).toFixed(digits === undefined ? 2 : digits) + '亿';
}

/** 通用数字格式化 */
function fmtNum(v, digits) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  return Number(v).toFixed(digits === undefined ? 2 : digits);
}

/** 涨跌样式类：up / down / flat */
function chgClass(v) {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/** 带符号显示：+1.23 / -1.23 */
function fmtSigned(v, digits) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  const d = digits === undefined ? 2 : digits;
  return (v > 0 ? '+' : '') + Number(v).toFixed(d);
}

/** 最近浏览记录（本地，最多10条） */
function getRecent() {
  return wx.getStorageSync('recent_stocks') || [];
}
function addRecent(stock) {
  let list = getRecent().filter((it) => it.code !== stock.code);
  list.unshift({ code: stock.code, name: stock.name, market: stock.market || '' });
  list = list.slice(0, 10);
  wx.setStorageSync('recent_stocks', list);
  return list;
}

/**
 * 分时时间 → 全天分钟槽位（0~240），横轴固定代表 09:30~15:00 含午休
 * '10:30' → 60；'11:30' → 120；'13:01' → 121；'15:00' → 240
 */
function minuteSlot(t) {
  const p = String(t || '').split(':');
  const m = (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  if (m <= 690) return m - 570;    // 09:30~11:30
  return m - 660;                  // 13:00~15:00（扣除90分钟午休）
}

/** 二分查找 slots 中与 target 最接近的索引（slots 升序） */
function nearestIndexBySlot(slots, target) {
  if (!slots || !slots.length) return 0;
  let lo = 0, hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid] < target) lo = mid + 1; else hi = mid;
  }
  // lo 为首个 >= target 的索引，比较前后取更近者
  if (lo > 0 && Math.abs(slots[lo - 1] - target) <= Math.abs(slots[lo] - target)) return lo - 1;
  return lo;
}

/**
 * 股息率阶梯：预期分红 ÷ 各档股息率 → 对应买入参考价
 * @param dividend 预期每股分红（元，中性预测）
 * @param price 现价（元）
 * @returns {rows:[{yield:3, price:'428.50', diff:'+1.2'}], closestIndex} 或 null
 */
function buildLadder(dividend, price) {
  if (!dividend || !isFinite(dividend) || dividend <= 0) return null;
  if (!price || !isFinite(price) || price <= 0) return null;
  const rows = [];
  let closestIndex = 0;
  let minGap = Infinity;
  for (let y = 3; y <= 9.001; y += 0.5) {
    const p = dividend / (y / 100);
    const diff = (p / price - 1) * 100;   // 较现价：负=股价需跌到该位才有此股息率
    rows.push({
      yield: (Math.round(y * 10) / 10).toFixed(1),
      price: p.toFixed(2),
      diff: (diff > 0 ? '+' : '') + diff.toFixed(1),
    });
    const gap = Math.abs(p - price);
    if (gap < minGap) { minGap = gap; closestIndex = rows.length - 1; }
  }
  return { rows: rows, closestIndex: closestIndex, dividend: +dividend.toFixed(4) };
}

module.exports = {
  callService,
  callFavorites,
  GOLD_FAV,
  enrichGoldFavorites,
  fmtYi,
  fmtNum,
  chgClass,
  fmtSigned,
  getRecent,
  addRecent,
  buildLadder,
  minuteSlot,
  nearestIndexBySlot,
};
