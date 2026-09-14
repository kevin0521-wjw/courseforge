/**
 * CourseForge 核心业务逻辑（纯函数，无 DOM 依赖）
 * 可在浏览器与 Node 环境中通用（UMD 导出），便于脱离浏览器做单元测试
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.CourseForge = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==================== 常量 ====================

  /** 默认作息时间表（12 节，可被 settings.sectionTimes 覆盖） */
  var DEFAULT_SECTION_TIMES = [
    { label: '1',  start: '08:00', end: '08:45' },
    { label: '2',  start: '08:55', end: '09:40' },
    { label: '3',  start: '10:00', end: '10:45' },
    { label: '4',  start: '10:55', end: '11:40' },
    { label: '5',  start: '12:00', end: '12:45' },
    { label: '6',  start: '13:50', end: '14:35' },
    { label: '7',  start: '14:45', end: '15:30' },
    { label: '8',  start: '15:40', end: '16:25' },
    { label: '9',  start: '18:00', end: '18:45' },
    { label: '10', start: '18:55', end: '19:40' },
    { label: '11', start: '19:50', end: '20:35' },
    { label: '12', start: '20:45', end: '21:30' }
  ];

  /** 课程预设色（main 用于描边/强调，bg 用于卡片底色） */
  var COURSE_COLORS = [
    { key: 'blue',   name: '湖蓝', main: '#2f6fed', bg: '#e8effd' },
    { key: 'green',  name: '青绿', main: '#0e9f6e', bg: '#e2f6ee' },
    { key: 'orange', name: '暖橙', main: '#e8830c', bg: '#fdf0e0' },
    { key: 'red',    name: '朱红', main: '#e02424', bg: '#fdeaea' },
    { key: 'purple', name: '紫藤', main: '#7c3aed', bg: '#f1eafd' },
    { key: 'teal',   name: '靛青', main: '#0d9488', bg: '#e0f5f3' },
    { key: 'brown',  name: '驼棕', main: '#a16207', bg: '#f7f0dd' },
    { key: 'pink',   name: '桃粉', main: '#db2777', bg: '#fce9f1' }
  ];

  /** 星期名称，索引 0 对应周一 */
  var DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  var DAY_MS = 7 * 86400000; // 一周的毫秒数

  // ==================== 小工具 ====================

  /** 生成唯一 id（时间戳 + 随机段） */
  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 'YYYY-MM-DD' → 本地时区当日 0 点；非法输入返回 null */
  function parseDate(str) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(str == null ? '' : str));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** Date → 'YYYY-MM-DD' */
  function formatDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 日期加 n 天（不改变原对象） */
  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  /** 当日 0 点 */
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /** 对齐到所在周的周一 */
  function mondayOf(d) {
    var day = d.getDay(); // 0=周日
    var diff = (day === 0) ? -6 : (1 - day);
    return addDays(startOfDay(d), diff);
  }

  // ==================== 周次计算 ====================

  /**
   * 计算某日期处于学期第几周
   * 学期开始日所在周为第 1 周（周一为一周起点）；学期开始前返回 ≤ 0
   */
  function getWeekNumber(semesterStart, date) {
    var s = parseDate(semesterStart);
    if (!s || !date) return 1; // 无效学期日期时兜底为第 1 周
    var base = mondayOf(s);
    var cur = mondayOf(date);
    return Math.round((cur - base) / DAY_MS) + 1;
  }

  /** 第 week 周的周一日期；学期日期无效时返回 null */
  function mondayOfWeek(semesterStart, week) {
    var s = parseDate(semesterStart);
    if (!s) return null;
    return addDays(mondayOf(s), (week - 1) * 7);
  }

  /**
   * 生成周次数组
   * @param parity 'all' | 'odd'(单周) | 'even'(双周)
   */
  function generateWeeks(startWeek, endWeek, parity, totalWeeks) {
    var out = [];
    var s = Math.max(1, Math.round(Number(startWeek) || 1));
    var e = Math.round(Number(endWeek) || s);
    if (e < s) { var t = s; s = e; e = t; }
    for (var w = s; w <= e; w++) {
      if (totalWeeks && w > totalWeeks) break;
      if (parity === 'odd' && w % 2 === 0) continue;
      if (parity === 'even' && w % 2 === 1) continue;
      out.push(w);
    }
    return out;
  }

  /** 课程是否在第 week 周有课 */
  function courseCoversWeek(course, week) {
    var arr = course && course.weeks;
    if (!arr || !arr.length) return false;
    return arr.indexOf(week) !== -1;
  }

  // ==================== 课程查询 ====================

  /** 某周某天的课程列表（按开始节次排序） */
  function getDayCourses(courses, week, day) {
    var list = [];
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (c.day === day && courseCoversWeek(c, week)) list.push(c);
    }
    list.sort(function (a, b) {
      return (a.startSection - b.startSection) || (a.endSection - b.endSection);
    });
    return list;
  }

  /** 某周的全部课程（按天分组，返回 {day: [course]}），day 为 1~7 */
  function getWeekCourses(courses, week) {
    var byDay = {};
    for (var d = 1; d <= 7; d++) byDay[d] = getDayCourses(courses, week, d);
    return byDay;
  }

  /** 两段节次是否重叠 */
  function sectionsOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd;
  }

  /**
   * 检测某周同一天的节次冲突（用于周视图红点提示）
   * 返回 [{ day, week, a, b }]
   */
  function detectConflicts(courses, week) {
    var conflicts = [];
    for (var day = 1; day <= 7; day++) {
      var list = getDayCourses(courses, week, day);
      for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
          var a = list[i], b = list[j];
          if (sectionsOverlap(a.startSection, a.endSection, b.startSection, b.endSection)) {
            conflicts.push({ day: day, week: week, a: a, b: b });
          }
        }
      }
    }
    return conflicts;
  }

  /**
   * 一门课与其他课程在共同周次上的冲突（用于保存前提示）
   * 返回 [{ other, weeks:[共同周] }]
   */
  function findCourseClashes(course, allCourses) {
    var res = [];
    var others = (allCourses || []).filter(function (c) {
      return c && c.id !== course.id && c.day === course.day;
    });
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      if (!sectionsOverlap(course.startSection, course.endSection, o.startSection, o.endSection)) continue;
      var shared = [];
      var w = course.weeks || [];
      var ow = o.weeks || [];
      for (var k = 0; k < w.length; k++) {
        if (ow.indexOf(w[k]) !== -1) shared.push(w[k]);
      }
      if (shared.length) res.push({ other: o, weeks: shared });
    }
    return res;
  }

  // ==================== 校验 ====================

  /**
   * 校验课程字段，返回错误信息数组（空数组 = 通过）
   * 注意：周次冲突属于「警告」，走 findCourseClashes，不在这里报错
   */
  function validateCourse(course, settings, allCourses) {
    var errors = [];
    var maxSection = (settings && settings.sectionsPerDay) || 12;
    if (!course.name || !String(course.name).trim()) errors.push('请填写课程名称');
    if (!(course.day >= 1 && course.day <= 7)) errors.push('上课日期必须在周一至周日之间');
    if (!(course.startSection >= 1)) errors.push('开始节次无效');
    if (!(course.endSection >= 1)) errors.push('结束节次无效');
    if (course.endSection > maxSection) errors.push('结束节次不能超过每日最大节次（' + maxSection + '）');
    if (course.startSection > course.endSection) errors.push('开始节次不能晚于结束节次');
    if (!course.weeks || !course.weeks.length) errors.push('请至少选择一个上课周');
    return errors;
  }

  // ==================== 作息时间 ====================

  /** 'HH:MM' → 当日分钟数；非法返回 null */
  function timeToMinutes(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  /** 取第 section 节的时间配置；越界时给出兜底 */
  function getSectionTime(settings, section) {
    var times = (settings && settings.sectionTimes && settings.sectionTimes.length)
      ? settings.sectionTimes : DEFAULT_SECTION_TIMES;
    var t = times[section - 1];
    return t || { label: String(section), start: '', end: '' };
  }

  /** 课程的上课时间段文本，如 '08:00 ~ 09:40' */
  function sectionRangeText(settings, course) {
    var s = getSectionTime(settings, course.startSection);
    var e = getSectionTime(settings, course.endSection);
    return (s.start || '--:--') + ' ~ ' + (e.end || '--:--');
  }

  /** 当前时刻处于第几节（不在任何节内返回 0） */
  function getCurrentSection(date, settings) {
    var m = date.getHours() * 60 + date.getMinutes();
    var times = (settings && settings.sectionTimes && settings.sectionTimes.length)
      ? settings.sectionTimes : DEFAULT_SECTION_TIMES;
    for (var i = 0; i < times.length; i++) {
      var s = timeToMinutes(times[i].start);
      var e = timeToMinutes(times[i].end);
      if (s !== null && e !== null && m >= s && m < e) return i + 1;
    }
    return 0;
  }

  /** 课程状态：'before' 未开始 | 'now' 进行中 | 'done' 已结束 */
  function courseStatus(course, date, settings) {
    var s = getSectionTime(settings, course.startSection);
    var e = getSectionTime(settings, course.endSection);
    var m = date.getHours() * 60 + date.getMinutes();
    var sm = timeToMinutes(s.start);
    var em = timeToMinutes(e.end);
    if (sm === null || em === null) return 'before';
    if (m < sm) return 'before';
    if (m >= em) return 'done';
    return 'now';
  }

  // ==================== 数据清洗 ====================

  /** 清洗单门课程数据（导入/读取旧数据时的兜底），永远返回合法结构 */
  function normalizeCourse(raw) {
    var c = (raw && typeof raw === 'object') ? raw : {};
    var weeks = Array.isArray(c.weeks)
      ? c.weeks.map(function (w) { return Math.round(Number(w)); })
        .filter(function (w) { return w >= 1 && w <= 60; })
      : [];
    weeks = Array.from(new Set(weeks)).sort(function (a, b) { return a - b; });

    var start = Math.max(1, Math.round(Number(c.startSection) || 1));
    var end = Math.max(1, Math.round(Number(c.endSection) || start));
    if (end < start) { var t = start; start = end; end = t; }

    var day = Math.round(Number(c.day) || 1);
    if (day < 1) day = 1;
    if (day > 7) day = 7;

    return {
      id: (c.id != null && String(c.id)) || uid(),
      name: String(c.name == null ? '' : c.name).trim(),
      teacher: String(c.teacher == null ? '' : c.teacher).trim(),
      location: String(c.location == null ? '' : c.location).trim(),
      day: day,
      startSection: start,
      endSection: end,
      weeks: weeks,
      color: c.color || 'blue',
      note: String(c.note == null ? '' : c.note).trim()
    };
  }

  /** 清洗设置数据，非法字段回落到默认值 */
  function normalizeSettings(raw) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var s = {
      semesterStart: null,
      totalWeeks: 20,
      sectionsPerDay: 12,
      sectionTimes: DEFAULT_SECTION_TIMES.map(function (t) {
        return { label: t.label, start: t.start, end: t.end };
      })
    };
    if (typeof raw.totalWeeks === 'number' && raw.totalWeeks >= 1 && raw.totalWeeks <= 30) {
      s.totalWeeks = Math.round(raw.totalWeeks);
    }
    if (typeof raw.sectionsPerDay === 'number' && raw.sectionsPerDay >= 1 && raw.sectionsPerDay <= 14) {
      s.sectionsPerDay = Math.round(raw.sectionsPerDay);
    }
    var d = parseDate(raw.semesterStart);
    s.semesterStart = d ? formatDate(d) : null;
    if (Array.isArray(raw.sectionTimes) && raw.sectionTimes.length >= 1 && raw.sectionTimes.length <= 14) {
      s.sectionTimes = raw.sectionTimes.map(function (t, i) {
        t = (t && typeof t === 'object') ? t : {};
        var ok = function (v) { return /^\d{1,2}:\d{2}$/.test(String(v || '')); };
        return {
          label: t.label != null ? String(t.label) : String(i + 1),
          start: ok(t.start) ? String(t.start) : '',
          end: ok(t.end) ? String(t.end) : ''
        };
      });
    }
    // 学期开始日期缺省时，取本周周一
    if (!s.semesterStart) s.semesterStart = formatDate(mondayOf(new Date()));
    return s;
  }

  // ==================== 周次文本 ====================

  /**
   * 把周次数组转成人类可读文本
   * [1..16] → '1-16 周'；单双周序列 → '1-15 周（单周）'；[1,2,3,7] → '1-3,7 周'
   */
  function weeksText(weeks) {
    if (!weeks || !weeks.length) return '—';
    var allOdd = weeks.length > 2 && weeks.every(function (w) { return w % 2 === 1; });
    var allEven = weeks.length > 2 && weeks.every(function (w) { return w % 2 === 0; });
    if (allOdd || allEven) {
      return weeks[0] + '-' + weeks[weeks.length - 1] + ' 周（' + (allOdd ? '单周' : '双周') + '）';
    }
    var parts = [];
    var s = weeks[0], p = weeks[0];
    for (var i = 1; i <= weeks.length; i++) {
      var w = weeks[i];
      if (w !== p + 1) {
        parts.push(s === p ? String(s) : s + '-' + p);
        s = w;
      }
      p = w;
    }
    return parts.join(',') + ' 周';
  }

  // ==================== 示例数据 ====================

  /** 5 门示例课程（不含 id，由 normalizeCourse 生成；示例课程 id 统一加 demo_ 前缀便于一键清除） */
  function buildSampleCourses() {
    return [
      { name: '高等数学（上）', teacher: '王老师', location: '教学楼A301', day: 1, startSection: 1, endSection: 2, weeks: generateWeeks(1, 16, 'all', 20), color: 'blue', note: '示例课程，可删除' },
      { name: '大学英语', teacher: '李老师', location: '外语楼204', day: 2, startSection: 3, endSection: 4, weeks: generateWeeks(1, 16, 'odd', 20), color: 'green', note: '单周上课 · 示例' },
      { name: '数据结构', teacher: '张老师', location: '实验楼502机房', day: 3, startSection: 5, endSection: 6, weeks: generateWeeks(1, 16, 'all', 20), color: 'purple', note: '示例课程，可删除' },
      { name: '大学体育', teacher: '刘老师', location: '体育馆', day: 4, startSection: 9, endSection: 10, weeks: generateWeeks(1, 16, 'all', 20), color: 'orange', note: '示例课程，可删除' },
      { name: '程序设计基础', teacher: '陈老师', location: '教学楼B105', day: 5, startSection: 3, endSection: 4, weeks: generateWeeks(1, 8, 'all', 20), color: 'red', note: '前 8 周上课 · 示例' }
    ];
  }

  // ==================== 导出 ====================

  return {
    DEFAULT_SECTION_TIMES: DEFAULT_SECTION_TIMES,
    COURSE_COLORS: COURSE_COLORS,
    DAY_NAMES: DAY_NAMES,
    uid: uid,
    parseDate: parseDate,
    formatDate: formatDate,
    addDays: addDays,
    startOfDay: startOfDay,
    mondayOf: mondayOf,
    getWeekNumber: getWeekNumber,
    mondayOfWeek: mondayOfWeek,
    generateWeeks: generateWeeks,
    courseCoversWeek: courseCoversWeek,
    getDayCourses: getDayCourses,
    getWeekCourses: getWeekCourses,
    sectionsOverlap: sectionsOverlap,
    detectConflicts: detectConflicts,
    findCourseClashes: findCourseClashes,
    validateCourse: validateCourse,
    timeToMinutes: timeToMinutes,
    getSectionTime: getSectionTime,
    sectionRangeText: sectionRangeText,
    getCurrentSection: getCurrentSection,
    courseStatus: courseStatus,
    normalizeCourse: normalizeCourse,
    normalizeSettings: normalizeSettings,
    weeksText: weeksText,
    buildSampleCourses: buildSampleCourses
  };
});
