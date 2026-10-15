// pages/index/index.js —— 首页：红利速览 / 提醒横幅 / 搜索 / 自选股 / 最近浏览
const util = require('../../utils/util');

Page({
  data: {
    keyword: '',
    suggestions: [],
    searching: false,
    searched: false,
    favList: [],
    favLoading: true,
    favError: '',
    recent: [],
    briefItems: [],
    alertHits: [],
    alertHitsText: '',
    exSheetOpen: false,   // 今日除息弹层
    exTodayList: [],
    exTodayCash: null,
  },

  searchTimer: null,

  onShow() {
    this.setData({ recent: util.getRecent() });
    this.loadFavorites();
    this.loadBrief();
    this.loadAlertHits();
  },

  onPullDownRefresh() {
    this.loadFavorites().then(() => wx.stopPullDownRefresh());
  },

  /* ---------- 自选股 ---------- */
  async loadFavorites() {
    this.setData({ favLoading: true, favError: '' });
    let list = [];
    try {
      list = await util.callFavorites('list');
    } catch (e) {
      // 云函数未部署或云开发未初始化
      this.setData({ favList: [], favLoading: false, favError: e.message });
      return;
    }
    this.setData({ favList: list, favLoading: false });
    // 批量拉取行情
    if (list.length) {
      try {
        const quotes = await util.callService('quotes', {
          list: list.map((it) => ({ code: it.code, market: it.market })),
        });
        const qMap = {};
        quotes.forEach((q) => { qMap[q.code] = q; });
        this.setData({
          favList: list.map((it) => Object.assign({}, it, {
            price: qMap[it.code] ? qMap[it.code].price : null,
            changePercent: qMap[it.code] ? qMap[it.code].changePercent : null,
          })),
        });
      } catch (e) { /* 行情失败不影响列表展示 */ }
    }
  },

  async onRemoveFavorite(e) {
    const code = e.currentTarget.dataset.code;
    const res = await wx.showModal({ title: '移除自选', content: '确定移除该自选股？' });
    if (!res.confirm) return;
    try {
      await util.callFavorites('remove', { code });
      wx.showToast({ title: '已移除', icon: 'success' });
      this.loadFavorites();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  /* ---------- 搜索 ---------- */
  onSearchInput(e) {
    const keyword = e.detail.value.trim();
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (!keyword) {
      this.setData({ suggestions: [], searching: false, searched: false });
      return;
    }
    this.setData({ searching: true });
    this.searchTimer = setTimeout(() => this.doSearch(keyword), 300);
  },

  async doSearch(keyword) {
    try {
      const list = await util.callService('search', { keyword });
      // 关键词未变才应用结果
      if (keyword !== this.data.keyword) return;
      this.setData({ suggestions: list, searching: false, searched: true });
    } catch (e) {
      if (keyword !== this.data.keyword) return;
      this.setData({ suggestions: [], searching: false, searched: true });
      wx.showToast({ title: '搜索失败：' + e.message, icon: 'none' });
    }
  },

  onClearSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.setData({ keyword: '', suggestions: [], searching: false, searched: false });
  },

  /* ---------- 跳转 ---------- */
  goStock(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || '') +
        '&market=' + (d.market || ''),
    });
  },

  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' });
  },

  goPortfolio() {
    wx.navigateTo({ url: '/pages/portfolio/portfolio' });
  },

  /* ---------- 红利速览 ---------- */
  async loadBrief() {
    try {
      const d = await util.callService('homebrief');
      const pct = (v) => (v > 0 ? '+' : '') + v + '%';
      const items = [];
      // 第一行：市场参照（点击进指数走势页）
      if (d.csiDividend) items.push({ label: '中证红利', val: pct(d.csiDividend.changePercent), cls: util.chgClass(d.csiDividend.changePercent), tap: 'chart', code: '000922', name: '中证红利' });
      if (d.hs300) items.push({ label: '沪深300', val: pct(d.hs300.changePercent), cls: util.chgClass(d.hs300.changePercent), tap: 'chart', code: '000300', name: '沪深300' });
      if (d.shIndex) items.push({ label: '上证指数', val: pct(d.shIndex.changePercent), cls: util.chgClass(d.shIndex.changePercent), tap: 'chart', code: '000001', name: '上证指数' });
      // 第二行：今日/7日除息动态
      items.push({ label: '今日除息', val: d.exTodayCount + ' 只', cls: 'gold-text', tap: 'ex' });
      if (d.exTodayCash !== null) items.push({ label: '今日派现', val: d.exTodayCash + '亿', cls: 'gold-text' });
      items.push({ label: '7日除息', val: d.exWeekCount + ' 只', cls: '' });
      this.setData({
        briefItems: items,
        exTodayList: d.exTodayTop || [],
        exTodayCash: d.exTodayCash,
      });
    } catch (e) { /* 速览失败不影响主功能 */ }
  },

  /** 速览格点击分发：指数→走势页，今日除息→弹层 */
  onBriefTap(e) {
    const item = this.data.briefItems[e.currentTarget.dataset.idx];
    if (!item || !item.tap) return;
    if (item.tap === 'chart') {
      wx.navigateTo({
        url: '/pages/indexchart/indexchart?code=' + item.code + '&name=' + encodeURIComponent(item.name) + '&market=SH',
      });
    } else if (item.tap === 'ex') {
      this.onExTodayTap();
    }
  },

  /* ---------- 今日除息弹层（与分红日历差异化：只看今天，直达个股） ---------- */
  onExTodayTap() {
    if (!this.data.exTodayList.length) {
      wx.showToast({ title: '今日暂无除息安排', icon: 'none' });
      return;
    }
    this.setData({ exSheetOpen: true });
  },

  onExSheetClose() {
    this.setData({ exSheetOpen: false });
  },

  onExPickStock(e) {
    const d = e.currentTarget.dataset;
    this.setData({ exSheetOpen: false });
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || ''),
    });
  },

  /* ---------- 股息率提醒横幅（无推送时的可见兜底） ---------- */
  async loadAlertHits() {
    try {
      const rules = await util.callFavorites('alertList');
      if (!rules.length) { this.setData({ alertHits: [], alertHitsText: '' }); return; }
      const hits = (await util.callService('checkAlerts', {
        list: rules.map((r) => ({ code: r.code, name: r.name, market: r.market, threshold: r.threshold })),
      })).filter((r) => r.triggered);
      this.setData({
        alertHits: hits,
        alertHitsText: hits.slice(0, 2).map((h) => h.name + ' ' + h.ttmYield + '%').join('、') + (hits.length > 2 ? ' 等' : ''),
      });
    } catch (e) { /* 静默 */ }
  },

  goAlertStock() {
    const h = this.data.alertHits[0];
    if (!h) return;
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + h.code + '&name=' + encodeURIComponent(h.name || ''),
    });
  },
});
