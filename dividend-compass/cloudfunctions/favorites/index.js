/**
 * 云函数：favorites —— 自选股 + 收息记账持仓（云数据库，按 _openid 自动隔离）
 *
 * action:
 *   list                            我的自选列表
 *   add       {code, name, market?}      添加自选
 *   remove    {code}                      移除自选
 *   holdingList                        我的持仓列表
 *   holdingAdd {code, name, market?, shares, cost?}  添加/覆盖持仓
 *   holdingRemove {code}               移除持仓
 *   alertList                          我的股息率提醒规则列表
 *   alertAdd {code, name, market?, threshold}   添加/覆盖提醒规则
 *   alertRemove {code}                 移除提醒规则
 *
 * 部署说明：依赖 wx-server-sdk，上传时选择"上传并部署：云端安装依赖"。
 * 首次调用会自动创建 favorites / holdings / alerts 集合。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COL = 'favorites';
const COL_H = 'holdings';
const COL_A = 'alerts';
const COL_U = 'users';

async function ensureCollection(col) {
  try {
    await db.createCollection(col);
  } catch (e) { /* 已存在则忽略 */ }
}

function ok(data) { return { success: true, data }; }
function fail(msg) { return { success: false, error: msg }; }

async function handleList() {
  try {
    const res = await db.collection(COL)
      .limit(100)
      .get();
    // 用户自定义排序：order 升序优先；无 order 的旧数据按添加时间倒序兜底
    const rows = (res.data || []).slice().sort((a, b) => {
      const oa = typeof a.order === 'number' ? a.order : null;
      const ob = typeof b.order === 'number' ? b.order : null;
      if (oa !== null && ob !== null) return oa - ob;
      if (oa !== null) return -1;
      if (ob !== null) return 1;
      return (new Date(b.addedAt).getTime() || 0) - (new Date(a.addedAt).getTime() || 0);
    });
    return ok(rows);
  } catch (e) {
    // 集合不存在
    if (String(e.errCode) === '-502005' || /not exist|不存在/.test(e.errMsg || '')) {
      await ensureCollection(COL);
      return ok([]);
    }
    throw e;
  }
}

async function handleAdd(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('股票代码格式错误');
  await ensureCollection(COL);

  // 去重：同一 openid + code 只保留一条
  const exist = await db.collection(COL).where({ code }).count();
  if (exist.total > 0) return ok({ duplicated: true });

  const item = {
    code,
    name: event.name || '',
    market: event.market || (/^(6|9)/.test(code) ? 'SH' : 'SZ'),
    order: -Date.now(),   // 新加自选排最前（用户可通过 reorder 自定义）
    addedAt: db.serverDate(),
  };
  const res = await db.collection(COL).add({ data: item });
  return ok({ id: res._id });
}

async function handleRemove(event) {
  const code = String(event.code || '').trim();
  if (!code) return fail('缺少股票代码');
  await db.collection(COL).where({ code }).remove();
  return ok({ removed: true });
}

/** 用户自定义排序：按传入的 code 顺序写回 order 序号（0,1,2...） */
async function handleReorder(event) {
  const codes = Array.isArray(event.codes) ? event.codes.map((c) => String(c).trim()).filter(Boolean) : [];
  if (!codes.length) return fail('缺少排序数据');
  if (codes.length > 100) return fail('排序数量超出限制');
  await Promise.all(codes.map((code, i) =>
    db.collection(COL).where({ code }).update({ data: { order: i } })
  ));
  return ok({ reordered: codes.length });
}

/* ---------------- 持仓（收息记账） ---------------- */
async function handleHoldingList() {
  try {
    const res = await db.collection(COL_H)
      .orderBy('addedAt', 'desc')
      .limit(50)
      .get();
    return ok(res.data || []);
  } catch (e) {
    if (String(e.errCode) === '-502005' || /not exist|不存在/.test(e.errMsg || '')) {
      await ensureCollection(COL_H);
      return ok([]);
    }
    throw e;
  }
}

async function handleHoldingAdd(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('股票代码格式错误');
  const shares = Number(event.shares);
  if (!(shares > 0)) return fail('持股数量需大于0');
  const cost = Number(event.cost);
  const costVal = (cost > 0) ? cost : null;
  await ensureCollection(COL_H);

  const item = {
    code,
    name: event.name || '',
    market: event.market || (/^(6|9)/.test(code) ? 'SH' : 'SZ'),
    shares,
    cost: costVal,
    addedAt: db.serverDate(),
  };
  // 同股覆盖：先删后加（同一 openid 下 code 唯一）
  await db.collection(COL_H).where({ code }).remove();
  const res = await db.collection(COL_H).add({ data: item });
  return ok({ id: res._id });
}

