// app.js —— 云开发初始化 + 版本更新提示
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低（需 2.2.3+），无法使用云能力');
      return;
    }
    // 不指定 env 时使用默认环境；如需指定：wx.cloud.init({ env: '环境ID' })
    wx.cloud.init({
      traceUser: true,
    });
    this.checkUpdate();
  },

  /** 发新版后引导用户重启更新，避免长期停留在旧包 */
  checkUpdate() {
    if (!wx.getUpdateManager) return;
    const um = wx.getUpdateManager();
    um.onUpdateReady(() => {
      wx.showModal({
        title: '更新提示',
        content: '新版本已经准备好，是否重启应用？',
        success: (res) => {
          if (res.confirm) um.applyUpdate();
        },
      });
    });
    um.onUpdateFailed(() => {
      wx.showToast({ title: '新版本下载失败，请删除小程序后重新搜索打开', icon: 'none' });
    });
  },

  globalData: {
    userInfo: null,
  },
});
