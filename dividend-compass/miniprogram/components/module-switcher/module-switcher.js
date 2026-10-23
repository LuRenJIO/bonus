// components/module-switcher/module-switcher.js —— 全局模块快切器：FAB + 底部模块面板（reLaunch 直达）
Component({
  properties: {
    current: { type: String, value: '' },   // 当前模块 key：''=门户 | strategy | gold
  },
  data: {
    open: false,
    modules: [
      { key: 'strategy', name: '低波红利策略', desc: '行情 · 筛选 · 日历 · 记账', url: '/pages/index/index', icon: 'chart' },
      { key: 'gold', name: '黄金观察', desc: '金价 · 走势 · ETF 配置', url: '/pages/gold/gold', icon: 'gold' },
    ],
  },
  methods: {
    toggle() { this.setData({ open: !this.data.open }); },
    close() { this.setData({ open: false }); },
    noop() {},
    onPick(e) {
      const key = e.currentTarget.dataset.key;
      const url = e.currentTarget.dataset.url;
      this.setData({ open: false });
      if (key === this.data.current) return;
      wx.reLaunch({ url });   // 模块切换语义：清栈直达目标模块根页
    },
  },
});
