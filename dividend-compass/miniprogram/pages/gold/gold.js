// pages/gold/gold.js —— 黄金观察：给红利收息人的资产配置视角（避险/对冲/ETF 工具）
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    spot: null,        // goldBrief：上海金/Au(T+D)/伦敦金/溢价
    chart: null,       // goldChart：日K + 分位 + 股金对比
    chartFail: false,  // 金价日K不可用（东财118源异常时降级隐藏）
    etfs: null,        // 黄金ETF行情
    amount: '',        // 配置计算器输入
    calc: null,        // 计算结果（JS 预算）
    vsRows: null,      // 股金对比横条（JS 预算宽度）
  },

  onLoad() {
    this.loadSpot();
    this.loadChart();
    this.loadEtf();
  },

  onPullDownRefresh() {
    Promise.all([this.loadSpot(), this.loadChart(), this.loadEtf()]).then(() => wx.stopPullDownRefresh());
  },

  async loadSpot() {
    try {
      const spot = await util.callService('goldBrief');
      this.setData({ spot });
    } catch (e) { /* 静默，卡隐藏 */ }
  },

  async loadChart() {
    try {
      const chart = await util.callService('goldChart');
      // 股金对比横条宽度（按绝对值归一，JS 预算）
      let vsRows = null;
      if (chart.hs300Chg !== null && chart.hs300Chg !== undefined) {
        const defs = [
          { label: '上海金', v: chart.goldChg, cls: 'up' },
          { label: '沪深300', v: chart.hs300Chg, cls: chart.hs300Chg >= 0 ? 'up' : 'dn' },
        ];
        const maxAbs = Math.max.apply(null, defs.map((x) => Math.abs(x.v)).concat([1]));
        vsRows = defs.map((x) => ({
          label: x.label,
          valText: (x.v >= 0 ? '+' : '') + x.v.toFixed(1) + '%',
          pct: Math.max(3, Math.round((Math.abs(x.v) / maxAbs) * 100)),
          cls: x.cls,
        }));
      }
      this.setData({ chart, vsRows, chartFail: false }, () => this.drawGold());
    } catch (e) {
      this.setData({ chartFail: true });   // 金价日K源异常 → 走势/对比卡降级隐藏
    }
  },

  async loadEtf() {
    try {
      const list = await util.callService('quotes', {
        list: [
          { code: '518880', market: 'SH' },
          { code: '159934', market: 'SZ' },
          { code: '518800', market: 'SH' },
        ],
      });
      this.setData({ etfs: list && list.length ? list : null });
    } catch (e) { /* 静默 */ }
  },

  onAmountInput(e) { this.setData({ amount: e.detail.value }); },

  onCalc() {
    const amount = parseFloat(this.data.amount);
    const etf = (this.data.etfs || []).find((x) => x.code === '518880');
    if (!(amount > 0)) { wx.showToast({ title: '请输入可投资金额', icon: 'none' }); return; }
    if (!etf || !(etf.price > 0)) { wx.showToast({ title: 'ETF行情未就绪', icon: 'none' }); return; }
    const calc = [5, 8, 10].map((pct) => {
      const amt = +(amount * pct / 100).toFixed(0);
      return {
        pct,
        amountText: amt.toLocaleString('en-US'),
        shares: Math.floor(amt / 100 / etf.price) * 100,   // 场内按100份整数倍
      };
    });
    this.setData({ calc });
  },

  /* 金价曲线（金色面积线，Canvas 2D） */
  drawGold(attempt) {
    const chart = this.data.chart;
    if (!chart || !chart.points || chart.points.length < 2) return;
    const paint = (ctx, W, H) => {
      const points = chart.points;
      const padL = 8, padR = 52, padT = 18, padB = 20;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const prices = points.map((p) => p.price);
      let lo = Math.min.apply(null, prices);
      let hi = Math.max.apply(null, prices);
      const pad = (hi - lo) * 0.06 || hi * 0.002;
      lo -= pad; hi += pad;
      const n = points.length;
      const xs = points.map((_, i) => padL + (plotW * i) / (n - 1));
      const ys = prices.map((p) => padT + plotH * (1 - (p - lo) / (hi - lo)));
      // 网格 + 右侧价签
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#59626d';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      for (let g = 0; g <= 3; g++) {
        const y = padT + (plotH * g) / 3;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.fillText((hi - ((hi - lo) * g) / 3).toFixed(0), padL + plotW + 5, y + 3);
      }
      // 金色折线 + 面积
      ctx.beginPath();
      xs.forEach((x, i) => { if (i === 0) ctx.moveTo(x, ys[i]); else ctx.lineTo(x, ys[i]); });
      ctx.strokeStyle = '#e8b95f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, 'rgba(232, 185, 95, 0.22)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.lineTo(xs[n - 1], padT + plotH);
      ctx.lineTo(xs[0], padT + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      // 区间涨跌 + x 轴
      ctx.fillStyle = chart.goldChg >= 0 ? '#f04b5a' : '#00b578';
      ctx.textAlign = 'right';
      ctx.fillText('近1年 ' + (chart.goldChg >= 0 ? '+' : '') + chart.goldChg + '%', padL + plotW, padT - 6);
      ctx.fillStyle = '#59626d';
      for (let g = 0; g < 5; g++) {
        const idx = Math.round((n - 1) * g / 4);
        ctx.textAlign = g === 0 ? 'left' : g === 4 ? 'right' : 'center';
        ctx.fillText(points[idx].d.slice(2, 7).replace('-', '/'), xs[idx], H - 5);
      }
    };
    try {
      if (this._gcv && this._gctx) { paint(this._gctx, this._gW, this._gH); return; }
      const query = wx.createSelectorQuery();
      query.select('#goldCanvas').fields({ node: true, size: true });
      query.exec((res) => {
        if (!res || !res[0] || !res[0].node || !res[0].width) {
          if ((attempt || 1) < 3) setTimeout(() => this.drawGold((attempt || 1) + 1), 200);
          return;
        }
        const canvas = res[0].node;
        let dpr = 2;
        try { dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2; } catch (err) { /* 默认2 */ }
        canvas.width = res[0].width * dpr;
        canvas.height = res[0].height * dpr;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        this._gcv = canvas; this._gctx = ctx; this._gW = res[0].width; this._gH = res[0].height;
        paint(ctx, res[0].width, res[0].height);
      });
    } catch (e) { /* canvas 异常静默 */ }
  },

  goStock(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({ url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || '') });
  },
});
