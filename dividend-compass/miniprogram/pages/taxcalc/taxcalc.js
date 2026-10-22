// pages/taxcalc/taxcalc.js —— 红利税计算器：持股期限 → 差别化税率 → 税后到手
// 规则参考：个人投资者转让上市公司股票，持股超1年红利免税；1个月至1年按10%；1个月以内按20%
// 税额在卖出股票时按持有期限一次性补缴（差额）。本工具为估算，以税务机关认定为准。
Page({
  data: {
    dividend: '',        // 分红总额（税前，元）
    buyDate: '',         // 买入日期
    sellDate: '',        // 计划卖出日期（默认今天）
    today: '',
    maxSell: '',
    result: null,        // {days, rateLabel, rate, tax, net, heldOneYear, daysToOneYear, saveTax}
    error: '',
  },

  onLoad() {
    const d = new Date();
    const fmt = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    this.setData({ today: fmt(d), maxSell: fmt(d), sellDate: fmt(d) });
    // 从记账页带入今年已收分红
    const prefill = wx.getStorageSync('tax_prefill');
    if (prefill > 0) {
      this.setData({ dividend: String(prefill) });
      wx.removeStorageSync('tax_prefill');
    }
  },

  onDividendInput(e) { this.setData({ dividend: e.detail.value }); },
  onBuyDate(e) { this.setData({ buyDate: e.detail.value }); },
  onSellDate(e) { this.setData({ sellDate: e.detail.value }); },

  onCalc() {
    const dividend = parseFloat(this.data.dividend);
    const buy = this.data.buyDate;
    const sell = this.data.sellDate;
    if (!(dividend > 0)) { this.setData({ error: '请输入分红金额' }); return; }
    if (!buy || !sell) { this.setData({ error: '请选择买入和卖出日期' }); return; }
    const days = Math.floor((new Date(sell + 'T00:00:00') - new Date(buy + 'T00:00:00')) / 86400000);
    if (days < 0) { this.setData({ error: '卖出日期不能早于买入日期' }); return; }

    // 差别化税率（个人从公开转让市场取得上市公司股票）
    let rate, rateLabel;
    if (days > 365) { rate = 0; rateLabel = '持股超1年 · 免征'; }
    else if (days >= 30) { rate = 0.1; rateLabel = '持股1个月至1年 · 10%'; }
    else { rate = 0.2; rateLabel = '持股1个月以内 · 20%'; }

    const tax = +(dividend * rate).toFixed(2);
    const net = +(dividend - tax).toFixed(2);
    // 若持有至满1年（从买入日起第366天卖出）
    const oneYearDate = new Date(new Date(buy + 'T00:00:00').getTime() + 366 * 86400000);
    const fmt = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    const heldOneYear = days > 365 ? null : {
      date: fmt(oneYearDate),
      daysLeft: 366 - days,
      saveTax: +tax.toFixed(2),
    };
    this.setData({
      error: '',
      result: { days, rateLabel, rate, tax, net, heldOneYear },
    });
  },
});
