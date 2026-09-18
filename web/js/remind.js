/**
 * CourseForge 提醒引擎（纯逻辑 + 极薄的通知适配层）
 *
 * 竞品对标结论：超级课程表 / WakeUp / 小爱课程表 / 时课 / Class Widgets 几乎都把
 * 「课前提醒」当作第一功能，而 CourseForge 之前只把提醒写进导出的 .ics
 * —— 等于要求用户额外装一个日历 App 才能被提醒到，等于没有。
 *
 * 这里补上两件事：
 *   1. 课前提醒（桌面端与网页端共用同一套判定）
 *   2. **调休感知** —— 竞品普遍做得不够好的一件事：放假当天不该响，
 *      调休补课的周末反而该响。数据不联网、由用户本地标记。
 *
 * 两条设计原则：
 *   - 判定逻辑全部是纯函数：输入「课程 + 设置 + 某一时刻」，输出「该弹什么」。
 *     于是可以不依赖真实时钟写测试 —— 提醒类 bug 全都藏在跨天、跨周、
 *     调休、页面休眠这些边界上，靠手点根本点不到。
 *   - 通知只是最外面一层皮。本模块不知道 Notification 是什么，
 *     没有通知权限时由调用方降级成页内提示，判定结果保持一致。
 *
 * 依赖：core.js（浏览器端挂载在 window.CourseForge，Node 端 require）
 */
