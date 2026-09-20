/**
 * CourseForge 法定节假日同步（纯函数层：URL 构建 + 响应解析 + 合并策略）
 *
 * 数据源：NateScarlet/holiday-cn（GitHub Actions 每日自动抓取国务院办公厅公告，
 * 数据与《关于部分节假日安排的通知》完全一致；papers 字段就是官方公告原文链接）。
 * 此前项目刻意「不联网拉节假日」（见 remind.js 旧注释），本模块落地后策略变为：
 *   - 自动同步写入 settings.holidayDays，只做兜底层；
 *   - 用户手动标记（settings.days）永远优先 —— 校历与法定假日不一致时点一下即可覆盖；
 *   - 手动标记取消后自动回落到法定安排。
 *
 * 分层原则（与 webdav.js 同款）：本模块不知道 fetch 是什么 ——
 * 网络传输由调用方注入，传输方式可以是 renderer 的 window.fetch、
 * 主进程的 http.get 或测试里的假响应，判定与解析逻辑三端共用且可单测。
 *
 * 依赖：无（不依赖 core.js，保持可独立测试）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    root.CourseForgeHolidays = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==================== 数据源 ====================
  //
  // 官方仓库 README：年份按国务院文件标题计，12 月的日期可能被下一年文件影响，
  // 「应检查两个文件」—— 所以调用方要同时拉当年和次年（见 yearsFor）。
  // 候选顺序即尝试顺序：jsDelivr 大陆直连最稳，raw.githubusercontent 作备选，
  // fastly.jsdelivr 是 jsDelivr 的独立节点（部分网络下两者可达性互补）。

  var HOLIDAY_CN = 'NateScarlet/holiday-cn';

  /** 某年份的候选数据 URL（按优先级排序；调用方逐个试，谁先成功用谁） */
  function sourceUrls(year) {
    var y = String(year);
    return [
      'https://cdn.jsdelivr.net/gh/' + HOLIDAY_CN + '@master/' + y + '.json',
      'https://fastly.jsdelivr.net/gh/' + HOLIDAY_CN + '@master/' + y + '.json',
      'https://raw.githubusercontent.com/' + HOLIDAY_CN + '/master/' + y + '.json'
    ];
  }

  /**
   * 需要同步的年份列表：今天所在年 + 学期结束日所在年（秋季学期跨年），
   * 再并入次年 —— 法定安排提前几个月公布，跨年放假信息值得提前拿。
   * 去重、升序。参数都是 'YYYY-MM-DD' 字符串，传非法值时安静忽略。
   */
  function yearsFor(todayStr, semesterEndStr) {
    var out = [];
    var push = function (s) {
      var m = /^(\d{4})-\d{2}-\d{2}$/.exec(s || '');
      if (!m) return;
      var y = Number(m[1]);
      if (out.indexOf(y) === -1) out.push(y);
    };
    push(todayStr);
    push(semesterEndStr);
    if (out.length) {
      var next = out[out.length - 1] + 1; // 最后一年的下一年（次年安排）
      out.push(next);
    }
    return out.sort();
  }

  // ==================== 解析 ====================

  /** '2026-1-1' → '2026-01-01'；非法返回 ''（与 core.formatDate 的产物对齐） */
  function normalizeDate(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || ''));
    if (!m) return '';
    var mm = Number(m[2]);
    var dd = Number(m[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
    return m[1] + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (dd < 10 ? '0' + dd : dd);
  }

  /**
   * 解析 holiday-cn 年度 JSON → { 'YYYY-MM-DD': 'off' | 'makeup' }
   * 接受对象或字符串（调用方拿到文本先 JSON.parse 也行，这里兜一手）。
   * 结构校验从紧：year/days 缺失、date 非法、isOffDay 非 boolean 的条目一律丢弃，
   * 一份坏数据宁可返回空表也不能让整个学期被标错。
   */
  function parseHolidayCn(raw) {
    var data = raw;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return {}; }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    if (!Array.isArray(data.days)) return {};
    var out = {};
    for (var i = 0; i < data.days.length; i++) {
      var d = data.days[i];
      if (!d || typeof d !== 'object') continue;
      var date = normalizeDate(d.date);
      if (!date) continue;
      if (typeof d.isOffDay !== 'boolean') continue;
      out[date] = d.isOffDay ? 'off' : 'makeup';
    }
    return out;
  }

  // ==================== 合并 ====================

  /**
   * 合并策略：next 覆盖 prev 中「同一天的旧自动数据」，
   * 但绝不碰 manualDays（手动标记是另一张表，判定时手动优先，见 remind.dayMark）。
   * 返回新对象，不改入参。
   */
  function mergeInto(prev, next) {
    var out = {};
    var k;
    for (k in (prev || {})) {
      if (Object.prototype.hasOwnProperty.call(prev, k)) out[k] = prev[k];
    }
    for (k in (next || {})) {
      if (Object.prototype.hasOwnProperty.call(next, k)) out[k] = next[k];
    }
    return out;
  }

  /** 只保留学期范围内的自动标记（防年度累积；学期外下次同步会重新拿回来） */
  function pruneToRange(days, fromStr, toStr) {
    var out = {};
    for (var k in (days || {})) {
      if (!Object.prototype.hasOwnProperty.call(days, k)) continue;
      if (k >= fromStr && k <= toStr) out[k] = days[k];
    }
    return out;
  }

  return {
    sourceUrls: sourceUrls,
    yearsFor: yearsFor,
    normalizeDate: normalizeDate,
    parseHolidayCn: parseHolidayCn,
    mergeInto: mergeInto,
    pruneToRange: pruneToRange
  };
});
