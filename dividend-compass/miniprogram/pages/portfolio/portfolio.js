// pages/portfolio/portfolio.js —— 收息记账：持仓组合的分红收益统计
const util = require('../../utils/util');
const config = require('../../config');

Page({
  data: {
    loading: true,
    error: '',
    holdings: [],       // 持仓（含云函数计算的行情/股息字段）
    summary: null,      // 组合汇总
    // 添加持仓表单
    showForm: false,
    keyword: '',
    suggestions: [],
    searching: false,
    picked: null,       // {code, name, market}
    shares: '',
    cost: '',
    saving: false,
  },

  searchTimer: null,

  onLoad() {
    this.loadPortfolio();
  },

  onPullDownRefresh() {
    this.loadPortfolio().then(() => wx.stopPullDownRefresh());
  },

  async loadPortfolio() {
    if (!this.data.holdings.length) this.setData({ loading: true, error: '' });
    try {
      const list = await util.callFavorites('holdingList');
      if (!list.length) {
        this.setData({ loading: false, error: '', holdings: [], summary: null });
        return;
      }
      const d = await util.callService('portfolio', {
        holdings: list.map((h) => ({ code: h.code, market: h.market, shares: h.shares, cost: h.cost })),
      });
      this.setData({ loading: false, error: '', holdings: d.items || [], summary: d.summary || null });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  /* ---------- 添加/编辑持仓 ---------- */
  onToggleForm() {
    this.setData({
      showForm: !this.data.showForm,
      keyword: '', suggestions: [], searching: false,
      picked: null, shares: '', cost: '',
    });
  },

  onSearchInput(e) {
    const keyword = e.detail.value.trim();
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (!keyword) {
      this.setData({ suggestions: [], searching: false });
      return;
    }
    this.setData({ searching: true });
    this.searchTimer = setTimeout(() => this.doSearch(keyword), 300);
  },

  async doSearch(keyword) {
    try {
      const list = await util.callService('search', { keyword });
      if (keyword !== this.data.keyword) return;
      this.setData({ suggestions: list, searching: false });
    } catch (e) {
      if (keyword !== this.data.keyword) return;
      this.setData({ suggestions: [], searching: false });
    }
  },

  onPick(e) {
    const d = e.currentTarget.dataset;
    this.setData({ picked: { code: d.code, name: d.name, market: d.market }, keyword: d.name, suggestions: [] });
  },

  onSharesInput(e) { this.setData({ shares: e.detail.value }); },
  onCostInput(e) { this.setData({ cost: e.detail.value }); },

  async onSave() {
    if (this.data.saving) return;
    const p = this.data.picked;
    const shares = parseFloat(this.data.shares);
    const cost = parseFloat(this.data.cost);
    if (!p) { wx.showToast({ title: '请先搜索选择股票', icon: 'none' }); return; }
    if (!(shares > 0)) { wx.showToast({ title: '请输入持股数量', icon: 'none' }); return; }
    if (this.data.cost && !(cost > 0)) { wx.showToast({ title: '成本价格式不正确', icon: 'none' }); return; }

    this.setData({ saving: true });
    try {
      // 除息到账提醒的订阅授权（配置模板后生效；拒绝不影响保存）
      if (config.TEMPLATE_ID_EXDIV) {
        try { await wx.requestSubscribeMessage({ tmplIds: [config.TEMPLATE_ID_EXDIV] }); } catch (e) { /* 忽略 */ }
      }
      await util.callFavorites('holdingAdd', {
        code: p.code, name: p.name, market: p.market,
        shares, cost: cost > 0 ? cost : null,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ showForm: false, picked: null, keyword: '', shares: '', cost: '' });
      this.loadPortfolio();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
    this.setData({ saving: false });
  },

  async onRemove(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    const res = await wx.showModal({ title: '移除持仓', content: '确定移除 ' + name + ' 的持仓记录？' });
    if (!res.confirm) return;
    try {
      await util.callFavorites('holdingRemove', { code });
      wx.showToast({ title: '已移除', icon: 'success' });
      this.loadPortfolio();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  goStock(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || '') +
        '&market=' + (d.market || ''),
    });
  },

  onRetry() {
    this.loadPortfolio();
  },
});
