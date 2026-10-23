// pages/portal/portal.js —— 模块门户：策略模块调度中心（每个模块卡带实时摘要）
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    stockSummary: null,   // 红利策略摘要：{exTodayCount, exCash, csiText}
    goldSummary: null,    // 黄金摘要：{price, chgPct}
    watchCount: 0,        // 自选数量（我的关注卡摘要）
    error: '',
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [brief, gold, favList] = await Promise.all([
        util.callService('homebrief').catch(() => null),
        util.callService('goldBrief').catch(() => null),
        util.callFavorites('list').catch(() => []),
      ]);
      const stockSummary = brief ? {
        exTodayCount: brief.exTodayCount || 0,
        exCash: brief.exTodayCash !== null && brief.exTodayCash !== undefined ? brief.exTodayCash + ' 亿' : '--',
        csiText: brief.csiDividend ? (brief.csiDividend.changePercent > 0 ? '+' : '') + brief.csiDividend.changePercent + '%' : '--',
      } : null;
      const goldSummary = gold && gold.shanghai ? {
        price: gold.shanghai.price,
        chgPct: gold.shanghai.chgPct === undefined || gold.shanghai.chgPct === null ? null : (gold.shanghai.chgPct >= 0 ? '+' : '') + gold.shanghai.chgPct + '%',
        chgCls: gold.shanghai.chgPct >= 0 ? 'up' : 'dn',
      } : null;
      this.setData({
        loading: false,
        stockSummary,
        goldSummary,
        watchCount: Array.isArray(favList) ? favList.length : 0,
      });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  goStrategy() {
    wx.navigateTo({ url: '/pages/index/index' });
  },

  goGold() {
    wx.navigateTo({ url: '/pages/gold/gold' });
  },

  goWatchlist() {
    wx.navigateTo({ url: '/pages/watchlist/watchlist' });
  },
});
