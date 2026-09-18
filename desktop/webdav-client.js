/**
 * CourseForge WebDAV 客户端（主进程用，Node http/https 注入可测）
 *
 * 为什么放主进程：网页版做 WebDAV 要看服务器脸色（CORS 头），而桌面端
 * 的主进程没有跨域限制 —— 用户自备的坚果云 / Nextcloud / 群晖，
 * 十有八九不会为一个小课表应用开 CORS。桌面端是云同步的正门。
 *
 * 为什么不用现成 WebDAV 库：协议只用到 PUT/GET 两个动词 + Basic 认证 +
 * 跟随 3xx 重定向。一个 WebDAV 库的依赖面远大于这三个需求
 * （零运行时依赖是本项目的硬约束，桌面端也不例外）。
 *
 * 安全边界：
 *  - 超时 30 秒 + 响应上限 10MB：防呆服务器挂住或返回天文数字。
 *  - 只跟随 http/https 的重定向，最多 3 次；别的协议当失败处理。
 *  - 函数不落盘、不写日志（入参含密码），凭据的持久化在 cred-store。
 */
'use strict';

/** 默认 30 秒：WebDAV 服务器多在内网/小水管，久到 30 秒基本就是挂了 */
const TIMEOUT_MS = 30000;
/** 响应体上限 10MB：课表备份 JSON 正常几十 KB，超过这个数必有诈 */
const MAX_BODY = 10 * 1024 * 1024;
/** 最多跟随 3 次重定向：再多就是配置错了，别绕圈 */
const MAX_REDIRECTS = 3;

/**
 * @param {object} deps 测试时注入 http/https 桩；运行时传 Node 原生模块
 */
function createWebdavClient(deps) {
  const http = deps && deps.http;
  const https = deps && deps.https;

  /** Basic 头：Node 侧用 Buffer，UTF-8 用户名也安全 */
  function authHeader(username, password) {
    return 'Basic ' + Buffer.from(String(username || '') + ':' + String(password || ''), 'utf8').toString('base64');
  }

  /**
   * 发一次请求（不含重定向逻辑）。
   * @returns {Promise<{status:number, headers:object, body:Buffer|string}>}
   */
  function once(method, urlStr, headers, body) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(urlStr);
      } catch (e) {
        reject(new Error('URL 无法解析：' + urlStr));
        return;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        reject(new Error('只支持 http/https'));
        return;
      }
      const mod = u.protocol === 'https:' ? https : http;
      if (typeof mod.request !== 'function') {
        reject(new Error('传输层不可用'));
        return;
      }
      const req = mod.request(u, {
        method: method,
        headers: headers
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy(new Error('响应超过 10MB，疑似配置错误'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers || {}, body: Buffer.concat(chunks) }));
        res.on('error', (e) => reject(e));
      });
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('请求超时（30 秒无响应）')));
      req.on('error', (e) => reject(e));
      if (body != null) req.write(body);
      req.end();
    });
  }

  /**
   * WebDAV 请求（含重定向）。返回统一形状，调用方不需要再分辨网络错误/HTTP 错误：
   *   { ok:boolean, status:number, body?:string, lastModified?:string, message:string }
   */
  async function request(method, urlStr, username, password, body) {
    let current = String(urlStr || '');
    const headers = {
      Authorization: authHeader(username, password)
    };
    if (body != null) headers['Content-Type'] = 'application/json';

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res;
      try {
        res = await once(method, current, headers, body);
      } catch (e) {
        return { ok: false, status: 0, message: (e && e.message) || '网络请求失败' };
      }
      // 3xx：WebDAV 服务器（尤其坚果云）爱把请求甩到别的地址
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop === MAX_REDIRECTS) {
          return { ok: false, status: res.status, message: '重定向次数过多（' + res.status + '），检查服务器地址' };
        }
        current = new URL(res.headers.location, current).href;
        continue;
      }
      const text = res.body.toString('utf8');
      const ok = (method === 'PUT')
        ? (res.status >= 200 && res.status < 300)
        : res.status === 200;
      return {
        ok: ok,
        status: res.status,
        body: ok ? text : undefined,
        lastModified: res.headers['last-modified'] || '',
        message: ok ? '' : httpMessage(res.status)
      };
    }
    return { ok: false, status: 0, message: '未知错误' };
  }

  /** 常见状态码的人话：弹 toast 用的，别让用户对着 401 猜 */
  function httpMessage(status) {
    if (status === 401 || status === 403) return '认证失败：检查用户名与应用密码';
    if (status === 404) return '云端还没有备份文件（先上传一次）';
    if (status === 409) return '服务器拒绝：目标目录不存在，多数 WebDAV 会自动创建，重试一次';
    if (status >= 500) return '服务器内部错误（' + status + '）';
    return '请求失败（HTTP ' + status + '）';
  }

  return {
    TIMEOUT_MS: TIMEOUT_MS,
    MAX_BODY: MAX_BODY,
    MAX_REDIRECTS: MAX_REDIRECTS,
    authHeader: authHeader,
    upload: (url, username, password, body) => request('PUT', url, username, password, body),
    download: (url, username, password) => request('GET', url, username, password, null)
  };
}

module.exports = { createWebdavClient };
