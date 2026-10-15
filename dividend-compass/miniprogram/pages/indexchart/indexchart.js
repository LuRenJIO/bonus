// pages/indexchart/indexchart.js —— 指数走势：当日分时 + 历史曲线（近1年日线/近5年月线）
// 支持按住滑动：十字光标跟随 + 顶部数据条实时显示对应时间/价格/涨跌
const util = require('../../utils/util');

Page({
  data: {
    code: '',
    name: '',
    market: 'SH',
    mode: 'minute',       // minute=分时 | history=历史
    range: '1y',          // history 区间：1y | 5y
    loading: true,
    error: '',
    head: { price: '--', chgText: '--', chgCls: 'flat' },
    minuteData: null,     // {preClose, points}
    histCache: {},        // {1y: {...}, 5y: {...}}
    pressInfo: null,      // 按住滑动时的数据条 {time, price, chgText, chgCls}
  },

  onLoad(options) {
    this.setData({
      code: options.code || '',
      name: decodeURIComponent(options.name || '') || '指数',
      market: options.market || 'SH',
    });
    if (this.data.name) wx.setNavigationBarTitle({ title: this.data.name + ' · 走势' });
    this.loadMinute();
  },

  onPullDownRefresh() {
    const p = this.data.mode === 'minute' ? this.loadMinute() : this.loadHistory(this.data.range, true);
    p.then(() => wx.stopPullDownRefresh());
  },

  /* ---------- 数据加载 ---------- */
  async loadMinute() {
    this._cv = null;   // loading 切换会卸载重建 canvas，旧节点缓存必须失效
    this.setData({ loading: true, error: '' });
    try {
      const d = await util.callService('indexChart', {
        code: this.data.code, market: this.data.market, mode: 'minute',
      });
      this.setData({ loading: false, minuteData: d }, () => this.draw());
      this.updateHeadFromMinute(d);
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  async loadHistory(range, force) {
    const cache = this.data.histCache;
    if (cache[range] && !force) {
      // 已有缓存：无 loading 切换，canvas 仍挂载，直接重绘
      this.updateHeadFromHistory(cache[range]);
      this.draw();
      return;
    }
    this._cv = null;   // loading 将切换，canvas 会重建
    this.setData({ loading: true, error: '' });
    try {
      const d = await util.callService('indexChart', {
        code: this.data.code, market: this.data.market, mode: 'history', range,
      });
      const next = Object.assign({}, this.data.histCache);
      next[range] = d;
      this.setData({ loading: false, histCache: next }, () => this.draw());
      this.updateHeadFromHistory(d);
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  updateHeadFromMinute(d) {
    const pts = d.points || [];
    const last = pts[pts.length - 1];
    if (!last || !d.preClose) return;
    const chgPct = +(((last.price - d.preClose) / d.preClose) * 100).toFixed(2);
    this.setData({
      head: {
        price: last.price,
        chgText: (chgPct > 0 ? '+' : '') + chgPct + '%',
        chgCls: util.chgClass(chgPct),
      },
    });
  },

  updateHeadFromHistory(d) {
    const pts = d.points || [];
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    if (!last || !prev) return;
    const chgPct = +(((last.price - prev.price) / prev.price) * 100).toFixed(2);
    this.setData({
      head: {
        price: last.price,
        chgText: (chgPct > 0 ? '+' : '') + chgPct + '%',
        chgCls: util.chgClass(chgPct),
      },
    });
  },

  /* ---------- 交互 ---------- */
  onSwitchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.clearCrosshair();
    this.setData({ mode });
    if (mode === 'minute') {
      if (this.data.minuteData) { this.draw(); } else { this.loadMinute(); }
    } else {
      const cached = this.data.histCache[this.data.range];
      if (cached) { this.updateHeadFromHistory(cached); this.draw(); }
      else { this.loadHistory(this.data.range); }
    }
  },

  onSwitchRange(e) {
    const range = e.currentTarget.dataset.range;
    if (range === this.data.range) return;
    this.clearCrosshair();
    this.setData({ range });
    this.loadHistory(range);
  },

  /* ---------- 按住滑动：十字光标 + 数据条 ---------- */
  // 当前曲线点位（随模式变化）
  currentPoints() {
    if (this.data.mode === 'minute') {
      return this.data.minuteData ? this.data.minuteData.points : null;
    }
    const h = this.data.histCache[this.data.range];
    return h ? h.points : null;
  },

  onChartTouch(e) {
    const geo = this._geo;
    if (!geo) return;
    const pts = this.currentPoints();
    if (!pts || pts.length < 2) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const idx = Math.max(0, Math.min(pts.length - 1, Math.round(((t.x - geo.padL) / geo.plotW) * (pts.length - 1))));
    if (this._crossIdx === idx) return;   // 未跨点不重绘
    this._crossIdx = idx;
    this.draw();

    // 数据条内容：分时=对昨收涨跌；历史=对前一点涨跌
    const p = pts[idx];
    let chgPct, timeLabel;
    if (this.data.mode === 'minute') {
      chgPct = ((p.price - this.data.minuteData.preClose) / this.data.minuteData.preClose) * 100;
      timeLabel = p.t;
    } else {
      const prev = pts[idx - 1] || p;
      chgPct = prev.price > 0 ? (p.price / prev.price - 1) * 100 : 0;
      timeLabel = this.data.range === '5y' ? p.d : p.d.slice(5);   // 5年显示年-月，1年显示月-日
    }
    this.setData({
      pressInfo: {
        time: timeLabel,
        price: p.price,
        chgText: (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%',
        chgCls: util.chgClass(chgPct),
      },
    });
  },

  onChartTouchEnd() {
    this.clearCrosshair();
  },

  clearCrosshair() {
    if (this._crossIdx === undefined || this._crossIdx === null) return;
    this._crossIdx = null;
    this.setData({ pressInfo: null });
    this.draw();
  },

  /* ---------- Canvas 2D 渲染 ---------- */
  draw() {
    const paint = (canvas, ctx, W, H) => {
      ctx.clearRect(0, 0, W, H);
      if (this.data.mode === 'minute') this.renderMinute(ctx, W, H);
      else this.renderHistory(ctx, W, H);
      if (this._crossIdx !== undefined && this._crossIdx !== null) this.renderCrosshair(ctx);
    };
    try {
      // 已缓存画布节点则直接重绘（触摸滑动高频调用不走 SelectorQuery）
      if (this._cv && this._ctx) { paint(this._cv, this._ctx, this._cvW, this._cvH); return; }
      this.queryCanvas(1, paint);
    } catch (e) { /* canvas 异常静默 */ }
  },

  /** 查询画布节点；loading 切换/首屏时节点可能尚未挂载，最多重试 3 次 */
  queryCanvas(attempt, paint) {
    const query = wx.createSelectorQuery();
    query.select('#chartCanvas').fields({ node: true, size: true });
    query.exec((res) => {
      if (!res || !res[0] || !res[0].node || !res[0].width) {
        if (attempt < 3) setTimeout(() => this.queryCanvas(attempt + 1, paint), 200);
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
      this._cv = canvas; this._ctx = ctx; this._cvW = res[0].width; this._cvH = res[0].height;
      paint(canvas, ctx, res[0].width, res[0].height);
    });
  },

  /** 通用折线绘制（含面积渐变） */
  strokeLine(ctx, xs, ys, color, fillTop, plotH, padT) {
    ctx.beginPath();
    xs.forEach((x, i) => { if (i === 0) ctx.moveTo(x, ys[i]); else ctx.lineTo(x, ys[i]); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 面积渐变
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, fillTop);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.lineTo(xs[xs.length - 1], padT + plotH);
    ctx.lineTo(xs[0], padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  },

  /** 十字光标（按住滑动） */
  renderCrosshair(ctx) {
    const geo = this._geo;
    const pts = this.currentPoints();
    if (!geo || !pts) return;
    const i = Math.min(this._crossIdx, pts.length - 1);
    const x = geo.padL + (geo.plotW * i) / (pts.length - 1);
    const y = geo.padT + geo.plotH * (1 - (pts[i].price - geo.lo) / (geo.hi - geo.lo));
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(230, 237, 243, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, geo.padT); ctx.lineTo(x, geo.padT + geo.plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(geo.padL, y); ctx.lineTo(geo.padL + geo.plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#e6edf3';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(230, 237, 243, 0.4)';
    ctx.stroke();
  },

  renderMinute(ctx, W, H) {
    const d = this.data.minuteData;
    if (!d || !d.points || d.points.length < 2) return;
    const padL = 8, padR = 62, padT = 22, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const prices = d.points.map((p) => p.price);
    let lo = Math.min(d.preClose, Math.min.apply(null, prices));
    let hi = Math.max(d.preClose, Math.max.apply(null, prices));
    const pad = (hi - lo) * 0.08 || hi * 0.002;
    lo -= pad; hi += pad;
    this._geo = { padL, padT, plotW, plotH, lo, hi };

    const n = d.points.length;
    const xs = d.points.map((_, i) => padL + (plotW * i) / (n - 1));
    const ys = prices.map((p) => padT + plotH * (1 - (p - lo) / (hi - lo)));
    const yBase = padT + plotH * (1 - (d.preClose - lo) / (hi - lo));
    const up = prices[prices.length - 1] >= d.preClose;
    const lineColor = up ? '#f04b5a' : '#00b578';

    // 昨收虚线 + 标签
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, yBase);
    ctx.lineTo(padL + plotW, yBase);
    ctx.strokeStyle = 'rgba(212, 169, 78, 0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#d4a94e';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('昨收 ' + d.preClose.toFixed(2), padL + plotW + 6, yBase + 3);

    // 现价标签
    ctx.fillStyle = lineColor;
    ctx.fillText(prices[prices.length - 1].toFixed(2), padL + plotW + 6, ys[ys.length - 1] + 3);

    this.strokeLine(ctx, xs, ys, lineColor, up ? 'rgba(240, 75, 90, 0.18)' : 'rgba(0, 181, 120, 0.18)', plotH, padT);

    // x 轴时间标签（A股交易时段：午休在 120/121 点之间）
    ctx.fillStyle = '#59626d';
    ctx.textAlign = 'left';
    ctx.fillText('09:30', padL, H - 8);
    ctx.textAlign = 'center';
    ctx.fillText('11:30/13:00', padL + plotW / 2, H - 8);
    ctx.textAlign = 'right';
    ctx.fillText('15:00', padL + plotW, H - 8);
  },

  renderHistory(ctx, W, H) {
    const d = this.data.histCache[this.data.range];
    if (!d || !d.points || d.points.length < 2) return;
    const padL = 8, padR = 62, padT = 22, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const prices = d.points.map((p) => p.price);
    let lo = Math.min.apply(null, prices);
    let hi = Math.max.apply(null, prices);
    const pad = (hi - lo) * 0.06 || hi * 0.002;
    lo -= pad; hi += pad;
    this._geo = { padL, padT, plotW, plotH, lo, hi };

    const n = d.points.length;
    const xs = d.points.map((_, i) => padL + (plotW * i) / (n - 1));
    const ys = prices.map((p) => padT + plotH * (1 - (p - lo) / (hi - lo)));

    // 网格 4 条 + 右侧价签
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
      ctx.fillText(val.toFixed(0), padL + plotW + 6, y + 3);
    }

    // 区间涨跌幅标注（右上角）
    const totalPct = ((prices[prices.length - 1] / prices[0] - 1) * 100).toFixed(1);
    ctx.fillStyle = totalPct >= 0 ? '#f04b5a' : '#00b578';
    ctx.textAlign = 'right';
    ctx.fillText('区间 ' + (totalPct >= 0 ? '+' : '') + totalPct + '%', padL + plotW, padT - 8);

    this.strokeLine(ctx, xs, ys, '#d4a94e', 'rgba(212, 169, 78, 0.20)', plotH, padT);

    // x 轴 5 个采样标签
    ctx.fillStyle = '#59626d';
    for (let g = 0; g < 5; g++) {
      const idx = Math.round((n - 1) * g / 4);
      const raw = d.points[idx].d;   // 'YYYY-MM-DD' 或 'YYYY-MM'
      const label = this.data.range === '5y' ? raw.slice(2, 7).replace('-', '/') : raw.slice(5, 7) + '月';
      ctx.textAlign = g === 0 ? 'left' : g === 4 ? 'right' : 'center';
      ctx.fillText(label, xs[idx], H - 8);
    }
  },
});
