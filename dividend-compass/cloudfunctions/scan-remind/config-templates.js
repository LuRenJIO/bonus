/**
 * 订阅消息模板配置 —— 使用前必填！
 *
 * 申请步骤：
 *   1. 打开 mp.weixin.qq.com → 功能 → 订阅消息 → 公共模板库
 *   2. 搜索挑选两个"一次性订阅"模板（推荐含 [事项/内容]+[时间] 字段的通用"服务通知/提醒"类模板）
 *      - 模板1：股息率机会提醒（内容字段建议选 thing 类型）
 *      - 模板2：分红除息到账提醒（内容字段建议选 thing 类型）
 *   3. 到「我的模板」复制各自的 模板ID（tmpl- 开头），分别填到下面
 *   4. 记下模板详情里的字段代号（如 thing1、time2），若与下方 FIELD_MAP 不一致请同步修改
 *   5. 同步修改小程序端 miniprogram/config.js 中相同的两个模板ID
 *
 * 注意：两个 ID 都留空也能正常运行 —— 此时推送静默降级为「首页红点横幅」提醒。
 */
module.exports = {
  TEMPLATE_ID_REMIND: '',   // 股息率机会提醒 模板ID（tmpl-开头）
  TEMPLATE_ID_EXDIV: '',    // 分红除息到账提醒 模板ID（tmpl-开头）

  // 字段代号映射（以你实际挑选的模板字段为准）
  FIELD_MAP: {
    REMIND: { content: 'thing1', time: 'time2' },   // 机会提醒：内容字段 + 时间字段
    EXDIV: { content: 'thing1', time: 'time2' },    // 除息到账：内容字段 + 时间字段
  },
};
