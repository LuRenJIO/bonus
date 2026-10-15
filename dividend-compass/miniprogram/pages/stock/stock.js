// pages/stock/stock.js —— 股票详情：行情/股息率/预测/分红史/财报/体检
const util = require('../../utils/util');

Page({
  data: {
    code: '',
    name: '',
    market: '',
    loading: true,
    error: '',
    d: null,            // overview 聚合数据
    ladder: null,       // 股息率阶梯计算结果
    ladderInput: '',    // 分红基准输入框内容（元/股）
    ladderDefault: null,// 默认预期分红（"恢复预期"按钮用）
    predMode: 'basic',  // basic=多模型区间 | enhanced=盈利修正
    isFav: false,
    favBusy: false,
  },

  onLoad(options) {
    this.setData({
      code: options.code || '',
      name: decodeURIComponent(options.name || ''),
      market: options.market || '',
    });
    if (this.data.name) wx.setNavigationBarTitle({ title: this.data.name });
    this.loadOverview();
    this.checkFav();
  },

  onPullDownRefresh() {
    this.loadOverview(true).then(() => wx.stopPullDownRefresh());
  },

  /**
   * @param force true=绕过云函数缓存强制刷新（刷新按钮/下拉刷新用）
   */
  async loadOverview(force) {
    if (!this.data.d) this.setData({ loading: true, error: '' });
    try {
      const d = await util.callService('overview', {
        code: this.data.code,
        market: this.data.market,
        name: this.data.name,
        refresh: force === true,
      });
      if (d.name) wx.setNavigationBarTitle({ title: d.name });
      const ld = this.buildLadderData(d);
      this.setData({
        d: d,
        loading: false,
        error: '',
        ladder: ld ? ld.ladder : null,
        ladderInput: ld ? ld.input : '',
        ladderDefault: ld ? ld.def : null,
      });
      util.addRecent({ code: this.data.code, name: d.name || this.data.name, market: this.data.market });
      if (d.yieldCurve && d.yieldCurve.points && d.yieldCurve.points.length >= 2) {
        this.drawYieldChart();   // setData 完成后 canvas 节点已就绪
      }
    } catch (e) {
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  /* ---------- 股息率阶梯（分红基准可编辑，默认预期分红） ---------- */
  buildLadderData(d) {
    if (!d || !d.quote || !d.quote.price) return null;
    const p = d.prediction;
    // 默认基准：盈利修正中性预测，退回多模型中性
    const def = (p && p.enhanced && p.enhanced.range) ? p.enhanced.range.neutral
      : (p && p.basic ? p.basic.range.neutral : null);
    const ok = def !== null && isFinite(def) && def > 0;
    return {
      def: ok ? def : null,
      input: ok ? def.toFixed(3) : '',   // 与预期分红卡一致保留3位小数
      ladder: ok ? util.buildLadder(def, d.quote.price) : null,
    };
  },

  onLadderInput(e) {
    const raw = (e.detail.value || '').trim();
    const price = this.data.d && this.data.d.quote && this.data.d.quote.price;
    const patch = { ladderInput: raw };
    const v = parseFloat(raw);
    if (price && isFinite(v) && v > 0) {
      patch.ladder = util.buildLadder(v, price);   // 非法输入时保留上一次合法结果
    }
    this.setData(patch);
  },

  onLadderReset() {
    const price = this.data.d && this.data.d.quote && this.data.d.quote.price;
    if (!price || !this.data.ladderDefault) return;
    this.setData({
      ladderInput: this.data.ladderDefault.toFixed(3),
      ladder: util.buildLadder(this.data.ladderDefault, price),
    });
  },

  /* ---------- 股息率曲线（Canvas 2D） ---------- */
  drawYieldChart() {
    try {
      const query = wx.createSelectorQuery();
      query.select('#yieldCanvas').fields({ node: true, size: true });
      query.exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        this.renderChart(res[0].node, res[0].width, res[0].height);
      });
    } catch (e) { /* canvas 异常静默，不影响页面 */ }
  },

  renderChart(canvas, cssW, cssH) {
    const d = this.data.d;
    const series = d && d.yieldCurve;
    if (!series || !series.points || series.points.length < 2) return;
    let dpr = 2;
    try { dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2; } catch (e) { /* 默认2 */ }
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const pts = series.points;
    const exp = series.expected;
    const PAD = { l: 10, r: 46, t: 16, b: 24 };
    const plotW = cssW - PAD.l - PAD.r;
    const plotH = cssH - PAD.t - PAD.b;

    // Y 轴刻度：0 → niceMax（0.5% 步进）
    let maxV = 0;
    pts.forEach((p) => { if (p.yield > maxV) maxV = p.yield; });
    if (exp && exp.yield > maxV) maxV = exp.yield;
    const yMax = Math.max(1, Math.ceil((maxV * 1.12) * 2) / 2);
    const yStep = yMax > 8 ? 2 : (yMax > 4 ? 1 : 0.5);
    const xOf = (i, total) => PAD.l + (total <= 1 ? 0 : (i / (total - 1)) * plotW);
    const yOf = (v) => PAD.t + (1 - v / yMax) * plotH;

    // 网格与右轴标签
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= yMax + 1e-9; v += yStep) {
      const y = yOf(v);
      ctx.strokeStyle = v === 0 ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(139,148,158,0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(v + '%', PAD.l + plotW + 6, y);
    }

    // 渐变填充（曲线下方）
    const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + plotH);
    grad.addColorStop(0, 'rgba(212,169,78,0.28)');
    grad.addColorStop(1, 'rgba(212,169,78,0.02)');
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(i, pts.length);
      const y = yOf(p.yield);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(xOf(pts.length - 1, pts.length), PAD.t + plotH);
    ctx.lineTo(PAD.l, PAD.t + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 历史曲线（金色）+ 数据点
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(i, pts.length);
      const y = yOf(p.yield);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#d4a94e';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // 最新点实心
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(xOf(pts.length - 1, pts.length), yOf(last.yield), 3, 0, Math.PI * 2);
    ctx.fillStyle = '#d4a94e';
    ctx.fill();

    // 预期段：金色虚线延伸 + 红色空心点 + 数值标签
    if (exp) {
      const x0 = xOf(pts.length - 1, pts.length);
      const x1 = xOf(pts.length, pts.length + 1);
      ctx.beginPath();
      ctx.moveTo(x0, yOf(last.yield));
      ctx.lineTo(x1, yOf(exp.yield));
      ctx.strokeStyle = 'rgba(229,115,115,0.9)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x1, yOf(exp.yield), 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#e57373';
      ctx.fillStyle = '#1a1d24';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e57373';
      ctx.textAlign = 'right';
      ctx.fillText(exp.yield + '%', x1 + 34, yOf(exp.yield) - 8);
    }

    // 现价 TTM 参考线（与核心卡一致的最新值，灰色细虚线）
    ctx.beginPath();
    ctx.moveTo(PAD.l, yOf(last.yield));
    ctx.lineTo(PAD.l + plotW, yOf(last.yield));
    ctx.strokeStyle = 'rgba(212,169,78,0.35)';
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // X 轴年份标签：每年 1 月处
    ctx.fillStyle = 'rgba(139,148,158,0.9)';
    ctx.textAlign = 'center';
    let lastYear = '';
    pts.forEach((p, i) => {
      const yy = p.ym.slice(0, 4);
      if (p.ym.slice(5, 7) === '01' && yy !== lastYear) {
        ctx.fillText(yy, xOf(i, pts.length), cssH - 8);
        lastYear = yy;
      }
    });
    // 末尾补当年标签（若最后点非1月且与首个标签同年则跳过）
    const endYear = last.ym.slice(0, 4);
    if (endYear !== lastYear) {
      ctx.fillText(endYear, xOf(pts.length - 1, pts.length), cssH - 8);
      lastYear = endYear;
    }
    // 预期标签
    if (exp) {
      ctx.fillStyle = '#e57373';
      ctx.fillText('预期', xOf(pts.length, pts.length + 1), cssH - 8);
    }
  },

  /* ---------- 预测模式切换 ---------- */
  onSwitchPredMode(e) {
    this.setData({ predMode: e.currentTarget.dataset.mode });
  },

  /* ---------- 自选 ---------- */
  async checkFav() {
    try {
      const list = await util.callFavorites('list');
      this.setData({ isFav: list.some((it) => it.code === this.data.code) });
    } catch (e) { /* 忽略 */ }
  },

  async onToggleFav() {
    if (this.data.favBusy) return;
    this.setData({ favBusy: true });
    try {
      if (this.data.isFav) {
        await util.callFavorites('remove', { code: this.data.code });
        this.setData({ isFav: false });
        wx.showToast({ title: '已移除自选', icon: 'none' });
      } else {
        await util.callFavorites('add', {
          code: this.data.code,
          name: (this.data.d && this.data.d.name) || this.data.name,
          market: this.data.market,
        });
        this.setData({ isFav: true });
        wx.showToast({ title: '已加入自选', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
    this.setData({ favBusy: false });
  },

  onRetry() {
    // 已有数据时静默强制刷新（绕过云函数缓存，保留页面内容），首次加载才显示全屏 loading
    this.loadOverview(true);
  },

  onShareAppMessage() {
    const d = this.data.d;
    return {
      title: (d ? d.name : this.data.name) + ' 股息率分析 · 拾息记',
      path: '/pages/stock/stock?code=' + this.data.code + '&name=' +
        encodeURIComponent((d && d.name) || this.data.name) + '&market=' + this.data.market,
    };
  },
});