async function handleHoldingRemove(event) {
  const code = String(event.code || '').trim();
  if (!code) return fail('缺少股票代码');
  await db.collection(COL_H).where({ code }).remove();
  return ok({ removed: true });
}

/* ---------------- 股息率提醒规则 ---------------- */
async function handleAlertList() {
  try {
    const res = await db.collection(COL_A)
      .orderBy('addedAt', 'desc')
      .limit(50)
      .get();
    return ok(res.data || []);
  } catch (e) {
    if (String(e.errCode) === '-502005' || /not exist|不存在/.test(e.errMsg || '')) {
      await ensureCollection(COL_A);
      return ok([]);
    }
    throw e;
  }
}

async function handleAlertAdd(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('股票代码格式错误');
  const threshold = Number(event.threshold);
  if (!(threshold > 0 && threshold < 100)) return fail('阈值需在 0~100 之间');
  await ensureCollection(COL_A);

  // 同股覆盖：先删后加
  await db.collection(COL_A).where({ code }).remove();
  const res = await db.collection(COL_A).add({
    data: {
      code,
      name: event.name || '',
      market: event.market || (/^(6|9)/.test(code) ? 'SH' : 'SZ'),
      threshold: +threshold.toFixed(2),
      addedAt: db.serverDate(),
    },
  });
  return ok({ id: res._id });
}

async function handleAlertRemove(event) {
  const code = String(event.code || '').trim();
  if (!code) return fail('缺少股票代码');
  await db.collection(COL_A).where({ code }).remove();
  return ok({ removed: true });
}

/* ---------------- 用户档案（users 集合，权益/偏好预留） ---------------- */

/** 获取或初始化当前用户档案（首次调用自动创建） */
async function handleUserProfile() {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return fail('无法获取用户身份');
  try {
    const res = await db.collection(COL_U).where({ _openid: openid }).limit(1).get();
    if (res.data && res.data.length) return ok(res.data[0]);
    // 首次创建：_openid 需在服务端手动写入（服务端 add 不自动注入）
    await ensureCollection(COL_U);
    const doc = {
      _openid: openid,
      createdAt: db.serverDate(),
      // 权益预留：广告解锁等（二期流量主开通后启用）
      entitlement: { adUnlocked: false, unlockedAt: null },
      // 偏好设置预留
      settings: {},
    };
    const added = await db.collection(COL_U).add({ data: doc });
    return ok(Object.assign({ _id: added._id }, doc));
  } catch (e) {
    if (String(e.errCode) === '-502005' || /not exist|不存在/.test(e.errMsg || '')) {
      await ensureCollection(COL_U);
      return ok(null);
    }
    throw e;
  }
}

/** 更新当前用户档案字段（合并写入，用于权益/设置） */
async function handleUserSet(event) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return fail('无法获取用户身份');
  const patch = event.patch && typeof event.patch === 'object' ? event.patch : null;
  if (!patch || !Object.keys(patch).length) return fail('缺少 patch 字段');
  await ensureCollection(COL_U);
  const exist = await db.collection(COL_U).where({ _openid: openid }).limit(1).get();
  if (!exist.data || !exist.data.length) {
    const doc = Object.assign({
      _openid: openid,
      createdAt: db.serverDate(),
      entitlement: { adUnlocked: false, unlockedAt: null },
      settings: {},
    }, patch);
    const added = await db.collection(COL_U).add({ data: doc });
    return ok({ _id: added._id });
  }
  await db.collection(COL_U).doc(exist.data[0]._id).update({ data: patch });
  return ok({ updated: true });
}

exports.main = async (event = {}) => {
  try {
    switch (event.action) {
      case 'list': return await handleList(event);
      case 'add': return await handleAdd(event);
      case 'remove': return await handleRemove(event);
      case 'reorder': return await handleReorder(event);
      case 'holdingList': return await handleHoldingList(event);
      case 'holdingAdd': return await handleHoldingAdd(event);
      case 'holdingRemove': return await handleHoldingRemove(event);
      case 'alertList': return await handleAlertList(event);
      case 'alertAdd': return await handleAlertAdd(event);
      case 'alertRemove': return await handleAlertRemove(event);
      case 'userProfile': return await handleUserProfile(event);
      case 'userSet': return await handleUserSet(event);
      default: return fail('未知 action: ' + event.action);
    }
  } catch (e) {
    return fail(e.errMsg || e.message || '操作失败');
  }
};
