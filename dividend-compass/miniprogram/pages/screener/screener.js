// pages/screener/screener.js —— 全市场红利筛选：TTM股息率排行 + 股债利差看板
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    error: '',
    // 股债利差
    spread: null,
    // 筛选状态
    minYield: 4,
    board: '',
    boardInput: '',
    page: 1,
    rows: [],
    totalMatched: 0,
    hasMore: false,
    updatedAt: '',
    loadingMore: false,
  },

  onLoad() {
    this.loadSpread();
    this.loadPage(true);
  },

  onPullDownRefresh() {
    Promise.all([this.loadSpread(), this.loadPage(true)]).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadMore();
  },

  async loadSpread() {
    try {
      const d = await util.callService('spread');
      // 解读分档
      let comment = '';
      if (d.spread >= 2) comment = '股票资产显著占优，红利策略配置窗口';
      else if (d.spread >= 1) comment = '股票资产相对占优，可关注高股息机会';
      else if (d.spread >= 0) comment = '股债均衡，注重个股分红质量';
      else comment = '债券收益占优，控制仓位、精选个股';
      this.setData({ spread: Object.assign({}, d, { comment }) });
    } catch (e) { /* 利差失败不影响筛选 */ }
  },

  async loadPage(reset) {
    if (reset) this.setData({ loading: true, error: '' });
    try {
      const d = await util.callService('screener', {
        minYield: this.data.minYield,
        board: this.data.board,
        page: 1,
        pageSize: 30,
      });
      this.setData({
        loading: false,
        error: '',
        rows: d.rows,
        totalMatched: d.totalMatched,
        page: 1,
        hasMore: d.rows.length < d.totalMatched,
        updatedAt: d.updatedAt ? d.updatedAt.slice(0, 10) : '',
      });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  async loadMore() {
    this.setData({ loadingMore: true });
    try {
      const next = this.data.page + 1;
      const d = await util.callService('screener', {
        minYield: this.data.minYield, board: this.data.board, page: next, pageSize: 30,
      });
      this.setData({
        rows: this.data.rows.concat(d.rows),
        page: next,
        hasMore: this.data.rows.length + d.rows.length < d.totalMatched,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loadingMore: false });
      wx.showToast({ title: '加载更多失败', icon: 'none' });
    }
  },

  onFilterTap(e) {
    const v = Number(e.currentTarget.dataset.v);
    if (v === this.data.minYield) return;
    this.setData({ minYield: v });
    this.loadPage(true);
  },

  onBoardInput(e) { this.setData({ boardInput: e.detail.value }); },
  onBoardSearch() {
    this.setData({ board: this.data.boardInput.trim() });
    this.loadPage(true);
  },
  onBoardClear() {
    this.setData({ board: '', boardInput: '' });
    this.loadPage(true);
  },

  goStock(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || ''),
    });
  },

  onRetry() {
    this.loadSpread();
    this.loadPage(true);
  },
});
