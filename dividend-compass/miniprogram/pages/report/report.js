// pages/report/report.js —— 年度收息报告：统计卡片 + 月份分布 + 分享图生成
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    error: '',
    empty: false,
    r: null,            // annualReport 数据
    maxMonth: 1,        // 月份条形归一化
    months: [],         // [{label, val, h}] h=条形高度rpx
    saving: false,
  },

  onLoad() {
    this.loadReport();
  },

  async loadReport() {
    this.setData({ loading: true, error: '' });
    try {
      const holdings = await util.callFavorites('holdingList');
      if (!holdings.length) { this.setData({ loading: false, empty: true }); return; }
      const r = await util.callService('annualReport', {
        holdings: holdings.map((h) => ({ code: h.code, name: h.name, shares: h.shares })),
      });
      if (!r || r.total <= 0) { this.setData({ loading: false, empty: true }); return; }
      const maxMonth = Math.max.apply(null, r.byMonth) || 1;
      const months = r.byMonth.map((v, i) => ({
        label: (i + 1) + '月',
        val: v,
        valText: v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(Math.round(v)),   // WXML 不支持函数调用，JS 侧格式化
        h: Math.max(6, Math.round((v / maxMonth) * 150)),
      }));
      this.setData({ loading: false, r, months, maxMonth });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  goPortfolio() {
    wx.navigateTo({ url: '/pages/portfolio/portfolio' });
  },

  goStock(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || ''),
    });
  },

  /** 生成分享图：Canvas 绘制 → 分享/保存相册 */
  async onSaveCard() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    let tmp = null;   // 提升作用域：分享失败时 catch 内仍可引用去保存相册
    try {
      const query = wx.createSelectorQuery();
      query.select('#reportCanvas').fields({ node: true, size: true });
      const res = await new Promise((resolve) => query.exec(resolve));
      if (!res || !res[0] || !res[0].node) throw new Error('画布未就绪');
      const canvas = res[0].node;
      const scale = 2;
      canvas.width = 750 * scale;
      canvas.height = 1000 * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      this.drawCard(ctx, canvas);

      tmp = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({ canvas, success: resolve, fail: reject });
      });
      // 优先唤起分享菜单；用户取消/不支持 → 降级保存相册
      try {
        await wx.showShareImageMenu({ path: tmp.tempFilePath });
      } catch (e) {
        await wx.saveImageToPhotosAlbum({ filePath: tmp.tempFilePath });
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      }
      this.setData({ saving: false });
    } catch (e) {
      this.setData({ saving: false });
      wx.showToast({ title: (e && e.errMsg && /auth/.test(e.errMsg)) ? '请在设置中允许保存到相册' : (e.message || '生成失败，请重试'), icon: 'none' });
    }
  },

  /** 分享图绘制（750×1000 逻辑尺寸） */
  drawCard(ctx, canvas) {
    const r = this.data.r;
    const W = 750, H = 1000;
    // 背景
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#161b22';
    ctx.fillRect(40, 40, W - 80, H - 80);
    ctx.strokeStyle = 'rgba(212,169,78,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(40, 40, W - 80, H - 80);
    // 品牌
    ctx.fillStyle = '#d4a94e';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText('拾息记', 80, 130);
    ctx.fillStyle = '#8b949e';
    ctx.font = '26px sans-serif';
    ctx.fillText(r.year + ' 年度收息报告', 80, 175);
    // 总额
    ctx.fillStyle = '#e6edf3';
    ctx.font = '26px sans-serif';
    ctx.fillText('今年已收分红（税前）', 80, 260);
    ctx.fillStyle = '#d4a94e';
    ctx.font = 'bold 96px sans-serif';
    ctx.fillText(r.total.toFixed(2), 80, 360);
    ctx.fillStyle = '#8b949e';
    ctx.font = '30px sans-serif';
    ctx.fillText('元', 80 + String(r.total.toFixed(2)).length * 52, 360);
    // 指标行
    ctx.fillStyle = '#e6edf3';
    ctx.font = '28px sans-serif';
    ctx.fillText('覆盖 ' + r.monthsActive + ' 个月 · 持仓 ' + r.holdingCount + ' 只', 80, 430);
    if (r.topStock) {
      ctx.fillText('收息冠军：' + r.topStock.name + ' ' + r.topStock.amount.toFixed(0) + ' 元', 80, 480);
    }
    // 月份条形
    const maxM = Math.max.apply(null, r.byMonth) || 1;
    ctx.fillStyle = '#8b949e';
    ctx.font = '24px sans-serif';
    ctx.fillText('月度分布', 80, 560);
    const bw = 44, gap = 10, x0 = 80, y0 = 850;
    r.byMonth.forEach((v, i) => {
      const h = Math.max(6, (v / maxM) * 240);
      ctx.fillStyle = v > 0 ? '#d4a94e' : 'rgba(148,163,184,0.25)';
      ctx.fillRect(x0 + i * (bw + gap), y0 - h, bw, h);
      ctx.fillStyle = '#59626d';
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x0 + i * (bw + gap) + bw / 2, y0 + 32);
      ctx.textAlign = 'left';
    });
    // 落款
    ctx.fillStyle = '#59626d';
    ctx.font = '24px sans-serif';
    ctx.fillText('低波红利 · 长期收息 · 拾息记', 80, 930);
  },
});
