// pages/calendar/calendar.js —— 分红日历：自选股近期分红 / 全市场未来除息
const util = require('../../utils/util');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

Page({
  data: {
    tab: 'fav',          // fav=自选 | mkt=全市场
    loading: true,
    error: '',
    favGroups: [],       // 自选：[{stock:{code,name}, items:[...]}]
    mktGroups: [],       // 全市场：[{date, label, count, items:[...]}]
    favCount: 0,
    mktCount: 0,
  },

  onLoad() {
    this.loadCalendar();
  },

  onPullDownRefresh() {
    this.loadCalendar().then(() => wx.stopPullDownRefresh());
  },

  async loadCalendar() {
    if (!this.data.favGroups.length && !this.data.mktGroups.length) {
      this.setData({ loading: true, error: '' });
    }
    try {
      // 取自选列表（失败不阻塞全市场视图）
      let favs = [];
      try {
        favs = await util.callFavorites('list');
      } catch (e) { /* favorites 未部署时仅展示全市场 */ }

      const d = await util.callService('calendar', {
        days: 30,
        codes: favs.map((f) => ({ code: f.code, name: f.name, market: f.market })),
      });

      // 自选：每只股票一组
      const favGroups = (d.fav || []).map((g) => ({
        stock: { code: g.code, name: g.name },
        items: g.items.map((it) => this.decorateFavItem(it)),
      }));

      // 全市场：按除息日分组
      const byDate = {};
      (d.market || []).forEach((r) => {
        if (!byDate[r.exDate]) byDate[r.exDate] = [];
        byDate[r.exDate].push(r);
      });
      const mktGroups = Object.keys(byDate).sort().map((date) => {
        const dt = new Date(date + 'T00:00:00');
        return {
          date,
          label: (dt.getMonth() + 1) + '月' + dt.getDate() + '日 · ' + WEEK[dt.getDay()],
          items: byDate[date],
        };
      });

      this.setData({
        loading: false,
        error: '',
        favGroups,
        mktGroups,
        favCount: favGroups.reduce((a, g) => a + g.items.length, 0),
        mktCount: (d.market || []).length,
      });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  /** 自选分红项展示字段：日期文案 + 进度标签 */
  decorateFavItem(it) {
    let dateText = '日期未定';
    if (it.exDate) {
      const dt = new Date(it.exDate + 'T00:00:00');
      dateText = (dt.getMonth() + 1) + '月' + dt.getDate() + '日 · ' + WEEK[dt.getDay()];
    }
    return {
      exDate: it.exDate,
      dateText,
      perShare: it.perShare,
      profile: it.profile,
      isPlan: !it.exDate,   // 预案（未定除息日）
    };
  },

  onSwitchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  goStock(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || '') +
        '&market=' + (d.market || ''),
    });
  },

  onRetry() {
    this.loadCalendar();
  },
});
