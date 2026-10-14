// app.js —— 云开发初始化
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
  },
  globalData: {
    userInfo: null,
  },
});
