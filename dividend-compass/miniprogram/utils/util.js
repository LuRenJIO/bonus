/**
 * 工具：云函数调用封装 + 数据格式化
 */

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

module.exports = {
  callService,
  callFavorites,
  fmtYi,
  fmtNum,
  chgClass,
  fmtSigned,
  getRecent,
  addRecent,
};
