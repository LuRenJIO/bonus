// pages/gold/gold.js —— 黄金观察：实时金价（30s轮询）+ 分时/1年/3年切换（滑动查看）+ ETF + 配置估算
const util = require('../../utils/util');

// 场内黄金ETF静态名称兜底（quotes 行情接口不返回名称）
const ETF_NAMES = {
  '518880': '华安黄金ETF',
  '159934': '易方达黄金ETF',
  '518800': '国泰黄金ETF',
};

Page({
  data: {
    loading: true,
    spot: null,
    etfs: null,
    amount: '',
    calc: null,
    // 走势
    goldMode: 'minute',   // minute=分时 | 1y | 3y
    minute: null,         // 当日分时 {date, points}
    chart: null,          // 日K（按 range）
    chartLoading: false,
    chartFail: false,
    press: null,          // 滑动数据条 {time, price}
    monthly: null,        // 股金月度对比行
    vsSummary: '',
    // 现货卡滚动区间涨跌文本（JS 预算）
    spotRows: null,
  },

  onLoad() {
    this.loadSpot();
    this.loadMinute();   // 默认分时模式
    this.loadEtf();
    this._timer = setInterval(() => this.loadSpot(), 30000);   // 30秒轮询实时金价
  },

  onShow() {
    if (this._loadedOnce) this.loadSpot();   // 从其他页面返回时立即刷新
    this._loadedOnce = true;
  },

  onHide() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  onUnload() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  onPullDownRefresh() {
    Promise.all([this.loadSpot(), this.loadEtf(), this.data.goldMode === 'minute' ? this.loadMinute() : this.loadChart()])
      .then(() => wx.stopPullDownRefresh());
  },

  /* ---------- 实时金价（30秒轮询） ---------- */
  async loadSpot() {
    try {
      const spot = await util.callService('goldBrief');
      // 现货卡三行（涨跌对昨结算，JS 预算文案）
      const rows = [];
      const mk = (name, o, unit) => {
        if (!o || o.price === undefined || o.price === null) return;
        rows.push({
          name,
          unit,
          valText: String(o.price),
          chgText: o.chgPct === undefined || o.chgPct === null ? '--' : (o.chgPct >= 0 ? '+' : '') + o.chgPct + '%',
          chgCls: o.chgPct >= 0 ? 'up' : 'dn',
          rangeText: o.high !== undefined && o.low !== undefined ? '高 ' + o.high + ' / 低 ' + o.low : '',
        });
      };
      mk('上海金 Au9999', spot.shanghai, '元/克');
      mk('Au(T+D)', spot.autd, '元/克');
      mk('伦敦金', spot.xau, '美元/盎司');
      this.setData({ spot, spotRows: rows });
    } catch (e) { /* 静默，保持上次数据 */ }
  },

  /* ---------- 走势（分时/1年/3年） ---------- */
  onGoldModeTap(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.goldMode) return;
    this.setData({ goldMode: mode, press: null });
    if (mode === 'minute') this.loadMinute();
    else this.loadChart();
  },

  async loadMinute() {
    this.setData({ chartLoading: true });
    try {
      const minute = await util.callService('goldMinute');
      this.setData({ minute, chartLoading: false }, () => this.drawGold());
    } catch (e) {
      this.setData({ minute: null, chartLoading: false });
    }
  },

  async loadChart() {
    this.setData({ chartLoading: true });
    try {
      const chart = await util.callService('goldChart', { range: this.data.goldMode });
      // 月度对比行（JS 预算涨跌文本与颜色）
      const monthly = (chart.monthly || []).map((m) => ({
        ym: m.ym,
        goldText: (m.gold >= 0 ? '+' : '') + m.gold + '%',
        goldCls: m.gold >= 0 ? 'up' : 'dn',
        hs300Text: (m.hs300 >= 0 ? '+' : '') + m.hs300 + '%',
        hs300Cls: m.hs300 >= 0 ? 'up' : 'dn',
      }));
      // 对冲结论
      let vsSummary = '';
      if (chart.sameDirMonths !== null) {
        vsSummary = chart.sameDirMonths <= 5
          ? '近' + chart.totalMonths + '个月中仅 ' + chart.sameDirMonths + ' 个月股金同向——反向居多，黄金的对冲属性真实存在'
          : chart.sameDirMonths >= 9
            ? '近' + chart.totalMonths + '个月中 ' + chart.sameDirMonths + ' 个月股金同向——本阶段同涨同跌，对冲效果有限'
            : '近' + chart.totalMonths + '个月中 ' + chart.sameDirMonths + ' 个月股金同向——对冲特征一般，需结合仓位看';
      }
      this.setData({ chart, monthly, vsSummary, chartLoading: false, chartFail: false }, () => this.drawGold());
    } catch (e) {
      this.setData({ chart: null, chartFail: true, chartLoading: false });
    }
  },

  /* 当前模式的数据点与时间标签 */
  goldPoints() {
    if (this.data.goldMode === 'minute') {
      return this.data.minute ? this.data.minute.points : null;   // {t, price}
    }
    return this.data.chart ? this.data.chart.points : null;       // {d, price}
  },

  /* ---------- 滑动查看：十字光标 + 数据条 ---------- */
  onGoldTouch(e) {
    const geo = this._gGeo;
    if (!geo) return;
    const pts = this.goldPoints();
    if (!pts || pts.length < 2) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const idx = Math.max(0, Math.min(pts.length - 1, Math.round(((t.x - geo.padL) / geo.plotW) * (pts.length - 1))));
    if (this._gCrossIdx === idx) return;
    this._gCrossIdx = idx;
    this.drawGold();

    const p = pts[idx];
    const time = this.data.goldMode === 'minute' ? p.t : p.d.slice(5);   // 分时 HH:MM / 日K MM-DD
    this.setData({ press: { time, price: p.price } });
  },

  onGoldTouchEnd() {
    if (this._gCrossIdx === undefined || this._gCrossIdx === null) return;
    this._gCrossIdx = null;
    this.setData({ press: null });
    this.drawGold();
  },

  drawGold(attempt) {
    const paint = (ctx, W, H) => {
      const pts = this.goldPoints();
      if (!pts || pts.length < 2) return;
      const minute = this.data.goldMode === 'minute';
      const padL = 8, padR = 54, padT = 18, padB = 20;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const prices = pts.map((p) => p.price);
      let lo = Math.min.apply(null, prices);
      let hi = Math.max.apply(null, prices);
      const pad = (hi - lo) * 0.07 || hi * 0.002;
      lo -= pad; hi += pad;
      this._gGeo = { padL, padT, plotW, plotH };
      const n = pts.length;
      const xs = pts.map((_, i) => padL + (plotW * i) / (n - 1));
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
      // x 轴标签
      ctx.fillStyle = '#59626d';
      if (minute) {
        ctx.textAlign = 'left'; ctx.fillText(pts[0].t, padL, H - 5);
        ctx.textAlign = 'center'; ctx.fillText(pts[Math.floor((n - 1) / 2)].t, padL + plotW / 2, H - 5);
        ctx.textAlign = 'right'; ctx.fillText(pts[n - 1].t, padL + plotW, H - 5);
      } else {
        for (let g = 0; g < 5; g++) {
          const idx = Math.round((n - 1) * g / 4);
          ctx.textAlign = g === 0 ? 'left' : g === 4 ? 'right' : 'center';
          ctx.fillText(pts[idx].d.slice(2, 7).replace('-', '/'), xs[idx], H - 5);
        }
      }
      // 十字光标
      if (this._gCrossIdx !== undefined && this._gCrossIdx !== null) {
        const i = Math.min(this._gCrossIdx, n - 1);
        const cx = xs[i], cy = ys[i];
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(230, 237, 243, 0.55)';
        ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(padL, cy); ctx.lineTo(padL + plotW, cy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#e6edf3'; ctx.fill();
      }
      // 区间涨跌（右上，仅日K模式）
      if (!minute && this.data.chart) {
        ctx.fillStyle = this.data.chart.goldChg >= 0 ? '#f04b5a' : '#00b578';
        ctx.textAlign = 'right';
        ctx.fillText('区间 ' + (this.data.chart.goldChg >= 0 ? '+' : '') + this.data.chart.goldChg + '%', padL + plotW, padT - 6);
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

  /* ---------- ETF 与配置估算 ---------- */
  async loadEtf() {
    try {
      const list = await util.callService('quotes', {
        list: [
          { code: '518880', market: 'SH' },
          { code: '159934', market: 'SZ' },
          { code: '518800', market: 'SH' },
        ],
      });
      const etfs = (list || []).map((x) => ({
        code: x.code,
        name: ETF_NAMES[x.code] || x.name || x.code,   // 行情接口无名称 → 静态映射兜底
        price: x.price,
        changePercent: x.changePercent,
      }));
      this.setData({ etfs: etfs.length ? etfs : null });
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

  goStock(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({ url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || '') });
  },
});
