/**
 * entitlement.js —— 用户权益与广告服务层（二期预留，当前默认关闭）
 *
 * 【开通前置条件（个人主体）】
 *   1. 累计独立访客（UV）≥ 1000 后，在 mp.weixin.qq.com → 流量主 自助开通（免费）
 *   2. 开通后创建「激励式视频广告」广告位，把 adUnitId 填入下方 AD_CONFIG
 *   3. 个人主体不能使用微信支付 —— 看广告解锁是唯一合规变现路径
 *
 * 【使用方式（二期启用时）】
 *   const ent = require('../../utils/entitlement');
 *   if (await ent.isUnlocked()) { 展示高级功能 }
 *   else { ent.maybeShowRewardedAd(() => { 解锁成功回调 }); }
 *
 * 【解锁状态存储】双层：本地 storage（立即生效）+ 云端 users.entitlement（跨设备恢复）。
 *   对既有数据零影响：users 集合为新增，_openid 自动隔离。
 */

const AD_CONFIG = {
  enabled: false,          // ← 流量主开通并拿到广告位ID后改为 true
  adUnitId: '',            // ← 激励式视频广告位 ID（adunit-开头）
  unlockLabel: '高级功能',  // 被解锁功能的展示名（提示文案用）
};

const STORAGE_KEY = 'entitlement_unlocked';

/** 本地是否已解锁 */
function isUnlockedLocal() {
  try { return wx.getStorageSync(STORAGE_KEY) === true; } catch (e) { return false; }
}

/**
 * 综合解锁状态：本地 || 云端档案
 * 云端读取失败时降级用本地（不阻塞功能）
 */
async function isUnlocked() {
  if (isUnlockedLocal()) return true;
  if (!AD_CONFIG.enabled) return true;   // 广告体系未启用 = 所有功能全量开放
  try {
    const profile = await wx.cloud.callFunction({
      name: 'favorites',
      data: { action: 'userProfile' },
    }).then((r) => (r.result && r.result.success ? r.result.data : null));
    return !!(profile && profile.entitlement && profile.entitlement.adUnlocked);
  } catch (e) {
    return false;
  }
}

/** 写入解锁状态（本地 + 云端，云端失败静默——下次打开会再同步） */
async function markUnlocked() {
  try { wx.setStorageSync(STORAGE_KEY, true); } catch (e) { /* 存储异常忽略 */ }
  try {
    await wx.cloud.callFunction({
      name: 'favorites',
      data: { action: 'userSet', patch: { entitlement: { adUnlocked: true, unlockedAt: Date.now() } } },
    });
  } catch (e) { /* 静默，本地已生效 */ }
}

/**
 * 展示激励式广告并回调解锁
 * @param onReward 解锁成功回调
 * @param onClose  未完成观看关闭回调（可提示重试）
 */
function maybeShowRewardedAd(onReward, onClose) {
  if (!AD_CONFIG.enabled || !AD_CONFIG.adUnitId) {
    wx.showToast({ title: '广告功能尚未启用', icon: 'none' });
    if (onClose) onClose();
    return;
  }
  const ad = wx.createRewardedVideoAd({ adUnitId: AD_CONFIG.adUnitId });
  const onCloseHandler = (res) => {
    ad.offClose(onCloseHandler);
    if (res && res.isEnded) {
      markUnlocked().then(() => { if (onReward) onReward(); });
    } else if (onClose) {
      onClose();
    }
  };
  ad.onClose(onCloseHandler);
  ad.onError(() => {
    wx.showToast({ title: '广告加载失败，请稍后再试', icon: 'none' });
    if (onClose) onClose();
  });
  ad.show().catch(() => {
    ad.load().then(() => ad.show()).catch(() => {
      wx.showToast({ title: '广告加载失败，请稍后再试', icon: 'none' });
      if (onClose) onClose();
    });
  });
}

module.exports = {
  AD_CONFIG,
  isUnlocked,
  isUnlockedLocal,
  markUnlocked,
  maybeShowRewardedAd,
};
