// pages/reinvest/reinvest.js —— 分红再投资模拟器：真实历史价格+分红，对比"分红再投 vs 现金持有"
const util = require('../../utils/util');

Page({
  data: {
    code: '',
    name: '',
    market: '',
    capital: '100000',
    years: 5,
    loading: true,
    error: '',
    d: null,
    lines: null,        // 归一化双线坐标
  },

  onLoad(options) {
    this.setData({
      code: options.code || '',
      name: decodeURIComponent(options.name || ''),
      market: options.market || '',
    });
    if (this.data.name) wx.setNavigationBarTitle({ title: this.data.name + ' · 再投模拟' });
    this.loadSim();
  },

  onPullDownRefresh() {
    this.loadSim(true).then(() => wx.stopPullDownRefresh());
  },

  async loadSim(force) {
    this.setData({ loading: true, error: '' });
    try {
      const d = await util.callService('reinvest', {
        code: this.data.code, market: this.data.market,
        years: this.data.years, capital: Number(this.data.capital) || 100000,
      });
      this.setData({ loading: false, error: '', d });
      this.drawChart();
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  onCapitalInput(e) { this.setData({ capital: e.detail.value }); },
  onCapitalConfirm() { this.loadSim(); },

  onYearsTap(e) {
    const v = Number(e.currentTarget.dataset.v);
    if (v === this.data.years) return;
    this.setData({ years: v });
    this.loadSim();
  },

  /* ---------- 双线图（再投·金 / 不再投·蓝） ---------- */
  drawChart() {
    const d = this.data.d;
    if (!d || !d.series || d.series.length < 2) return;
    const query = wx.createSelectorQuery();
    query.select('#riCanvas').fields({ node: true, size: true });
    query.exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      let dpr = 2;
      try { dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2; } catch (err) { /* 默认2 */ }
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      const W = res[0].width, H = res[0].height;
      ctx.clearRect(0, 0, W, H);
      this.renderLines(ctx, W, H, d.series);
    });
  },

  renderLines(ctx, W, H, series) {
    const padL = 8, padR = 66, padT = 26, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const all = [];
    series.forEach((p) => { all.push(p.vr, p.vp); });
    let lo = Math.min.apply(null, all) * 0.94;
    let hi = Math.max.apply(null, all) * 1.06;
    const n = series.length;
    const xs = series.map((_, i) => padL + (plotW * i) / (n - 1));
    const yOf = (v) => padT + plotH * (1 - (v - lo) / (hi - lo));

    // 网格
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#59626d';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    for (let g = 0; g <= 4; g++) {
      const y = padT + (plotH * g) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      const val = hi - ((hi - lo) * g) / 4;
      ctx.fillText(val >= 10000 ? (val / 10000).toFixed(1) + '万' : val.toFixed(0), padL + plotW + 6, y + 3);
    }

    const drawLine = (key, color, width) => {
      ctx.beginPath();
      series.forEach((p, i) => {
        const x = xs[i], y = yOf(p[key]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    drawLine('vp', '#4c8dff', 1.5);       // 不再投（蓝）
    drawLine('vr', '#d4a94e', 2);         // 再投（金）

    // 图例
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#d4a94e';
    ctx.fillText('— 分红再投', padL, padT - 10);
    ctx.fillStyle = '#4c8dff';
    ctx.fillText('— 现金持有', padL + 90, padT - 10);

    // x 轴 5 个采样标签
    ctx.fillStyle = '#59626d';
    for (let g = 0; g < 5; g++) {
      const idx = Math.round((n - 1) * g / 4);
      ctx.textAlign = g === 0 ? 'left' : g === 4 ? 'right' : 'center';
      ctx.fillText(series[idx].d, xs[idx], H - 8);
    }
  },
});
