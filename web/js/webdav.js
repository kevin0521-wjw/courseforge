/**
 * CourseForge WebDAV 云同步（纯逻辑 + 可注入的传输层）
 *
 * 路线图 v1.0，踩着一条底线做的：**云同步必须是可选项，默认仍然全本地**。
 * 不填服务器配置，这个功能就不存在 —— 和竞品「注册账号才能用」是两个物种。
 *
 * v1 只做手动两键：上传备份（覆盖云端）/ 从云端恢复（覆盖本地）。
 * 不做自动同步、不做冲突合并 —— 课表是低频变更数据，自动同步的冲突处理
 * 复杂度远超收益；「手动两键 + 明确的确认弹窗」语义最干净。
 *
 * 分层（和 remind.js 同一哲学）：
 *   - 本模块只做纯逻辑：配置清洗、远端路径、备份载荷校验、Basic 认证头。
 *     HTTP 一个字节都不发 —— 传输由调用方注入（desktop 传 Node 实现，
 *     网页端传 fetch 实现），于是全部逻辑可以离线单测。
 *   - 本模块不知道 fetch / https / ipcRenderer 是什么。
 *
 * 备份格式复用现有 JSON 导出（version 2 workspace），云端固定路径
 * CourseForge/courseforge-workspace.json —— 一个文件，不搞版本历史
 * （历史靠「导出备份」的时间戳文件名，用户自己的文件系统自己管）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    root.CourseForgeWebDav = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 输入长度上限：异常长的输入一定是搞错了，挡在发请求之前 */
  var URL_MAX = 300;
  var NAME_MAX = 200;
  var PASS_MAX = 200;

  /** 云端固定目录与文件名：一个账号一份最新备份，简单到不可能解释错 */
  var REMOTE_DIR = 'CourseForge';
  var REMOTE_FILE = 'courseforge-workspace.json';

  /**
   * 清洗配置。返回 null = 配置不完整/不合法（调用方给明确提示，不发请求）。
   * password 单独处理（桌面端走加密存储，网页端可选明文记住），这里只验长度。
   */
  function normalizeConfig(raw) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var url = String(raw.url == null ? '' : raw.url).trim().replace(/\/+$/, '');
    var username = String(raw.username == null ? '' : raw.username).trim();
    var password = String(raw.password == null ? '' : raw.password);
    if (!url || url.length > URL_MAX) return null;
    // 只认 http(s)：file: / ftp: 一律拒绝 —— WebDAV 就是 HTTP 上的一个方言
    if (!/^https?:\/\//i.test(url)) return null;
    if (!username || username.length > NAME_MAX) return null;
    if (password.length > PASS_MAX) return null;
    return { url: url, username: username, password: password };
  }

  /** 远端文件完整地址：baseUrl + 固定目录 + 固定文件名（baseUrl 已无尾斜杠） */
  function remoteUrl(config) {
    var base = config && config.url ? String(config.url) : '';
    if (!base) return '';
    return base + '/' + REMOTE_DIR + '/' + REMOTE_FILE;
  }

  /**
   * Basic 认证头。b64 由调用方注入（浏览器 btoa / Node Buffer），
   * 因为 UTF-8 用户名在两边的编码写法不同 —— 与其写两份，不如注入一份。
   */
  function authHeader(username, password, b64) {
    if (typeof b64 !== 'function') return '';
    return 'Basic ' + b64(String(username == null ? '' : username) + ':' + String(password == null ? '' : password));
  }

  /**
   * 校验云端取回的备份文本。返回解析后的对象，不合法返回 null。
   * 云端是用户自己管的服务器，返回什么都有可能 —— 一律先过安检再进工作区。
   * 接受 v2（{version:2, semesters:[…]}）与 v1（{version:1, courses:[…]}）；
   * 最终清洗仍由 core.normalizeWorkspace 负责，这里只做「值得给它一次机会」的初检。
   */
  function validateBackupText(text) {
    if (typeof text !== 'string' || !text) return null;
    if (text.length > 20 * 1024 * 1024) return null; // 20MB：课表永远用不到这么大
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.version === 2 && Array.isArray(data.semesters)) return data;
    if (data.version === 1 && Array.isArray(data.courses)) return data;
    return null;
  }

  /** 恢复确认弹窗里的一句话摘要：让人知道云端那份是什么、多大 */
  function workspaceSummary(ws) {
    if (!ws || typeof ws !== 'object') return '';
    var sems = Array.isArray(ws.semesters) ? ws.semesters : null;
    if (sems) {
      var courses = 0;
      for (var i = 0; i < sems.length; i++) {
        if (sems[i] && Array.isArray(sems[i].courses)) courses += sems[i].courses.length;
      }
      return sems.length + ' 个学期 · 共 ' + courses + ' 门课';
    }
    if (Array.isArray(ws.courses)) return '旧版数据 · ' + ws.courses.length + ' 门课';
    return '';
  }

  return {
    REMOTE_DIR: REMOTE_DIR,
    REMOTE_FILE: REMOTE_FILE,
    normalizeConfig: normalizeConfig,
    remoteUrl: remoteUrl,
    authHeader: authHeader,
    validateBackupText: validateBackupText,
    workspaceSummary: workspaceSummary
  };
});
