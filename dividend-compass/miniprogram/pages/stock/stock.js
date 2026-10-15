// pages/stock/stock.js —— 股票详情：行情/股息率/预测/分红史/财报/体检
const util = require('../../utils/util');

Page({
  data: {
    code: '',
    name: '',
    market: '',
    loading: true,
    error: '',
    d: null,            // overview 聚合数据
    predMode: 'basic',  // basic=双模型区间 | enhanced=盈利修正
    isFav: false,
    favBusy: false,
  },

  onLoad(options) {
    this.setData({
      code: options.code || '',
      name: decodeURIComponent(options.name || ''),
      market: options.market || '',
    });
    if (this.data.name) wx.setNavigationBarTitle({ title: this.data.name });
    this.loadOverview();
    this.checkFav();
  },

  onPullDownRefresh() {
    this.loadOverview(true).then(() => wx.stopPullDownRefresh());
  },

  /**
   * @param force true=绕过云函数缓存强制刷新（刷新按钮/下拉刷新用）
   */
  async loadOverview(force) {
    if (!this.data.d) this.setData({ loading: true, error: '' });
    try {
      const d = await util.callService('overview', {
        code: this.data.code,
        market: this.data.market,
        name: this.data.name,
        refresh: force === true,
      });
      if (d.name) wx.setNavigationBarTitle({ title: d.name });
      this.setData({ d: d, loading: false, error: '' });
      util.addRecent({ code: this.data.code, name: d.name || this.data.name, market: this.data.market });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  /* ---------- 预测模式切换 ---------- */
  onSwitchPredMode(e) {
    this.setData({ predMode: e.currentTarget.dataset.mode });
  },

  /* ---------- 自选 ---------- */
  async checkFav() {
    try {
      const list = await util.callFavorites('list');
      this.setData({ isFav: list.some((it) => it.code === this.data.code) });
    } catch (e) { /* 忽略 */ }
  },

  async onToggleFav() {
    if (this.data.favBusy) return;
    this.setData({ favBusy: true });
    try {
      if (this.data.isFav) {
        await util.callFavorites('remove', { code: this.data.code });
        this.setData({ isFav: false });
        wx.showToast({ title: '已移除自选', icon: 'none' });
      } else {
        await util.callFavorites('add', {
          code: this.data.code,
          name: (this.data.d && this.data.d.name) || this.data.name,
          market: this.data.market,
        });
        this.setData({ isFav: true });
        wx.showToast({ title: '已加入自选', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
    this.setData({ favBusy: false });
  },

  onRetry() {
    // 已有数据时静默强制刷新（绕过云函数缓存，保留页面内容），首次加载才显示全屏 loading
    this.loadOverview(true);
  },

  onShareAppMessage() {
    const d = this.data.d;
    return {
      title: (d ? d.name : this.data.name) + ' 股息率分析 · 拾息记',
      path: '/pages/stock/stock?code=' + this.data.code + '&name=' +
        encodeURIComponent((d && d.name) || this.data.name) + '&market=' + this.data.market,
    };
  },
});
