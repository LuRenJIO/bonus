/**
 * 云函数：favorites —— 自选股收藏（云数据库，按 _openid 自动隔离）
 *
 * action:
 *   list                       我的自选列表（含缓存行情快照）
 *   add    {code, name, market?}     添加自选
 *   remove {code}               移除自选
 *
 * 部署说明：依赖 wx-server-sdk，上传时选择"上传并部署：云端安装依赖"。
 * 首次调用会自动创建 favorites 集合。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COL = 'favorites';

async function ensureCollection() {
  try {
    await db.createCollection(COL);
  } catch (e) { /* 已存在则忽略 */ }
}

function ok(data) { return { success: true, data }; }
function fail(msg) { return { success: false, error: msg }; }

async function handleList() {
  try {
    const res = await db.collection(COL)
      .orderBy('addedAt', 'desc')
      .limit(100)
      .get();
    return ok(res.data || []);
  } catch (e) {
    // 集合不存在
    if (String(e.errCode) === '-502005' || /not exist|不存在/.test(e.errMsg || '')) {
      await ensureCollection();
      return ok([]);
    }
    throw e;
  }
}

async function handleAdd(event) {
  const code = String(event.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('股票代码格式错误');
  await ensureCollection();

  // 去重：同一 openid + code 只保留一条
  const exist = await db.collection(COL).where({ code }).count();
  if (exist.total > 0) return ok({ duplicated: true });

  const item = {
    code,
    name: event.name || '',
    market: event.market || (/^(6|9)/.test(code) ? 'SH' : 'SZ'),
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

exports.main = async (event = {}) => {
  try {
    switch (event.action) {
      case 'list': return await handleList(event);
      case 'add': return await handleAdd(event);
      case 'remove': return await handleRemove(event);
      default: return fail('未知 action: ' + event.action);
    }
  } catch (e) {
    return fail(e.errMsg || e.message || '操作失败');
  }
};
