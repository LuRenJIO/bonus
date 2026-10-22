// pages/stock/stock.js —— 股票详情：行情/股息率/预测/分红史/财报/体检
const util = require('../../utils/util');
const config = require('../../config');

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
    alertOn: false,       // 已设股息率提醒
    alertThreshold: null, // 提醒阈值（%）
    priceMode: 'minute',  // 价格走势：minute=分时 | daily=日K
    priceLoading: false,
  },

  _priceMinute: null,    // 分时缓存（页面实例级）
  _priceDaily: null,     // 日K缓存
  _priceLoading: false,

  onLoad(options) {
    this.setData({
      code: options.code || '',
      name: decodeURIComponent(options.name || ''),
      market: options.market || '',
    });
    if (this.data.name) wx.setNavigationBarTitle({ title: this.data.name });
    this.loadOverview();
    this.checkFav();
    this.loadAlert();
  },

  onPullDownRefresh() {
    this.loadOverview(true).then(() => wx.stopPullDownRefresh());
  },

  /**
   * @param force true=绕过云函数缓存强制刷新（刷新按钮/下拉刷新用）
   */
  async loadOverview(force) {
    if (force === true) {
      this._priceMinute = null;   // 强刷时价格走势缓存一并失效
      this._priceDaily = null;
      this._priceCrossIdx = null;
      this.setData({ pricePress: null });
    }
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
      }, () => {
        util.addRecent({ code: this.data.code, name: d.name || this.data.name, market: this.data.market });
        if (d.yieldCurve && d.yieldCurve.points && d.yieldCurve.points.length >= 2) {
          this.drawYieldChart();   // setData 回调内绘制，确保 canvas 节点已挂载
        }
        this.loadPriceData();      // 价格走势卡懒加载（默认分时）
        // 行业对比数据未就绪（筛选器数据集未构建）→ 静默预热，下次进入本页即可见
        if (!d.industryRank) {
          util.callService('screener', { page: 1, pageSize: 1 }).catch(() => {});
        }
      });
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

  /* ---------- 跳转：分红再投模拟 ---------- */
  goReinvest() {
    wx.navigateTo({
      url: '/pages/reinvest/reinvest?code=' + this.data.code + '&name=' +
        encodeURIComponent(this.data.name) + '&market=' + this.data.market,
    });
  },

  /* ---------- 跳转：行业对比内同业股票 ---------- */
  goPeer(e) {
    const d = e.currentTarget.dataset;
    wx.navigateTo({
      url: '/pages/stock/stock?code=' + d.code + '&name=' + encodeURIComponent(d.name || ''),
    });
  },

  /* ---------- 价格走势（分时/日K，懒加载 + 页面实例缓存 + 滑动查看） ---------- */
  pricePoints() {
    const d = this.data.priceMode === 'minute' ? this._priceMinute : this._priceDaily;
    return d ? (d.points || null) : null;
  },

  loadPriceData() {
    if (this._priceLoading) return;
    const mode = this.data.priceMode;
    const cached = mode === 'minute' ? this._priceMinute : this._priceDaily;
    if (cached) {
      this.drawPrice();
      return;
    }
    this._priceLoading = true;
    this._priceCv = null;   // priceLoading 切换会卸载重建 canvas
    this.setData({ priceLoading: true });
    util.callService('indexChart', {
      code: this.data.code,
      market: this.data.market,
      mode: mode === 'daily' ? 'history' : 'minute',
      range: '1y',
    }).then((d) => {
      if (mode === 'minute') this._priceMinute = d; else this._priceDaily = d;
      this._priceLoading = false;
      this.setData({ priceLoading: false }, () => this.drawPrice());
    }).catch(() => {
      this._priceLoading = false;
      this.setData({ priceLoading: false });   // 静默：价格走势失败不影响详情页其它功能
    });
  },

  onPriceModeTap(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.priceMode) return;
    this.clearPriceCross();
    this.setData({ priceMode: mode });
    this.loadPriceData();
  },

  /* ---------- 滑动查看：十字光标 + 数据条 ---------- */
  onPriceTouch(e) {
    const geo = this._priceGeo;
    if (!geo) return;
    const pts = this.pricePoints();
    if (!pts || pts.length < 2) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    let idx;
    if (this.data.priceMode === 'minute') {
      // 横轴固定为全天 240 分钟槽位，按触摸位置找最近分钟点
      const slot = Math.round(((t.x - geo.padL) / geo.plotW) * 240);
      idx = util.nearestIndexBySlot(this._priceSlots || [], slot);
    } else {
      idx = Math.round(((t.x - geo.padL) / geo.plotW) * (pts.length - 1));
    }
    idx = Math.max(0, Math.min(pts.length - 1, idx));
    if (this._priceCrossIdx === idx) return;
    this._priceCrossIdx = idx;
    this.drawPrice();

    const p = pts[idx];
    let chgPct, timeLabel;
    if (this.data.priceMode === 'minute') {
      chgPct = ((p.price - this._priceMinute.preClose) / this._priceMinute.preClose) * 100;
      timeLabel = p.t;
    } else {
      const prev = pts[idx - 1] || p;
      chgPct = prev.price > 0 ? (p.price / prev.price - 1) * 100 : 0;
      timeLabel = p.d.slice(5);   // MM-DD
    }
    this.setData({
      pricePress: {
        time: timeLabel,
        price: p.price,
        chgText: (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%',
        chgCls: util.chgClass(chgPct),
      },
    });
  },

  onPriceTouchEnd() {
    this.clearPriceCross();
  },

  clearPriceCross() {
    if (this._priceCrossIdx === undefined || this._priceCrossIdx === null) return;
    this._priceCrossIdx = null;
    this.setData({ pricePress: null });
    this.drawPrice();
  },

  drawPrice(attempt) {
    const at = attempt || 1;
    const paint = (ctx, W, H) => {
      const d = this.data.priceMode === 'minute' ? this._priceMinute : this._priceDaily;
      if (!d) return;
      ctx.clearRect(0, 0, W, H);
      if (this.data.priceMode === 'minute') this.renderPriceMinute(ctx, W, H, d);
      else this.renderPriceDaily(ctx, W, H, d);
      if (this._priceCrossIdx !== undefined && this._priceCrossIdx !== null) this.renderPriceCrosshair(ctx);
    };
    try {
      // 已缓存节点直接重绘（滑动高频调用不走 SelectorQuery）
      if (this._priceCv && this._priceCtx) { paint(this._priceCtx, this._priceW, this._priceH); return; }
      const query = wx.createSelectorQuery();
      query.select('#priceCanvas').fields({ node: true, size: true });
      query.exec((res) => {
        if (!res || !res[0] || !res[0].node || !res[0].width) {
          if (at < 3) setTimeout(() => this.drawPrice(at + 1), 200);   // 节点未挂载稍后重试
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
        this._priceCv = canvas; this._priceCtx = ctx; this._priceW = res[0].width; this._priceH = res[0].height;
        paint(ctx, res[0].width, res[0].height);
      });
    } catch (e) { /* canvas 异常静默 */ }
  },

  renderPriceCrosshair(ctx) {
    const geo = this._priceGeo;
    const pts = this.pricePoints();
    if (!geo || !pts) return;
    const i = Math.min(this._priceCrossIdx, pts.length - 1);
    const frac = this.data.priceMode === 'minute'
      ? (this._priceSlots && this._priceSlots[i] !== undefined ? this._priceSlots[i] / 240 : i / (pts.length - 1))
      : i / (pts.length - 1);
    const x = geo.padL + geo.plotW * frac;
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

  renderPriceMinute(ctx, W, H, d) {
    const points = d.points || [];
    if (points.length < 2) return;
    const padL = 8, padR = 58, padT = 18, padB = 20;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const prices = points.map((p) => p.price);
    let lo = Math.min(d.preClose, Math.min.apply(null, prices));
    let hi = Math.max(d.preClose, Math.max.apply(null, prices));
    const pad = (hi - lo) * 0.08 || hi * 0.002;
    lo -= pad; hi += pad;
    this._priceGeo = { padL, padT, plotW, plotH, lo, hi };

    // 横轴固定代表全天 09:30~15:00（240 分钟槽位含午休）：
    // 盘中只画到最新点位置，右侧留白，时间刻度语义正确
    const slots = points.map((p) => util.minuteSlot(p.t));
    this._priceSlots = slots;
    const n = points.length;
    const xs = slots.map((s) => padL + (plotW * s) / 240);
    const ys = prices.map((p) => padT + plotH * (1 - (p - lo) / (hi - lo)));
    const yBase = padT + plotH * (1 - (d.preClose - lo) / (hi - lo));
    const up = prices[n - 1] >= d.preClose;
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
    ctx.fillText('昨收 ' + d.preClose.toFixed(2), padL + plotW + 5, yBase + 3);
    // 现价标签
    ctx.fillStyle = lineColor;
    ctx.fillText(prices[n - 1].toFixed(2), padL + plotW + 5, ys[n - 1] + 3);

    // 折线 + 面积
    ctx.beginPath();
    xs.forEach((x, i) => { if (i === 0) ctx.moveTo(x, ys[i]); else ctx.lineTo(x, ys[i]); });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, up ? 'rgba(240, 75, 90, 0.16)' : 'rgba(0, 181, 120, 0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.lineTo(xs[n - 1], padT + plotH);
    ctx.lineTo(xs[0], padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // x 轴
    ctx.fillStyle = '#59626d';
    ctx.textAlign = 'left';
    ctx.fillText('09:30', padL, H - 5);
    ctx.textAlign = 'center';
    ctx.fillText('11:30/13:00', padL + plotW / 2, H - 5);
    ctx.textAlign = 'right';
    ctx.fillText('15:00', padL + plotW, H - 5);
  },

  renderPriceDaily(ctx, W, H, d) {
    const points = d.points || [];
    if (points.length < 2) return;
    const padL = 8, padR = 58, padT = 18, padB = 20;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const prices = points.map((p) => p.price);
    let lo = Math.min.apply(null, prices);
    let hi = Math.max.apply(null, prices);
    const pad = (hi - lo) * 0.06 || hi * 0.002;
    lo -= pad; hi += pad;
    this._priceGeo = { padL, padT, plotW, plotH, lo, hi };

    const n = points.length;
    const xs = points.map((_, i) => padL + (plotW * i) / (n - 1));
    const ys = prices.map((p) => padT + plotH * (1 - (p - lo) / (hi - lo)));

    // 网格 3 条 + 右侧价签
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#59626d';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    for (let g = 0; g <= 3; g++) {
      const y = padT + (plotH * g) / 3;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      const val = hi - ((hi - lo) * g) / 3;
      ctx.fillText(val.toFixed(0), padL + plotW + 5, y + 3);
    }

    // 区间涨跌幅（右上）
    const totalPct = ((prices[n - 1] / prices[0] - 1) * 100).toFixed(1);
    ctx.fillStyle = Number(totalPct) >= 0 ? '#f04b5a' : '#00b578';
    ctx.textAlign = 'right';
    ctx.fillText('近1年 ' + (Number(totalPct) >= 0 ? '+' : '') + totalPct + '%', padL + plotW, padT - 6);

    // 金色折线 + 面积
    ctx.beginPath();
    xs.forEach((x, i) => { if (i === 0) ctx.moveTo(x, ys[i]); else ctx.lineTo(x, ys[i]); });
    ctx.strokeStyle = '#d4a94e';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(212, 169, 78, 0.18)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.lineTo(xs[n - 1], padT + plotH);
    ctx.lineTo(xs[0], padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // x 轴 5 个采样标签（MM月）
    ctx.fillStyle = '#59626d';
    for (let g = 0; g < 5; g++) {
      const idx = Math.round((n - 1) * g / 4);
      ctx.textAlign = g === 0 ? 'left' : g === 4 ? 'right' : 'center';
      ctx.fillText(points[idx].d.slice(5, 7) + '月', xs[idx], H - 5);
    }
  },

  /* ---------- 股息率提醒（阈值 + 订阅消息推送） ---------- */
  async loadAlert() {
    try {
      const rules = await util.callFavorites('alertList');
      const mine = rules.find((r) => r.code === this.data.code);
      this.setData({
        alertOn: !!mine,
        alertThreshold: mine ? mine.threshold : null,
      });
    } catch (e) { /* alerts 集合未就绪时静默 */ }
  },

  onBellTap() {
    if (this.data.alertOn) {
      wx.showActionSheet({
        itemList: ['修改提醒阈值（当前 ≥' + this.data.alertThreshold + '%）', '删除提醒'],
        success: (res) => {
          if (res.tapIndex === 0) this.promptAlertThreshold();
          else if (res.tapIndex === 1) this.removeAlert();
        },
      });
    } else {
      this.promptAlertThreshold();
    }
  },

  promptAlertThreshold() {
    wx.showModal({
      title: '股息率提醒',
      content: '股息率达到该值时每日提醒',
      editable: true,
      placeholderText: '如 4.5',
      success: async (res) => {
        if (!res.confirm) return;
        const v = parseFloat(res.content);
        if (!(v > 0 && v < 100)) {
          wx.showToast({ title: '请输入 0~100 的阈值', icon: 'none' });
          return;
        }
        // 订阅授权（配置模板后生效；拒绝也不影响规则保存，走首页横幅提醒）
        if (config.TEMPLATE_ID_REMIND) {
          try { await wx.requestSubscribeMessage({ tmplIds: [config.TEMPLATE_ID_REMIND] }); } catch (e) { /* 忽略 */ }
        }
        try {
          await util.callFavorites('alertAdd', {
            code: this.data.code,
            name: this.data.name,
            market: this.data.market,
            threshold: v,
          });
          wx.showToast({ title: '已设提醒 ≥' + v + '%', icon: 'success' });
          this.loadAlert();
        } catch (e) {
          wx.showToast({ title: e.message, icon: 'none' });
        }
      },
    });
  },

  async removeAlert() {
    const res = await wx.showModal({ title: '删除提醒', content: '确定删除该股的股息率提醒？' });
    if (!res.confirm) return;
    try {
      await util.callFavorites('alertRemove', { code: this.data.code });
      wx.showToast({ title: '已删除', icon: 'success' });
      this.loadAlert();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  /* ---------- 股息率曲线（Canvas 2D） ---------- */
  drawYieldChart() {
    // 节点可能因 loading 切换尚未挂载，最多重试 3 次
    this.queryYieldCanvas(1);
  },

  queryYieldCanvas(attempt) {
    try {
      const query = wx.createSelectorQuery();
      query.select('#yieldCanvas').fields({ node: true, size: true });
      query.exec((res) => {
        if (!res || !res[0] || !res[0].node || !res[0].width) {
          if (attempt < 3) setTimeout(() => this.queryYieldCanvas(attempt + 1), 200);
          return;
        }
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
