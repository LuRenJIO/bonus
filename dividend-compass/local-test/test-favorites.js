/**
 * favorites 云函数本地测试（无需真实云环境）
 * 运行：node local-test/test-favorites.js
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

// ---- 拦截 wx-server-sdk，替换为本地内存版 stub ----
const DATA_FILE = path.join(__dirname, '.favorites-test-data.json');
const load = () => (fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : []);
const save = (rows) => fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2));

const stubSdk = {
  init() {},
  DYNAMIC_CURRENT_ENV: Symbol('env'),
  database: () => ({
    createCollection: async () => {},
    serverDate: () => new Date(),
    collection: (name) => {
      const api = {
        orderBy: () => api,
        limit: () => api,
        get: async () => ({ data: load() }),
        add: async ({ data }) => {
          const rows = load();
          const id = 'test_' + Date.now();
          rows.unshift(Object.assign({ _id: id, _openid: 'test-user' }, data, { addedAt: new Date() }));
          save(rows);
          return { _id: id };
        },
        where: (cond) => ({
          remove: async () => {
            const rows = load();
            const left = rows.filter((r) => r.code !== cond.code);
            save(left);
            return { stats: { removed: rows.length - left.length } };
          },
          count: async () => ({ total: load().filter((r) => r.code === cond.code).length }),
        }),
      };
      return api;
    },
  }),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return stubSdk;
  return originalLoad.apply(this, arguments);
};

// ---- 执行测试 ----
const fn = require('../cloudfunctions/favorites/index.js');

(async () => {
  const cases = [
    { name: 'list-empty', event: { action: 'list' }, expect: (r) => r.success && r.data.length === 0 },
    { name: 'add-600519', event: { action: 'add', code: '600519', name: '贵州茅台' }, expect: (r) => r.success && !r.data.duplicated },
    { name: 'add-dup', event: { action: 'add', code: '600519', name: '贵州茅台' }, expect: (r) => r.success && r.data.duplicated === true },
    { name: 'list-1', event: { action: 'list' }, expect: (r) => r.success && r.data.length === 1 && r.data[0].code === '600519' },
    { name: 'remove', event: { action: 'remove', code: '600519' }, expect: (r) => r.success },
    { name: 'list-empty-2', event: { action: 'list' }, expect: (r) => r.success && r.data.length === 0 },
  ];
  let pass = 0, fail = 0;
  for (const c of cases) {
    try {
      const r = await fn.main(c.event);
      const okCase = c.expect(r);
      console.log((okCase ? 'PASS' : 'FAIL') + ' [' + c.name + '] ' + JSON.stringify(r).slice(0, 120));
      okCase ? pass++ : fail++;
    } catch (e) {
      console.log('ERROR [' + c.name + '] ' + e.message);
      fail++;
    }
  }
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  console.log('\nfavorites 测试: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
