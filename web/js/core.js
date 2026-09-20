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

  /** 作息时间预设：上海大学官方 12 节制（来源：jwb.shu.edu.cn，2021-09-01 起实施） */
  var SECTION_TIME_PRESETS = {
    shu: [
      { label: '1',  start: '08:00', end: '08:45' },
      { label: '2',  start: '08:55', end: '09:40' },
      { label: '3',  start: '10:00', end: '10:45' },
      { label: '4',  start: '10:55', end: '11:40' },
      { label: '5',  start: '13:00', end: '13:45' },
      { label: '6',  start: '13:55', end: '14:40' },
      { label: '7',  start: '15:00', end: '15:45' },
      { label: '8',  start: '15:55', end: '16:40' },
      { label: '9',  start: '18:00', end: '18:45' },
      { label: '10', start: '18:55', end: '19:40' },
      { label: '11', start: '20:00', end: '20:45' },
      { label: '12', start: '20:55', end: '21:40' }
    ],
    generic: null // 运行时指向 DEFAULT_SECTION_TIMES 的深拷贝
  };

  /** 获取作息预设的深拷贝（避免调用方直接改到常量） */
  function getPresetTimes(key) {
    if (key === 'generic' || !SECTION_TIME_PRESETS[key]) {
      return DEFAULT_SECTION_TIMES.map(function (t) {
        return { label: t.label, start: t.start, end: t.end };
      });
    }
    return SECTION_TIME_PRESETS[key].map(function (t) {
      return { label: t.label, start: t.start, end: t.end };
    });
  }

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

  /**
   * 某周某天的课程列表（按开始节次排序）
   *
   * 容错：courses 不是数组时当作「没有课」。
   * 起因是提醒引擎按定时器跑，工作区还没加载完就被触发过一次，
   * 直接 null.length 抛异常会把整个 tick 打断（连累同一时刻的其他提醒）。
   * 「数据没准备好」和「今天没课」在这里的结果本来就一样，没必要抛。
   */
  function getDayCourses(courses, week, day) {
    var list = [];
    if (!courses || typeof courses.length !== 'number') return list;
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (c && c.day === day && courseCoversWeek(c, week)) list.push(c);
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

  /** 当前时刻的当日分钟数（0-1439） */
  function nowMinutes(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  /** 课程的 [开始分钟, 结束分钟]；时间不完整时返回 null */
  function courseMinutes(course, settings) {
    var s = timeToMinutes(getSectionTime(settings, course.startSection).start);
    var e = timeToMinutes(getSectionTime(settings, course.endSection).end);
    if (s === null || e === null || e <= s) return null;
    return { start: s, end: e };
  }

  /**
   * 课程进度（今日课程进度条 / 倒计时用）
   * 返回 { state, percent, remainMin, startInMin }
   *  - state: 'unknown'(作息缺失) | 'before'(未开始) | 'now'(进行中) | 'done'(已结束)
   *  - percent: 0-100，仅 'now' 有意义
   *  - remainMin: 距下课分钟数（'now' 时有效）
   *  - startInMin: 距上课分钟数（'before' 时有效）
   */
  function courseProgress(course, date, settings) {
    var range = courseMinutes(course, settings);
    if (!range) return { state: 'unknown', percent: 0, remainMin: null, startInMin: null };
    var m = nowMinutes(date);
    if (m < range.start) {
      return { state: 'before', percent: 0, remainMin: null, startInMin: range.start - m };
    }
    if (m >= range.end) {
      return { state: 'done', percent: 100, remainMin: 0, startInMin: null };
    }
    var total = range.end - range.start;
    return {
      state: 'now',
      percent: Math.max(0, Math.min(100, Math.round((m - range.start) / total * 100))),
      remainMin: range.end - m,
      startInMin: null
    };
  }

  /**
   * 今日「下一节课」：返回 { course, startInMin, startTime }，没有则返回 null
   * @param dayCourses 当天课程列表（应已按节次排序）
   */
  function nextCourse(dayCourses, date, settings) {
    var m = nowMinutes(date);
    var best = null;
    for (var i = 0; i < (dayCourses || []).length; i++) {
      var c = dayCourses[i];
      var range = courseMinutes(c, settings);
      if (!range) continue;
      if (range.start <= m) continue; // 已开始或已结束
      if (!best || range.start < best.startMin) {
        best = { course: c, startMin: range.start };
      }
    }
    if (!best) return null;
    var t = getSectionTime(settings, best.course.startSection);
    return {
      course: best.course,
      startInMin: best.startMin - m,
      startTime: t.start || ''
    };
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
      showWeekend: true,   // 是否显示周六/周日列
      sectionTimes: DEFAULT_SECTION_TIMES.map(function (t) {
        return { label: t.label, start: t.start, end: t.end };
      })
    };
    // 只有显式传 false 才隐藏周末（缺省/undefined 一律视为显示，兼容旧数据）
    if (raw.showWeekend === false) s.showWeekend = false;
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

    // 调休 / 放假日标记：{ 'YYYY-MM-DD': 'off' | 'makeup' }
    // 只接受这两种值 —— 别的值一律丢弃，避免一份被写坏的数据让整个提醒引擎沉默
    s.days = {};
    if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
      for (var k in raw.days) {
        if (!Object.prototype.hasOwnProperty.call(raw.days, k)) continue;
        if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(k)) continue;
        var v = raw.days[k];
        if (v === 'off' || v === 'makeup') s.days[k] = v;
      }
    }

    // 法定节假日自动同步数据（holidays.js 拉取后写入）：结构与 days 相同，
    // 判定优先级低于手动 days（见 remind.dayMark）。同样从紧清洗。
    s.holidayDays = {};
    if (raw.holidayDays && typeof raw.holidayDays === 'object' && !Array.isArray(raw.holidayDays)) {
      for (var hk in raw.holidayDays) {
        if (!Object.prototype.hasOwnProperty.call(raw.holidayDays, hk)) continue;
        if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(hk)) continue;
        var hv = raw.holidayDays[hk];
        if (hv === 'off' || hv === 'makeup') s.holidayDays[hk] = hv;
      }
    }
    // 同步状态：enabled 默认开（拉不到就静默保持现状，不打扰）；lastSync 是日期、source 记命中源
    var hs = (raw.holidaySync && typeof raw.holidaySync === 'object') ? raw.holidaySync : {};
    var lastSync = '';
    var hsm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(hs.lastSync || '');
    if (hsm) {
      // 宽松日期归一成补零格式，保证 lastSync 与 days 的键格式永远一致
      lastSync = hsm[1] + '-' + (hsm[2].length < 2 ? '0' + hsm[2] : hsm[2]) + '-' + (hsm[3].length < 2 ? '0' + hsm[3] : hsm[3]);
    }
    s.holidaySync = {
      enabled: hs.enabled !== false,
      lastSync: lastSync,
      source: typeof hs.source === 'string' ? String(hs.source).slice(0, 120) : ''
    };

    // 上课提醒配置（默认关闭，见 remind.js 顶部说明）
    var rr = (raw.remind && typeof raw.remind === 'object') ? raw.remind : {};
    var lead = Number(rr.lead);
    if (!isFinite(lead) || lead < 0 || lead > 120) lead = 10;
    s.remind = { enabled: rr.enabled === true, lead: Math.round(lead) };

    return s;
  }

  // ==================== 多学期（工作区） ====================
  //
  // 数据结构（schema v2）：
  //   { version: 2, activeId, semesters: [ { id, name, settings, courses } ] }
  // 旧版（v1）为扁平结构 { version: 1, courses, settings }，由 normalizeWorkspace 自动迁移，
  // 迁移只做「套一层壳」，课程与设置的清洗仍走 normalizeCourse / normalizeSettings，不丢数据。

  /** 由学期开始日期推导默认学期名：8-12 月与次年 1 月算秋季，2-7 月算春季 */
  function defaultSemesterName(semesterStart) {
    var d = parseDate(semesterStart);
    if (!d) return '我的课表';
    var m = d.getMonth() + 1;
    var y = d.getFullYear();
    if (m >= 8) return y + ' 秋季学期';
    if (m === 1) return (y - 1) + ' 秋季学期';
    return y + ' 春季学期';
  }

  // ==================== 考试与自定义事件 ====================
  //
  // 挂在学期上（semester.events），跟学期一起切换 / 删除 / 备份，不另开存储。
  // schema 仍是 v2 —— events 是可选字段，旧数据没有它就当空数组，无需迁移。
  //   { id, name, date: 'YYYY-MM-DD', time: 'HH:MM'|'', note: '', kind: 'exam'|'custom' }

  /** 事件名/备注的长度上限：塞进倒计时 chip 和托盘提示都不至于溢出 */
  var EVENT_NAME_MAX = 24;
  var EVENT_NOTE_MAX = 60;

  /**
   * 清洗单个事件。名字为空或日期非法时返回 null（调用方应把 null 丢掉）——
   * 一条坏数据不值得让整场考试消失，但也不值得为它留壳。
   */
  function normalizeEvent(raw) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var name = String(raw.name == null ? '' : raw.name).trim();
    var d = parseDate(raw.date);
    if (!name || !d) return null;
    if (name.length > EVENT_NAME_MAX) name = name.slice(0, EVENT_NAME_MAX);
    var time = '';
    // 时间要真的合法（小时 ≤23、分 ≤59）并零填充成 HH:MM —— 零填充后字符串比较
    // 与数值比较同序，「同一天按时间先后排」才不会把 9:00 排到 10:00 后面
    var tm = /^(\d{1,2}):(\d{2})$/.exec(String(raw.time || ''));
    if (tm) {
      var hh = Number(tm[1]);
      var mm = Number(tm[2]);
      if (hh <= 23 && mm <= 59) {
        time = (hh < 10 ? '0' + hh : String(hh)) + ':' + (mm < 10 ? '0' + mm : String(mm));
      }
    }
    var note = String(raw.note == null ? '' : raw.note).trim();
    if (note.length > EVENT_NOTE_MAX) note = note.slice(0, EVENT_NOTE_MAX);
    return {
      id: (raw.id != null && String(raw.id)) ? String(raw.id) : uid(),
      name: name,
      date: formatDate(d),
      time: time,
      note: note,
      // kind 只认两种：写错的当作普通事件而不是丢弃（名字日期都好的数据不值得扔）
      kind: (raw.kind === 'exam') ? 'exam' : 'custom'
    };
  }

  /** 清洗事件数组：丢掉非法项；id 重复的重新发号（同课程的处理方式） */
  function normalizeEvents(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var ev = normalizeEvent(list[i]);
      if (!ev) continue;
      while (seen[ev.id]) ev.id = uid();
      seen[ev.id] = true;
      out.push(ev);
    }
    return out;
  }

  /** 自然日差：同一天是 0，明天是 1（不受时刻影响——「今天 23 点的考试」也是今天） */
  function daysUntil(dateStr, now) {
    var d = parseDate(dateStr);
    if (!d) return null;
    var today = startOfDay(now);
    var target = startOfDay(d);
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }

  /**
   * 接下来的事件：丢掉已经过去的（今天的不丢——考完试当天还想知道「就是今天」），
   * 按日期升序（同日按时间早的在前），只留前 limit 条。
   */
  function upcomingEvents(events, now, limit) {
    var list = normalizeEvents(events);
    var future = [];
    for (var i = 0; i < list.length; i++) {
      var left = daysUntil(list[i].date, now);
      if (left == null || left < 0) continue;
      future.push({ ev: list[i], left: left });
    }
    future.sort(function (a, b) {
      if (a.left !== b.left) return a.left - b.left;
      var ta = a.ev.time ? a.ev.time : '99:99';
      var tb = b.ev.time ? b.ev.time : '99:99';
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });
    var n = (isFinite(limit) && limit > 0) ? Math.floor(limit) : 3;
    return future.slice(0, n).map(function (x) {
      return {
        id: x.ev.id, name: x.ev.name, date: x.ev.date, time: x.ev.time,
        note: x.ev.note, kind: x.ev.kind, daysLeft: x.left,
        // 文案在这里就定稿：首页 chip、托盘、挂件都用这一份，不会出现
        // 「托盘说明天、挂件说还有 1 天」这种同一事实两种说法
        countdownText: countdownTextOf(x.left)
      };
    });
  }

  /** 倒计时短文案：chip / 托盘 / 挂件共用，别再造第二份（会写出「还有 0 天」这种话） */
  function countdownTextOf(daysLeft) {
    if (daysLeft === 0) return '今天';
    if (daysLeft === 1) return '明天';
    return '还有 ' + daysLeft + ' 天';
  }

  /** 清洗单个学期；id 缺失时用 fallbackId 兜底 */
  function normalizeSemester(raw, fallbackId) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var settings = normalizeSettings(raw.settings);
    var courses = Array.isArray(raw.courses) ? raw.courses.map(normalizeCourse) : [];
    var events = normalizeEvents(raw.events);
    var name = String(raw.name == null ? '' : raw.name).trim();
    if (!name) name = defaultSemesterName(settings.semesterStart);
    if (name.length > 20) name = name.slice(0, 20);
    var id = (raw.id != null && String(raw.id)) ? String(raw.id) : String(fallbackId || uid());
    return { id: id, name: name, settings: settings, courses: courses, events: events };
  }

  /**
   * 清洗整个工作区，同时兼容 v1 旧数据。
   * @returns {{activeId: string, semesters: Array}|null} 完全无数据时返回 null（由上层播种示例）
   */
  function normalizeWorkspace(raw) {
    if (!raw || typeof raw !== 'object') return null;

    // v2（或任何带 semesters 数组的结构）
    if (Array.isArray(raw.semesters) && raw.semesters.length) {
      var list = [];
      var seen = {};
      for (var i = 0; i < raw.semesters.length; i++) {
        var sem = normalizeSemester(raw.semesters[i]);
        // 重复 id 会让「切换/删除」命中错误的学期，这里直接重新发号
        while (seen[sem.id]) sem.id = uid();
        seen[sem.id] = true;
        list.push(sem);
      }
      var activeId = raw.activeId == null ? '' : String(raw.activeId);
      var found = false;
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === activeId) { found = true; break; }
      }
      if (!found) activeId = list[0].id;   // activeId 失效时回落到第一个，避免白屏
      return { activeId: activeId, semesters: list };
    }

    // v1 迁移：扁平结构套一层壳
    if (Array.isArray(raw.courses) || (raw.settings && typeof raw.settings === 'object')) {
      var one = normalizeSemester({ settings: raw.settings, courses: raw.courses });
      return { activeId: one.id, semesters: [one] };
    }

    return null;
  }

  /** 按 id 查学期，找不到返回 null */
  function findSemester(ws, id) {
    if (!ws || !Array.isArray(ws.semesters)) return null;
    for (var i = 0; i < ws.semesters.length; i++) {
      if (ws.semesters[i].id === id) return ws.semesters[i];
    }
    return null;
  }

  /** 取当前激活的学期 */
  function activeSemester(ws) {
    return ws ? findSemester(ws, ws.activeId) : null;
  }

  /** 新学期默认开始日期：当前学期结束后那一周的周一 */
  function nextSemesterStart(settings) {
    var d = parseDate(settings && settings.semesterStart);
    if (!d) return formatDate(mondayOf(new Date()));
    var weeks = (settings && settings.totalWeeks) || 20;
    return formatDate(mondayOf(addDays(d, weeks * 7)));
  }

  /**
   * 由当前学期推导「新建学期」的默认值（名称 + 设置）
   * 沿用总周数/每日节次/作息，只把开始日期顺延到下学期
   */
  function nextSemesterDefaults(current) {
    var cur = normalizeSettings(current && current.settings);
    var start = nextSemesterStart(current && current.settings);
    return {
      name: defaultSemesterName(start),
      settings: normalizeSettings({
        semesterStart: start,
        totalWeeks: cur.totalWeeks,
        sectionsPerDay: cur.sectionsPerDay,
        showWeekend: cur.showWeekend,
        sectionTimes: cur.sectionTimes
      })
    };
  }

  /**
   * 新增学期（不修改入参）
   * @param form { name, settings, courses }
   */
  function addSemester(ws, form) {
    var sem = normalizeSemester({
      name: form && form.name,
      settings: form && form.settings,
      courses: form && form.courses
    });
    var list = (ws && Array.isArray(ws.semesters)) ? ws.semesters.slice() : [];
    list.push(sem);
    return {
      workspace: { activeId: sem.id, semesters: list },
      semester: sem
    };
  }

  /** 重命名学期；名称为空视为失败 */
  function renameSemester(ws, id, name) {
    var clean = String(name == null ? '' : name).trim();
    if (!clean) return { ok: false, reason: 'empty', workspace: ws };
    if (clean.length > 20) clean = clean.slice(0, 20);
    var hit = false;
    var list = (ws && ws.semesters ? ws.semesters : []).map(function (s) {
      if (s.id !== id) return s;
      hit = true;
      return { id: s.id, name: clean, settings: s.settings, courses: s.courses };
    });
    if (!hit) return { ok: false, reason: 'notfound', workspace: ws };
    return { ok: true, workspace: { activeId: ws.activeId, semesters: list } };
  }

  /**
   * 删除学期；最后一个学期不允许删除（否则工作区为空，页面无法工作）
   * 删掉的若是当前学期，自动切到剩下的第一个
   */
  function removeSemester(ws, id) {
    if (!ws || !Array.isArray(ws.semesters) || !ws.semesters.length) {
      return { ok: false, reason: 'empty', workspace: ws };
    }
    if (ws.semesters.length <= 1) return { ok: false, reason: 'last', workspace: ws };
    var hit = false;
    var list = ws.semesters.filter(function (s) {
      if (s.id === id) { hit = true; return false; }
      return true;
    });
    if (!hit) return { ok: false, reason: 'notfound', workspace: ws };
    var activeId = ws.activeId === id ? list[0].id : ws.activeId;
    return { ok: true, workspace: { activeId: activeId, semesters: list } };
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
    SECTION_TIME_PRESETS: SECTION_TIME_PRESETS,
    getPresetTimes: getPresetTimes,
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
    nowMinutes: nowMinutes,
    courseMinutes: courseMinutes,
    courseProgress: courseProgress,
    nextCourse: nextCourse,
    courseStatus: courseStatus,
    normalizeCourse: normalizeCourse,
    normalizeSettings: normalizeSettings,
    // 考试与自定义事件
    normalizeEvent: normalizeEvent,
    normalizeEvents: normalizeEvents,
    upcomingEvents: upcomingEvents,
    daysUntil: daysUntil,
    countdownTextOf: countdownTextOf,
    EVENT_NAME_MAX: EVENT_NAME_MAX,
    EVENT_NOTE_MAX: EVENT_NOTE_MAX,
    // 多学期（工作区）
    defaultSemesterName: defaultSemesterName,
    normalizeSemester: normalizeSemester,
    normalizeWorkspace: normalizeWorkspace,
    findSemester: findSemester,
    activeSemester: activeSemester,
    nextSemesterStart: nextSemesterStart,
    nextSemesterDefaults: nextSemesterDefaults,
    addSemester: addSemester,
    renameSemester: renameSemester,
    removeSemester: removeSemester,
    weeksText: weeksText,
    buildSampleCourses: buildSampleCourses
  };
});
