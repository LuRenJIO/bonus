// pages/watchlist/watchlist.js —— 我的关注：各模块自选集中呈现（股票/ETF 行情 + 贵金属现货）
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    error: '',
    manageMode: false,   // 管理模式：排序/删除
    stocks: null,      // 股票自选（含行情）
    etfs: null,        // ETF/基金自选（含行情）
    golds: null,       // 贵金属现货自选（用户收藏的品种）
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
      const [list, gold] = await Promise.all([
        util.callFavorites('list').catch(() => []),
        util.callService('goldBrief').catch(() => null),
      ]);
      const enrichedRes = util.enrichGoldFavorites(Array.isArray(list) ? list : [], gold);
      const arr = enrichedRes.list;
      const codes = arr.map((it) => ({ code: it.code, market: it.market }));
      let quotes = [];
      if (codes.length) {
        quotes = await util.callService('quotes', { list: codes }).catch(() => []);
      }
      const qMap = {};
      quotes.forEach((q) => { qMap[q.code] = q; });
      const enriched = arr.map((it) => Object.assign({}, it, {
        price: it.isGold ? it.price : (qMap[it.code] ? qMap[it.code].price : null),
        changePercent: it.isGold ? it.changePercent : (qMap[it.code] ? qMap[it.code].changePercent : null),
        isEtf: !it.isGold && /^(51|15|56|58|16)/.test(it.code),   // 场内基金代码段
      }));
      this.setData({
        loading: false,
        golds: enriched.filter((x) => x.isGold),
        stocks: enriched.filter((x) => !x.isGold && !x.isEtf),
        etfs: enriched.filter((x) => x.isEtf),
      });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  /* ---------- 管理模式：自定义排序 / 删除 ---------- */
  toggleManage() {
    this.setData({ manageMode: !this.data.manageMode });
  },

  /** 组内上移/下移（用户自定义排序），即时写回云端 */
  moveRow(e) {
    if (!this.data.manageMode) return;
    const { group, idx, dir } = e.currentTarget.dataset;
    const arr = this.data[group];
    const i = Number(idx);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= arr.length) return;
    const next = arr.slice();
    const tmp = next[i];
    next[i] = next[j];
    next[j] = tmp;
    this.setData({ [group]: next });
    this.saveOrder();
  },

  /** 保存自定义顺序：stocks 顺序 + etfs 顺序 = 完整序列 */
  async saveOrder() {
    try {
      const codes = this.data.stocks.concat(this.data.etfs).map((x) => x.code);
      await util.callFavorites('reorder', { codes });
    } catch (e) {
      wx.showToast({ title: '排序保存失败', icon: 'none' });
    }
  },

  goStock(e) {
    if (this.data.manageMode) return;   // 管理模式下不跳详情
    const d = e.currentTarget.dataset;
    if (d.gold) {   // 贵金属现货 → 跳拾金观察模块
      wx.navigateTo({ url: '/pages/gold/gold' });
      return;
    }
    wx.navigateTo({ url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || '') });
  },

  goRemove(e) {
    const code = e.currentTarget.dataset.code;
    wx.showModal({
      title: '移除关注',
      content: '将 "' + (e.currentTarget.dataset.name || code) + '" 从自选中移除？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await util.callFavorites('remove', { code });
          wx.showToast({ title: '已移除', icon: 'none' });
          this.load();
        } catch (err) {
          wx.showToast({ title: '移除失败', icon: 'none' });
        }
      },
    });
  },
});
