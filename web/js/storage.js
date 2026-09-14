/**
 * CourseForge 存储层
 * 优先 localStorage；环境不支持（或被禁用）时回落到内存存储，保证页面不崩
 * 所有写入均为深拷贝，避免外部引用污染已存数据
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.CourseStorage = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'wb_courseforge_v1';

  /** 内存兜底存储（localStorage 不可用时使用） */
  var memoryData = null;

  function localStorageAvailable() {
    try {
      var testKey = '__cf_probe__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  var usable = (typeof localStorage !== 'undefined') && localStorageAvailable();

  /**
   * 读取全部数据
   * @returns {object|null} { version, courses, settings }；无数据或数据损坏返回 null
   */
  function load() {
    var raw = null;
    if (usable) {
      try {
        raw = localStorage.getItem(KEY);
      } catch (e) {
        usable = false; // 读取失败（如隐私模式），降级为内存
      }
    }
    if (raw === null && memoryData !== null) return memoryData;
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (e) {
      return null; // 数据损坏按无数据处理，由上层重新播种示例
    }
  }

  /**
   * 保存全部数据（深拷贝后写入）
   * @returns {boolean} 是否写入 localStorage 成功（内存模式返回 false）
   */
  function save(data) {
    var snap = JSON.parse(JSON.stringify(data));
    memoryData = snap;
    if (!usable) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(snap));
      return true;
    } catch (e) {
      // 存储满或被禁用：保留内存数据，页面仍可运行
      usable = false;
      return false;
    }
  }

  /** 清空本地数据 */
  function clear() {
    memoryData = null;
    if (usable) {
      try {
        localStorage.removeItem(KEY);
      } catch (e) { /* 忽略 */ }
    }
  }

  /** 当前是否处于 localStorage 可用状态 */
  function isUsable() {
    return usable;
  }

  return {
    KEY: KEY,
    load: load,
    save: save,
    clear: clear,
    isUsable: isUsable
  };
});