(function (root, factory) {
  var CF = (typeof module === 'object' && typeof module.exports === 'object')
    ? require('./core.js')
    : root.CourseForge;
  var api = factory(CF);
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    root.CourseForgeRemind = api;
  }
})(typeof self !== 'undefined' ? self : this, function (CF) {
  'use strict';

  // ==================== 调休 / 放假日 ====================
  //
  // settings.days = { 'YYYY-MM-DD': 'off' | 'makeup' }
  //   'off'    放假：当天不上课，提醒与「今日课程」都跳过
  //   'makeup' 调休补课：本该休息的日子照常按星期几上课
  // 刻意不做成「联网拉节假日表」：那需要外部接口、需要维护、
  // 而且各校校历本来就不完全跟着国家法定假日走 —— 让用户点一下更可靠。

  /** 某日的标记：'' | 'off' | 'makeup' */
  function dayMark(settings, dateStr) {
    var days = settings && settings.days;
    if (!days || typeof days !== 'object') return '';
    var v = days[dateStr];
    return (v === 'off' || v === 'makeup') ? v : '';
  }

  /** 切换某日标记；再次传入相同标记表示取消。返回新的 days 对象（不改原对象） */
  function toggleDayMark(settings, dateStr, mark) {
    var out = {};
    var src = (settings && settings.days) || {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    }
    if (!mark || out[dateStr] === mark) delete out[dateStr];
    else out[dateStr] = mark;
    return out;
  }

  /** 清理超出学期范围的标记，避免 days 无限增长（只保留学期内的日期） */
  function pruneDayMarks(settings) {
    var start = CF.parseDate(settings && settings.semesterStart);
    var total = (settings && settings.totalWeeks) || 20;
    if (!start) return (settings && settings.days) || {};
    var from = CF.formatDate(CF.mondayOf(start));
    var to = CF.formatDate(CF.addDays(CF.mondayOf(start), total * 7 - 1));
    var src = (settings && settings.days) || {};
    var out = {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (k >= from && k <= to) out[k] = src[k];
    }
    return out;
  }

  // ==================== 配置 ====================

  var LEAD_CHOICES = [0, 5, 10, 15, 20, 30];

  /**
   * 提醒配置（带兜底）。
   * 默认关闭：开通知要先拿到浏览器的授权，而授权只能由用户点击触发，
   * 所以「默认开着但拿不到权限」只会让人以为功能坏了 —— 不如默认关、给一个明确的开关。
   */
  function remindConfig(settings) {
    var r = (settings && settings.remind) || {};
    var lead = Number(r.lead);
    if (!isFinite(lead) || lead < 0 || lead > 120) lead = 10;
    return { enabled: r.enabled === true, lead: Math.round(lead) };
  }

  function remindSettings(settings, next) {
    var cur = remindConfig(settings);
    var patch = next || {};
    var enabled = patch.enabled === undefined ? cur.enabled : !!patch.enabled;
    var lead = patch.lead === undefined ? cur.lead : Number(patch.lead);
    if (!isFinite(lead) || lead < 0 || lead > 120) lead = cur.lead;
    return { enabled: enabled, lead: Math.round(lead) };
  }

  // ==================== 当日时间线 ====================

  /** 把「当日第几分钟」变成一个具体的 Date（同一天） */
  function atMinutes(now, minutes) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    d.setMinutes(minutes);
    return d;
  }

  /** 周几：1-7（周一=1，周日=7），与课程数据的 day 字段同构 */
  function weekdayOf(date) {
    var d = date.getDay();
    return d === 0 ? 7 : d;
  }

  /**
   * 某一时刻的「今日时间线」。
   *
   * @returns {{
   *   date: string,            // YYYY-MM-DD
   *   weekday: number,         // 1-7
   *   mark: string,            // '' | 'off' | 'makeup'
   *   off: boolean,            // 是否放假（当天不上课）
   *   week: number,            // 学期第几周（放假时也照常给出）
   *   items: Array,            // [{ course, start: Date, end: Date }]，按开始时间升序
   *   current: Object|null,    // 正在上的那节（可能有多节重叠，取最后一节）
   *   next: Object|null,       // 下一节
   *   minutesToNext: number|null
   * }}
   */
  function dayTimeline(courses, settings, now) {
    var s = settings || {};
    var dateStr = CF.formatDate(now);
    var mark = dayMark(s, dateStr);
    var weekday = weekdayOf(now);
    var week = CF.getWeekNumber(s.semesterStart, now);
    var items = [];

    if (mark !== 'off') {
      var list = CF.getDayCourses(courses, week, weekday);
      for (var i = 0; i < list.length; i++) {
        var range = CF.courseMinutes(list[i], s);
        if (!range) continue; // 作息缺失 → 算不出时间，不猜
        items.push({ course: list[i], start: atMinutes(now, range.start), end: atMinutes(now, range.end) });
      }
      items.sort(function (a, b) { return a.start - b.start; });
    }

    var current = null;
    var next = null;
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (it.start <= now && now < it.end) current = it;
      else if (it.start > now && !next) next = it;
    }

    return {
      date: dateStr,
      weekday: weekday,
      mark: mark,
      off: mark === 'off',
      week: week,
      items: items,
      current: current,
      next: next,
      minutesToNext: next ? Math.round((next.start - now) / 60000) : null
    };
  }

  /** 该日期是否放假日 */
  function isDayOff(settings, date) {
    return dayMark(settings, CF.formatDate(date)) === 'off';
  }

  // ==================== 提醒判定 ====================

  /**
   * 迟到容忍窗口（分钟）。
   *
   * 没有它就会出现一个很难受的现象：用户在 13:59 打开页面，而下一节课 14:00 开始，
   * 定时器第一次 tick 落在 14:00:30 —— 按「必须正好命中」的判定，
   * 这条提醒就永远丢了。浏览器切到后台被节流、笔记本合盖再打开，都会造成同样的错位。
   * 所以「上课提醒」允许在触发后 5 分钟内补弹，而不是苛刻地对齐到分秒。
   */
  var GRACE_MIN = 5;

  /** 提醒文案；settings 必须传真实作息，否则时间会退回通用预设、和用户实际课表对不上 */
  function alertText(kind, item, minutesLeft, settings) {
    var c = item.course;
    var where = [];
    if (c.location) where.push(c.location);
    if (c.teacher) where.push(c.teacher);
    var tail = where.length ? ' · ' + where.join(' · ') : '';
    var range = CF.sectionRangeText(settings, c);
    var note = c.note ? '（' + c.note + '）' : '';
    if (kind === 'before') {
      return {
        title: (minutesLeft > 0 ? minutesLeft + ' 分钟后上课：' : '马上上课：') + (c.name || '课程'),
        body: range + tail + note
      };
    }
    return {
      title: '现在上课：' + (c.name || '课程'),
      body: range + tail + note
    };
  }

  /**
   * 算出「这一时刻该弹哪些提醒」。
   *
   * @param courses  课程列表
   * @param settings 设置（含 days / remind）
   * @param now      当前时刻
   * @param fired    已弹过的 key 集合（{ key: 1 }），由调用方跨 tick 维护
   * @returns [{ key, kind, course, at, minutesLeft, title, body }]
   *
   * key 里带日期与课程 id —— 于是「明天同一门课」会重新弹，
   * 而「同一节课的提前提醒和准点提醒」各自独立、互不顶掉。
   */
  function pendingAlerts(courses, settings, now, fired) {
    var out = [];
    var cfg = remindConfig(settings);
    if (!cfg.enabled) return out;

    var tl = dayTimeline(courses, settings, now);
    if (tl.off) return out; // 放假日不提醒
    var seen = fired || {};

    for (var i = 0; i < tl.items.length; i++) {
      var it = tl.items[i];
      var m = (it.start - now) / 60000; // 距上课的分钟数，负数表示已开始
      var cid = (it.course && it.course.id) || (it.course && it.course.name) || 'x';
      var base = tl.date + '|' + cid + '|';

      // ① 课前提醒：落在 (0, lead] 区间内
      if (cfg.lead > 0 && m > 0 && m <= cfg.lead) {
        var kb = base + 'before';
        if (!seen[kb]) {
          var t1 = alertText('before', it, Math.round(m), settings);
          out.push({
            key: kb, kind: 'before', course: it.course, at: it.start,
            minutesLeft: Math.round(m), title: t1.title, body: t1.body
          });
        }
      }

      // ② 上课提醒：落在 [-GRACE, 0] 区间内
      if (m <= 0 && m >= -GRACE_MIN) {
        var ka = base + 'at';
        if (!seen[ka]) {
          var t2 = alertText('at', it, 0, settings);
          out.push({
            key: ka, kind: 'at', course: it.course, at: it.start,
            minutesLeft: 0, title: t2.title, body: t2.body
          });
        }
      }
    }
    return out;
  }

  /** 丢掉非当日的已弹记录，避免 fired 越滚越大 */
  function pruneFired(fired, dateStr) {
    var out = {};
    var src = fired || {};
    var prefix = dateStr + '|';
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k) && k.indexOf(prefix) === 0) out[k] = 1;
    }
    return out;
  }

  /**
   * 跑一轮检查：算出该弹的提醒 → 交给 sender 发出 → 回报新的已弹集合。
   * 逻辑层不碰 Notification，sender 由调用方注入（测试里就是往数组里 push）。
   *
   * @returns {{ alerts: Array, fired: Object, timeline: Object }}
   */
  function runTick(state, now, sender) {
    var s = state || {};
    var tl = dayTimeline(s.courses, s.settings, now);
    var fired = pruneFired(s.fired, tl.date);
    var alerts = pendingAlerts(s.courses, s.settings, now, fired);
    for (var i = 0; i < alerts.length; i++) {
      fired[alerts[i].key] = 1;
      if (typeof sender === 'function') sender(alerts[i]);
    }
    return { alerts: alerts, fired: fired, timeline: tl };
  }

  // ==================== 跨天查找（桌面托盘 / 挂件用） ====================

  /**
   * 从此刻往后找「下一次要上的课」，可以跨天、跨周，最多找 maxDays 天。
   *
   * @returns {{ daysAhead: number, date: string, item: Object }|null}
   *   daysAhead = 0 表示就是今天接下来的课
   */
  function nextUpcoming(courses, settings, now, maxDays) {
    var limit = (maxDays == null) ? 14 : Math.max(0, Math.round(maxDays));
    for (var d = 0; d <= limit; d++) {
      var day = CF.addDays(now, d);
      // 未来的那天要用「当天 0 点」当探针：这样所有课都还没开始，
      // 直接取第一节即可；用 now 去探会得到「今天已过的课被跳过」的错觉
      var probe = (d === 0)
        ? now
        : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
      var tl = dayTimeline(courses, settings, probe);
      for (var i = 0; i < tl.items.length; i++) {
        if (tl.items[i].start > now) {
          return { daysAhead: d, date: tl.date, mark: tl.mark, item: tl.items[i] };
        }
      }
    }
    return null;
  }

  /**
   * 「下一次课」的一行摘要（托盘提示、悬浮窗、今日面板共用同一份口径，
   * 避免三个地方各写一份、改一处漏两处）。
   */
  function upcomingSummary(hit, settings, now) {
    if (!hit) return '接下来 14 天没有课';
    var c = hit.item.course;
    var dayText = hit.daysAhead === 0 ? '今天'
      : (hit.daysAhead === 1 ? '明天' : CF.DAY_NAMES[weekdayOf(hit.item.start) - 1]);
    var head = dayText + ' ' + hhmm(hit.item.start) + ' ' + (c.name || '课程');
    var tail = [];
    if (c.location) tail.push(c.location);
    if (hit.daysAhead === 0 && now) {
      var mins = Math.round((hit.item.start - now) / 60000);
      if (mins > 0) tail.push('还有 ' + mins + ' 分钟');
    }
    return head + (tail.length ? ' · ' + tail.join(' · ') : '');
  }

  function hhmm(d) {
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // ==================== 考试提醒（P3 补强） ====================
  //
  // 上课提醒管「今天的课」，考试提醒管「最近几天里的大事」——
  // 两条时间线，共用同一套判定哲学：纯函数输入输出，通知只是一层皮。
  // 每天每条最多提醒一次；去重记录由**调用方**持久化（网页端 localStorage、
  // 桌面端偏好文件），本模块不知道存储是什么。

  /** 'YYYY-MM-DD' → 本地零点；解析失败返回 null（和 core.parseDate 同规则，但本模块不依赖它） */
  function parseDayKey(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  /** 自然日差：同一天 0、明天 1；日期不合法返回 null */
  function dayDiff(fromKey, toKey) {
    var a = parseDayKey(fromKey);
    var b = parseDayKey(toKey);
    if (!a || !b) return null;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  /**
   * 今天该弹的考试/事件提醒。
   * @param {Array} events  当前学期的事件（原始结构即可，字段不合法的自动跳过）
   * @param {Date}  now     此刻
   * @param {object} notifiedMap  已通知记录 { [eventId]: 'YYYY-MM-DD' }，调用方持久化
   * @param {number} [leadDays]   提前几天开始提醒，默认 7
   * @returns {Array} 每项 {id, name, kind, daysLeft, title, body, key, notifiedKey}
   *          key 用于通知 tag 去重（同一天同一条只弹一个气泡），
   *          notifiedKey 是今天的日期键 —— 调用方把它写进 notifiedMap 就完成「今天已提醒」。
   */
  function dueExamAlerts(events, now, notifiedMap, leadDays) {
    var lead = (typeof leadDays === 'number' && isFinite(leadDays) && leadDays >= 0) ? Math.floor(leadDays) : 7;
    var map = (notifiedMap && typeof notifiedMap === 'object' && !Array.isArray(notifiedMap)) ? notifiedMap : {};
    var today = now instanceof Date ? now : new Date();
    var todayKey = (today.getFullYear()) + '-' +
      (today.getMonth() + 1 < 10 ? '0' : '') + (today.getMonth() + 1) + '-' +
      (today.getDate() < 10 ? '0' : '') + today.getDate();

    var list = Array.isArray(events) ? events : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev || typeof ev !== 'object') continue;
      var name = String(ev.name == null ? '' : ev.name).trim();
      if (!name) continue;
      var left = dayDiff(todayKey, ev.date);
      if (left == null || left < 0 || left > lead) continue;
      if (map[ev.id] === todayKey) continue;   // 今天已经提醒过这条

      var isExam = ev.kind === 'exam';
      var whenText = left === 0 ? '今天' : (left === 1 ? '明天' : left + ' 天后');
      out.push({
        id: String(ev.id || ''),
        name: name,
        kind: isExam ? 'exam' : 'custom',
        daysLeft: left,
        title: isExam
          ? (left === 0 ? '今天有考试' : '考试临近')
          : (left === 0 ? '今天有日程' : '日程临近'),
        body: name + ' · ' + whenText + (ev.time ? ' ' + String(ev.time) : ''),
        key: 'exam:' + ev.id + ':' + todayKey,
        notifiedKey: todayKey
      });
    }
    // 最近的在前：弹通知的顺序和用户处理事情的顺序一致
    out.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
    return out;
  }

  return {
    LEAD_CHOICES: LEAD_CHOICES,
    GRACE_MIN: GRACE_MIN,

    dayMark: dayMark,
    toggleDayMark: toggleDayMark,
    pruneDayMarks: pruneDayMarks,
    isDayOff: isDayOff,

    remindConfig: remindConfig,
    remindSettings: remindSettings,

    atMinutes: atMinutes,
    weekdayOf: weekdayOf,
    dayTimeline: dayTimeline,

    alertText: alertText,
    pendingAlerts: pendingAlerts,
    pruneFired: pruneFired,
    runTick: runTick,

    nextUpcoming: nextUpcoming,
    upcomingSummary: upcomingSummary,
    dueExamAlerts: dueExamAlerts,
    dayDiff: dayDiff,
    hhmm: hhmm
  };
});
