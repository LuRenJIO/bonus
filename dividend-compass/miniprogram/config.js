/**
 * 订阅消息模板ID（与 cloudfunctions/scan-remind/config-templates.js 保持一致）
 *
 * 申请路径：mp.weixin.qq.com → 功能 → 订阅消息 → 公共模板库 → 挑选一次性订阅模板
 * 两个都留空时：定时推送静默跳过，首页红点横幅提醒始终可用（推荐先留空体验）。
 */
module.exports = {
  TEMPLATE_ID_REMIND: '',   // 股息率机会提醒 模板ID（tmpl-开头）
  TEMPLATE_ID_EXDIV: '',    // 分红除息到账提醒 模板ID（tmpl-开头）
};
