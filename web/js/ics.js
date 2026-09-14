/**
 * CourseForge 日历导出（iCalendar / RFC 5545）
 * 纯函数，无 DOM 依赖，浏览器与 Node 通用（UMD）
 *
 * 设计取舍：
 *  - 每门课的每一周各生成一个 VEVENT（展开而非 RRULE）——iOS / 安卓 / Google 日历 / Outlook 全兼容，
 *    单双周、跳周等不规则周次也能精确表达；
 *  - 使用「浮动时间」（不带 Z、不带 TZID），客户端按本机时区解释，正是课表想要的语义，
 *    同时免去 VTIMEZONE 定义的兼容坑；
 *  - 严格遵守 RFC 5545：文本转义（\\ , ; 换行）+ 每行 75 字节折行（按 UTF-8 字节切，不切碎中文）。
 */
(function (root, factory) {
  var CF = (typeof module === 'object' && typeof module.exports === 'object')
    ? require('./core.js')
    : root.CourseForge;
  var api = factory(CF);
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    root.CourseForgeICS = api;
  }
})(typeof self !== 'undefined' ? self : this, function (CF) {
  'use strict';

  var LIMIT = 2000; // 事件数上限，防止超大课表把日历撑爆

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 宽松取 CF：模块缺失时给出明确报错而非静默错值 */
  function core() {
    if (!CF) throw new Error('CourseForgeICS 依赖 core.js');
    return CF;
  }

  /** 'HH:MM' → 'HHMMSS'；非法返回 null */
  function timeCompact(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t));
    if (!m) return null;
    var h = Number(m[1]);
    if (h > 23) return null;
    return pad2(h) + m[2] + '00';
  }

  /** Date + 'HH:MM' → 'YYYYMMDDTHHMMSS'（浮动时间） */
  function dateTimeStamp(date, hhmm) {
    var compact = timeCompact(hhmm);
    if (!compact) return null;
    return date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) + 'T' + compact;
  }

  /** UTC 时间戳（DTSTAMP 用）：YYYYMMDDTHHMMSSZ */
  function utcStamp(date) {
    return date.getUTCFullYear() + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) +
      'T' + pad2(date.getUTCHours()) + pad2(date.getUTCMinutes()) + pad2(date.getUTCSeconds()) + 'Z';
  }

  /** 文本转义：反斜杠 → \\，逗号 → \,，分号 → \;，换行 → \n */
  function escText(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }

  /** 单个码点的 UTF-8 字节数 */
  function utf8Len(code) {
    if (code < 0x80) return 1;
    if (code < 0x800) return 2;
    if (code < 0x10000) return 3;
    return 4;
  }

  /**
   * 按 RFC 5545 折行：每行不超过 75 字节，续行以空格开头。
   * 按 UTF-8 字节数累加切分，绝不在多字节字符（含 emoji 代理对）中间断开。
   */
  function foldLine(line) {
    var max = 75;
    var out = [];
    var cur = '';
    var curBytes = 0;
    var i = 0;
    while (i < line.length) {
      var code = line.charCodeAt(i);
      var ch, bytes;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length &&
          line.charCodeAt(i + 1) >= 0xdc00 && line.charCodeAt(i + 1) <= 0xdfff) {
        // 完整代理对（emoji 等 4 字节字符）：整体取用，绝不切成两半
        ch = line.substr(i, 2);
        bytes = 4;
        i += 2;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        // 落单代理（非法序列）：按 U+FFFD 计 3 字节，避免算出错误宽度
        ch = line.charAt(i);
        bytes = 3;
        i += 1;
      } else {
        ch = line.charAt(i);
        bytes = utf8Len(code);
        i += 1;
      }
      if (curBytes + bytes > max) {
        out.push(cur);
        cur = ' ' + ch;      // 续行以单个空格开头（该空格计入 75 字节配额）
        curBytes = 1 + bytes;
      } else {
        cur += ch;
        curBytes += bytes;
      }
    }
    out.push(cur);
    return out.join('\r\n');
  }

  /** 组装单条 VEVENT 的行数组；时间缺失返回 null */
  function eventLines(course, date, settings, stamp, uid) {
    var c = core();
    var startTime = c.getSectionTime(settings, course.startSection);
    var endTime = c.getSectionTime(settings, course.endSection);
    var dtStart = dateTimeStamp(date, startTime.start);
    var dtEnd = dateTimeStamp(date, endTime.end);
    if (!dtStart || !dtEnd) return null; // 作息时间缺失，跳过该事件（不产生脏数据）

    var descParts = [];
    if (course.teacher) descParts.push('教师：' + course.teacher);
    descParts.push('节次：第 ' + course.startSection + '-' + course.endSection + ' 节');
    descParts.push('周次：' + c.weeksText(course.weeks));
    if (course.note) descParts.push('备注：' + course.note);

    return [
      'BEGIN:VEVENT',
      'UID:' + escText(uid),
      'DTSTAMP:' + stamp,
      'DTSTART:' + dtStart,
      'DTEND:' + dtEnd,
      'SUMMARY:' + escText(course.name),
      course.location ? 'LOCATION:' + escText(course.location) : null,
      'DESCRIPTION:' + escText(descParts.join('；')),
      'BEGIN:VALARM',
      'TRIGGER:-PT10M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + escText('10 分钟后上课：' + course.name),
      'END:VALARM',
      'END:VEVENT'
    ].filter(Boolean);
  }

  /**
   * 生成 ICS 文本
   * @param courses  课程数组（已 normalize）
   * @param settings 设置（需要 semesterStart / sectionTimes）
   * @param options  { now: Date, calendarName: string, skipPast: boolean, limit: number }
   * @returns { text, events, truncated, skipped }
   */
  function buildICS(courses, settings, options) {
    var c = core();
    options = options || {};
    var now = options.now instanceof Date ? options.now : new Date();
    var stamp = utcStamp(now);
    var limit = options.limit || LIMIT;
    var calName = options.calendarName || '课表工坊 CourseForge';

    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CourseForge//Course Timetable//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + escText(calName)
    ];

    var events = 0;
    var skipped = 0;
    var truncated = false;

    var list = (courses || []).slice().sort(function (a, b) {
      return (a.day - b.day) || (a.startSection - b.startSection);
    });

    outer:
    for (var i = 0; i < list.length; i++) {
      var course = list[i];
      var weeks = (course.weeks || []).slice().sort(function (a, b) { return a - b; });
      for (var w = 0; w < weeks.length; w++) {
        var week = weeks[w];
        var monday = c.mondayOfWeek(settings.semesterStart, week);
        if (!monday) { skipped++; continue; }
        var date = c.addDays(monday, course.day - 1);
        // 跳过已过去的日期（可选）
        if (options.skipPast) {
          var endRange = c.courseMinutes ? c.courseMinutes(course, settings) : null;
          if (endRange) {
            var dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
            var courseEndTs = dayStart.getTime() + endRange.end * 60000;
            if (courseEndTs < now.getTime()) continue;
          }
        }
        if (events >= limit) { truncated = true; break outer; }
        var uid = String(course.id || ('course' + i)) + '-w' + week + '@courseforge';
        var ev = eventLines(course, date, settings, stamp, uid);
        if (!ev) { skipped++; continue; }
        for (var k = 0; k < ev.length; k++) lines.push(ev[k]);
        events++;
      }
    }

    lines.push('END:VCALENDAR');
    return {
      text: lines.map(foldLine).join('\r\n') + '\r\n',
      events: events,
      skipped: skipped,
      truncated: truncated
    };
  }

  /** 生成建议文件名：courseforge-20260915.ics */
  function suggestFileName(now) {
    var d = now instanceof Date ? now : new Date();
    return 'courseforge-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.ics';
  }

  return {
    buildICS: buildICS,
    suggestFileName: suggestFileName,
    foldLine: foldLine,
    escText: escText,
    timeCompact: timeCompact,
    LIMIT: LIMIT
  };
});
