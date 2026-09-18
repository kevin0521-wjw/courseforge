/**
 * CourseForge 检查更新（主进程用，Node http/https 注入可测）
 *
 * 为什么自研而不引 electron-updater：
 *  - 零运行时依赖是本项目的硬约束（桌面端也不例外）；
 *  - 更关键的是：安装包**未签名**的现状下，静默下载并启动安装器必被 Windows
 *    SmartScreen 拦下 —— 「自动更新」会变成「自动制造打不开的安装包」。
 *    所以这里只做两件事：查出新版本 + 给出官方下载页链接，装不装由用户决定。
 *
 * 版本源：GitHub Releases 的 releases/latest 接口（不需要自建更新服务器）。
 * 404（仓库还没发布过版本）是**预期态**，返回结构化结论而不是当错误糊弄。
 *
 * 安全边界：
 *  - API 返回的 html_url 不盲信：只接受 https://github.com/ 开头的链接，
 *    白名单外一律回落到固定 releases 页 —— 防止一个被篡改的响应把用户引去别处；
 *  - 30 秒超时 + 1MB 响应上限（release JSON 正常几十 KB）；
 *  - 不落盘、不写日志（本模块不接触任何凭据）。
 */
'use strict';

const TIMEOUT_MS = 30000;
const MAX_BODY = 1024 * 1024;
/** 最多跟随 3 次重定向：与 WebDAV 客户端同一约定 */
const MAX_REDIRECTS = 3;

/** 固定的发布页：html_url 校验不过时的兜底，永远指向本仓库 releases */
const RELEASES_PAGE = 'https://github.com/kevin0521-wjw/courseforge/releases/latest';

/**
 * 比较两个 semver 三段版本号：返回 1 / 0 / -1；解析不了返回 null。
 * 只接受「可选 v 前缀 + 数字.数字.数字」，其余（beta 后缀等）一律算解析失败 ——
 * 比不出结果时宁可让用户看到「版本号解析失败」，也不能误报「已是最新」。
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** release tag → 版本号（剥 v 前缀）；空tag原样返回交给比较器报错 */
function normalizeTag(tag) {
  return String(tag == null ? '' : tag).trim();
}

/**
 * @param {object} deps 测试时注入 http/https 桩；运行时传 Node 原生模块
 */
function createUpdateChecker(deps) {
  const http = deps && deps.http;
  const https = deps && deps.https;

  function fetchOnce(urlStr) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(urlStr);
      } catch (e) {
        reject(new Error('URL 无法解析'));
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
        method: 'GET',
        headers: {
          // GitHub API 缺 User-Agent 直接 403；Accept 指定稳定版 JSON
          'User-Agent': 'CourseForge-Desktop',
          Accept: 'application/vnd.github+json'
        }
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy(new Error('响应超过 1MB，疑似配置错误'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({
          status: res.statusCode,
          location: res.headers.location || '',
          body: Buffer.concat(chunks).toString('utf8')
        }));
        res.on('error', (e) => reject(e));
      });
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('请求超时（30 秒无响应）')));
      req.on('error', (e) => reject(e));
      req.end();
    });
  }

  /** GET（含 3xx 跟随，最多 3 次）：端到端实测 api.github.com 的 releases/latest 在部分网络下会 302 */
  async function fetchText(urlStr) {
    let current = String(urlStr);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchOnce(current);
      if (res.status >= 300 && res.status < 400 && res.location) {
        if (hop === MAX_REDIRECTS) {
          throw new Error('重定向次数过多（HTTP ' + res.status + '），检查网络环境');
        }
        current = new URL(res.location, current).href;
        continue;
      }
      return { status: res.status, body: res.body };
    }
    throw new Error('重定向次数过多');
  }

  /**
   * 检查更新。返回统一形状：
   *   { ok:boolean, status:'available'|'latest'|'norelease'|'network'|'badtag'|'badresponse'|'error',
   *     current, latest?, downloadUrl?, message }
   */
  async function check(latestApiUrl, currentVersion) {
    const current = String(currentVersion == null ? '' : currentVersion).trim();
    let res;
    try {
      res = await fetchText(latestApiUrl);
    } catch (e) {
      return { ok: false, status: 'network', current, message: '网络请求失败：' + String((e && e.message) || e) };
    }
    if (res.status === 404) {
      return { ok: true, status: 'norelease', current, message: '还没有发布过版本，暂时无需检查' };
    }
    if (res.status === 403 || res.status === 429) {
      return { ok: false, status: 'error', current, message: 'GitHub API 限流了（每小时有配额），过一会儿再试' };
    }
    if (res.status !== 200) {
      return { ok: false, status: 'error', current, message: '检查失败（HTTP ' + res.status + '）' };
    }
    let data;
    try {
      data = JSON.parse(res.body);
    } catch (e) {
      return { ok: false, status: 'badresponse', current, message: '响应不是合法 JSON，稍后再试' };
    }
    const latest = normalizeTag(data && data.tag_name);
    const cmp = compareVersions(latest, current);
    if (cmp === null) {
      return { ok: false, status: 'badtag', current, latest, message: '版本号解析失败（tag：' + (latest || '空') + '）' };
    }
    // 下载链接只认 github.com 域：API 响应被篡改时也不把用户带去别处
    const htmlUrl = (data && typeof data.html_url === 'string'
      && /^https:\/\/github\.com\//.test(data.html_url)) ? data.html_url : RELEASES_PAGE;
    if (cmp > 0) {
      return {
        ok: true, status: 'available', current, latest, downloadUrl: htmlUrl,
        message: '发现新版本 v' + latest + '（当前 v' + current + '）'
      };
    }
    return { ok: true, status: 'latest', current, latest, downloadUrl: htmlUrl, message: '已是最新版本（v' + current + '）' };
  }

  return {
    TIMEOUT_MS: TIMEOUT_MS,
    MAX_BODY: MAX_BODY,
    MAX_REDIRECTS: MAX_REDIRECTS,
    RELEASES_PAGE: RELEASES_PAGE,
    compareVersions: compareVersions,
    normalizeTag: normalizeTag,
    check: check
  };
}

module.exports = { createUpdateChecker, compareVersions, normalizeTag, RELEASES_PAGE };
