// components/ui-icon/ui-icon.js —— 线性图标组件：内联 SVG data-URI + CSS mask
// 视觉=iconfont 风格（1.5px 描边），实现=零字体文件零网络请求（比 iconfont 加载更快）
Component({
  properties: {
    name: { type: String, value: '' },        // 图标名：calendar/coin/funnel/gold/search/bell/chart/book/close/arrow/plus/star
    size: { type: Number, value: 40 },        // rpx
    color: { type: String, value: '' },       // 默认金 var(--gold-hi)
  },
});
