/**
 * CourseForge 教务账号的本机加密存储
 *
 * 定位：让「一键自动登录」不必每次手打密码 —— 但**只存密文**。
 *
 * 三条铁律（动这个文件之前先读一遍）：
 *  1. 明文密码永不落盘、永不外发。磁盘上只有 safeStorage 加密后的密文。
 *  2. 加密能力不可用时**拒绝保存**，绝不退回明文。
 *     悄悄存明文，比存不上危险得多 —— 存不上用户只是多打一次密码。
 *  3. 任何读取异常（文件损坏、换了 Windows 账户导致解不开）一律按「没存过」处理，
 *     不抛异常打断启动 —— 大不了让用户重新输一次。
 *
 * safeStorage 在 Windows 下走 DPAPI，密钥绑定当前用户账户：
 * 文件被拷到别的机器/别的账户都解不开，这正是我们要的性质
 * （本机自用、不做跨机同步，所以不需要自己管密钥）。
 *
 * 为什么不用 keytar / 自己 AES：多一个原生依赖要编译，而 Electron 已经内置了
 * 平台正确的实现。少一个依赖就少一处装不上的风险。
 *
 * 该文件抽成 CommonJS 模块是为了能在 Node 里直接单测：
 * safeStorage 由调用方注入（测试传桩，运行时传 Electron 的）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 文件格式版本：以后换加密方式时靠它识别老文件，而不是解出一堆乱码 */
const FILE_VERSION = 1;

/** 用户名/密码的长度上限：异常长的输入一定是搞错了，挡在落盘之前 */
const MAX_LEN = 200;

/**
 * @param {object} opts
 * @param {string} opts.file      密文文件路径（运行时由 main 传 userData 下的路径）
 * @param {object} opts.safeStorage Electron 的 safeStorage，测试时可传桩
 * @param {function} [opts.log]   记录异常原因，默认静默
 */
function createCredStore(opts) {
  const file = opts && opts.file;
  const safeStorage = opts && opts.safeStorage;
  const log = (opts && opts.log) || function () {};

  /** 本机能不能存密文（Linux 没有 keyring 时会不可用） */
  function available() {
    try {
      return !!(safeStorage && safeStorage.isEncryptionAvailable());
    } catch (e) {
      return false;
    }
  }

  /** 读回明文账号；没存过/解不开都返回 null */
  function read() {
    if (!file) return null;

    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return null; // 文件不存在 = 没存过，属于正常情况，不打日志
    }

    let env;
    try {
      env = JSON.parse(raw);
    } catch (e) {
      log('凭据文件不是合法 JSON，按未保存处理');
      return null;
    }
    if (!env || env.v !== FILE_VERSION || typeof env.secret !== 'string' || !env.secret) {
      log('凭据文件版本或结构不认识，按未保存处理');
      return null;
    }

    let plain;
    try {
      plain = safeStorage.decryptString(Buffer.from(env.secret, 'base64'));
    } catch (e) {
      log('凭据解密失败（常见原因：换了 Windows 账户或换了机器），按未保存处理');
      return null;
    }

    let obj;
    try {
      obj = JSON.parse(plain);
    } catch (e) {
      log('凭据明文不是合法 JSON，按未保存处理');
      return null;
    }
    if (!obj || typeof obj.username !== 'string' || !obj.username) return null;
    return { username: obj.username, password: typeof obj.password === 'string' ? obj.password : '' };
  }

  /**
   * 保存账号。返回 { ok:true } 或 { ok:false, reason }
   * reason: 'noenc' 本机不具备加密能力（**不会退回明文**）/ 'badinput' 参数不合法 / 'io' 写盘失败
   */
  function save(cred) {
    const username = String((cred && cred.username) || '').trim();
    const password = String((cred && cred.password) || '');
    if (!username || !password) return { ok: false, reason: 'badinput' };
    if (username.length > MAX_LEN || password.length > MAX_LEN) return { ok: false, reason: 'badinput' };

    if (!available()) return { ok: false, reason: 'noenc' };
    if (!file) return { ok: false, reason: 'io' };

    let secret;
    try {
      secret = safeStorage.encryptString(JSON.stringify({ username: username, password: password }))
        .toString('base64');
    } catch (e) {
      log('凭据加密失败：' + ((e && e.message) || e));
      return { ok: false, reason: 'io' };
    }

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 先写临时文件再改名：中途断电不会留下半截 JSON 被当成损坏文件
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, secret: secret, updatedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (e) {
      log('凭据写盘失败：' + ((e && e.message) || e));
      return { ok: false, reason: 'io' };
    }
  }

  /** 清除已保存的账号；文件本来就不在也算成功 */
  function clear() {
    if (!file) return true;
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (e && e.code === 'ENOENT') return true;
      log('凭据删除失败：' + ((e && e.message) || e));
      return false;
    }
  }

  /**
   * 给界面用的状态。
   * 这里**只回传用户名**（学号）用于显示「已保存：26xxxxxx」，
   * 密码永远不出主进程 —— 页面拿不到，也就没法泄漏。
   */
  function status() {
    const c = read();
    return {
      available: available(),
      saved: !!c,
      username: c ? c.username : ''
    };
  }

  return { available: available, read: read, save: save, clear: clear, status: status };
}

module.exports = { createCredStore, FILE_VERSION, MAX_LEN };
