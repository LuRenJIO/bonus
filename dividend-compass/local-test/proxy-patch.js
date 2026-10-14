/**
 * 本地测试专用：让 Node 内置 https 模块走 HTTP 代理（沙箱/企业网络环境）
 * 生产云函数（腾讯云）直连，无需此文件。
 * 原理：自定义 https.Agent，通过 HTTP CONNECT 隧道建立 TLS 连接。
 */
const https = require('https');
const http = require('http');
const tls = require('tls');

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.http_proxy;

if (PROXY) {
  const purl = new URL(PROXY);

  class ProxyTunnelAgent extends https.Agent {
    createConnection(options, callback) {
      const host = options.host || options.hostname;
      const port = options.port || 443;
      const connectReq = http.request({
        host: purl.hostname,
        port: purl.port || 80,
        method: 'CONNECT',
        path: host + ':' + port,
      });
      connectReq.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          callback(new Error('proxy CONNECT failed: ' + res.statusCode));
          socket.destroy();
          return;
        }
        const tlsSocket = tls.connect(
          { socket, servername: host, rejectUnauthorized: false },
          () => callback(null, tlsSocket)
        );
        tlsSocket.once('error', (e) => callback(e));
      });
      connectReq.once('error', (e) => callback(e));
      connectReq.end();
    }
  }

  const agent = new ProxyTunnelAgent();
  const origGet = https.get.bind(https);
  const origRequest = https.request.bind(https);

  function injectAgent(args) {
    // https.get(url, options, callback) 或 https.get(options, callback)
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      if (args[1] && typeof args[1] === 'object') args[1].agent = agent;
      else args.splice(1, 0, { agent });
    } else if (args[0] && typeof args[0] === 'object') {
      args[0].agent = args[0].agent || agent;
    }
    return args;
  }

  https.get = function (...args) { return origGet(...injectAgent(args)); };
  https.request = function (...args) { return origRequest(...injectAgent(args)); };
  module.exports = { enabled: true, proxy: PROXY };
} else {
  module.exports = { enabled: false };
}
