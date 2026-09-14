/**
 * CourseForge 渲染层（纯函数：数据 → HTML 字符串）
 * 规则：
 *  - 不直接操作 DOM、不绑定事件、不读写存储
 *  - 渲染函数之间只允许单向组合（如 renderGrid 内部拼卡片），严禁互相调用形成环
 *  - 所有用户数据输出必须经过 esc() 转义
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
    root.CourseRender = api;
  }
})(typeof self !== 'undefined' ? self : this, function (CF) {
  'use strict';

  // ==================== 基础 ====================

  /** HTML 转义（所有用户数据输出前必经） */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 内联 SVG 图标（严禁用 emoji 当图标） */
  var ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    left: '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
    edit: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 3 21l.5-4.5L17 3z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    calendarDown: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 13v5M9.5 15.5L12 18l2.5-2.5"/>'
  };

  function icon(name, size) {
    size = size || 16;
    return '<svg class="icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  /** 按key取预设色，非法 key 回落到第一个 */
  function colorOf(key) {
    var colors = CF.COURSE_COLORS;
    for (var i = 0; i < colors.length; i++) {
      if (colors[i].key === key) return colors[i];
    }
    return colors[0];
  }

  /**
   * 颜色的 CSS 表达式：优先取主题变量（深色主题会覆盖 --c-xxx-bg / --c-xxx-main），
   * 未定义时回落到浅色预设值 → 一套 HTML 同时适配明暗两套主题
   */
  function colorVars(key) {
    var c = colorOf(key);
    return {
      key: c.key,
      name: c.name,
      bg: 'var(--c-' + c.key + '-bg, ' + c.bg + ')',
      main: 'var(--c-' + c.key + '-main, ' + c.main + ')'
    };
  }

  /** 'HH:MM' 文本（当前时间显示用） */
  function hhmm(date) {
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(date.getHours()) + ':' + p(date.getMinutes());
  }

  /** 分钟数 → '35 分钟' / '1 小时 5 分钟' */
  function humanMin(min) {
    if (min == null) return '';
    if (min < 60) return min + ' 分钟';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return h + ' 小时' + (m ? ' ' + m + ' 分钟' : '');
  }

  /** JS Date 星期（0=周日）→ 业务星期（1=周一 … 7=周日） */
  function businessDay(date) {
    var d = date.getDay();
    return d === 0 ? 7 : d;
  }

  /** 当前设置下可见的星期数：关闭「显示周末」后只渲染周一到周五 */
  function visibleDays(settings) {
    return (settings && settings.showWeekend === false) ? 5 : 7;
  }

  // ==================== 周导航 ====================

  /** 周/月日期文本：'9.14' */
  function md(date) {
    return (date.getMonth() + 1) + '.' + date.getDate();
  }

  function renderWeekNav(displayWeek, settings, realWeek, semesterName) {
    var total = settings.totalWeeks;
    var mon = CF.mondayOfWeek(settings.semesterStart, displayWeek);
    var rangeText = mon ? md(mon) + ' - ' + md(CF.addDays(mon, visibleDays(settings) - 1)) : '';
    var isReal = displayWeek === realWeek;
    var html = '';
    html += '<div class="week-nav">';
    html += '<button class="btn btn-icon" data-action="prev-week" title="上一周" aria-label="上一周">' + icon('left') + '</button>';
    html += '<div class="week-label">';
    html += '<strong>第 ' + displayWeek + ' 周</strong>';
    html += '<span class="muted">' + esc(rangeText) + '</span>';
    if (isReal) html += '<span class="chip chip-brand">本周</span>';
    if (semesterName) html += '<span class="chip sem-chip" title="当前学期">' + esc(semesterName) + '</span>';
    html += '</div>';
    html += '<button class="btn btn-icon" data-action="next-week" title="下一周" aria-label="下一周">' + icon('right') + '</button>';
    html += '<button class="btn btn-ghost" data-action="this-week"' + (isReal ? ' disabled' : '') + '>回到本周</button>';
    html += '<span class="muted week-total">/ 共 ' + total + ' 周</span>';
    html += '</div>';
    return html;
  }

  // ==================== 今日课程 ====================

  var STATUS_TEXT = { before: '未开始', now: '进行中', done: '已结束' };

  function renderToday(courses, week, settings, now) {
    var html = '';
    var todayDay = businessDay(now);
    var dateText = (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + CF.DAY_NAMES[todayDay - 1];

    html += '<div class="today-head">';
    html += '<span class="today-title">' + icon('clock') + '今天 · ' + esc(dateText) + '</span>';
    html += '<span class="today-clock" title="每分钟自动刷新">' + esc(hhmm(now)) + '</span>';
    if (week >= 1 && week <= settings.totalWeeks) {
      html += '<span class="chip">第 ' + week + ' 周</span>';
    }
    html += '</div>';

    // 学期未开始 / 已结束
    if (week < 1) {
      html += '<div class="today-empty">学期还未开始（第 ' + week + ' 周），可在「设置」中调整学期开始日期。</div>';
      return html;
    }
    if (week > settings.totalWeeks) {
      html += '<div class="today-empty">本学期已结束，好好休息！可在「设置」中新建学期。</div>';
      return html;
    }

    var list = CF.getDayCourses(courses, week, todayDay);
    if (!list.length) {
      html += '<div class="today-empty">今天没有课，好好安排自己的时间吧！</div>';
      return html;
    }

    // 实时提示条：下一节课倒计时 / 当前节次 / 今日结束
    var next = CF.nextCourse(list, now, settings);
    var curSection = CF.getCurrentSection(now, settings);
    html += '<div class="today-live">';
    if (next) {
      html += icon('right', 14) + '<span>下一节 <b>' + esc(next.course.name) + '</b> · ' + esc(next.startTime) + ' 开始 · 还有 <b>' + humanMin(next.startInMin) + '</b></span>';
    } else if (curSection > 0) {
      html += icon('clock', 14) + '<span>第 ' + curSection + ' 节进行中</span>';
    } else {
      html += icon('clock', 14) + '<span>今天的课都上完了，收工！</span>';
    }
    html += '</div>';

    html += '<div class="today-cards">';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var status = CF.courseStatus(c, now, settings);
      var prog = CF.courseProgress(c, now, settings);
      var color = colorVars(c.color);
      html += '<div class="today-card status-' + status + '" data-color="' + esc(color.key) + '" style="border-left-color:' + color.main + '">';
      html += '<div class="tc-time">' + esc(CF.sectionRangeText(settings, c)) + '</div>';
      html += '<div class="tc-name">' + esc(c.name) + '</div>';
      html += '<div class="tc-sub">' + esc(c.location || '未填写教室') + (c.teacher ? ' · ' + esc(c.teacher) : '') + '</div>';
      if (status === 'now' && prog.state === 'now') {
        html += '<div class="tc-progress" role="progressbar" aria-valuenow="' + prog.percent + '" aria-valuemin="0" aria-valuemax="100" aria-label="上课进度"><span style="width:' + prog.percent + '%"></span></div>';
        html += '<div class="tc-tip">已上 ' + prog.percent + '% · 还剩 <b>' + humanMin(prog.remainMin) + '</b></div>';
      } else if (status === 'before' && prog.startInMin != null) {
        html += '<div class="tc-tip">还有 <b>' + humanMin(prog.startInMin) + '</b>开始</div>';
      }
      html += '<span class="status-chip st-' + status + '">' + STATUS_TEXT[status] + '</span>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ==================== 统计栏 ====================

  function renderStats(courses, week, settings) {
    var totalSections = 0;
    var courseSet = {};
    var day;
    for (day = 1; day <= visibleDays(settings); day++) {
      var list = CF.getDayCourses(courses, week, day);
      for (var i = 0; i < list.length; i++) {
        totalSections += list[i].endSection - list[i].startSection + 1;
        courseSet[list[i].id] = true;
      }
    }
    // 隐藏周末时，统计被折叠掉的周末课程数并显式提示，避免「课不见了」的误判
    var hiddenWeekend = 0;
    if (visibleDays(settings) < 7) {
      for (var d2 = 6; d2 <= 7; d2++) hiddenWeekend += CF.getDayCourses(courses, week, d2).length;
    }
    var conflicts = CF.detectConflicts(courses, week).length;

    var html = '<div class="stats">';
    html += '<span class="stat-item">本周 <b>' + totalSections + '</b> 节课</span>';
    html += '<span class="stat-item"><b>' + Object.keys(courseSet).length + '</b> 门课程</span>';
    if (hiddenWeekend > 0) {
      html += '<span class="chip chip-warn">周末还有 ' + hiddenWeekend + ' 门课被隐藏</span>';
    }
    if (conflicts > 0) {
      html += '<span class="chip chip-danger">本周 ' + conflicts + ' 处时间冲突</span>';
    }
    if (courses.length >= 30) {
      html += '<span class="chip chip-warn">数据已积累 ' + courses.length + ' 条，建议导出备份</span>';
    }
    html += '</div>';
    return html;
  }

  // ==================== 周视图网格 ====================

  function renderCourseCard(course, settings, rows) {
    var color = colorVars(course.color);
    // 显示时夹在有效节次范围内，防止越界出格
    var start = Math.min(course.startSection, rows);
    var end = Math.min(course.endSection, rows);
    if (end < start) end = start;
    var top = 'calc(var(--row-h) * ' + (start - 1) + ' + 2px)';
    var height = 'calc(var(--row-h) * ' + (end - start + 1) + ' - 6px)';
    var titleParts = [course.name, CF.sectionRangeText(settings, course), course.location, course.teacher, CF.weeksText(course.weeks)];
    var html = '';
    html += '<div class="cf-card" data-id="' + esc(course.id) + '" data-color="' + esc(color.key) + '" style="top:' + top + ';height:' + height + ';background:' + color.bg + ';border-left-color:' + color.main + '" title="' + esc(titleParts.filter(Boolean).join(' | ')) + '">';
    html += '<div class="cf-card-name">' + esc(course.name) + '</div>';
    html += '<div class="cf-card-sub">' + esc(course.location || '') + '</div>';
    html += '</div>';
    return html;
  }

  function renderGrid(courses, displayWeek, settings, now) {
    var rows = settings.sectionsPerDay;
    var dayCount = visibleDays(settings);
    var todayDay = businessDay(now);
    var mon = CF.mondayOfWeek(settings.semesterStart, displayWeek);
    // 列数随「显示周末」变化：直接算好轨道串内联，避免依赖 CSS 变量参与 repeat() 的兼容性
    var gridCols = 'grid-template-columns:var(--time-w) repeat(' + dayCount + ',minmax(96px,1fr))';

    var html = '';
    html += '<div class="cf-scroll"><div class="cf-inner">';

    // 表头：星期 + 日期
    html += '<div class="cf-gridhead" style="' + gridCols + '">';
    html += '<div class="cf-corner"></div>';
    for (var d = 1; d <= dayCount; d++) {
      var date = mon ? CF.addDays(mon, d - 1) : null;
      html += '<div class="cf-dayhead' + (d === todayDay ? ' cf-today' : '') + '">';
      html += '<span>' + CF.DAY_NAMES[d - 1] + '</span>';
      if (date) html += '<small>' + md(date) + '</small>';
      html += '</div>';
    }
    html += '</div>';

    // 主体
    html += '<div class="cf-gridbody" style="--rows:' + rows + ';' + gridCols + '">';

    // 时间列
    html += '<div class="cf-timecol">';
    for (var s = 1; s <= rows; s++) {
      var t = CF.getSectionTime(settings, s);
      html += '<div class="cf-time"><b>' + esc(t.label || s) + '</b>' + (t.start ? '<small>' + esc(t.start) + '</small>' : '') + '</div>';
    }
    html += '</div>';

    // 星期列（默认 7 列，关闭周末后 5 列）
    for (var day = 1; day <= dayCount; day++) {
      html += '<div class="cf-daycol">';
      // 空白格子（点击添加课程）
      for (var sec = 1; sec <= rows; sec++) {
        html += '<div class="cf-cell" data-day="' + day + '" data-section="' + sec + '" style="top:calc(var(--row-h) * ' + (sec - 1) + ')" title="添加课程"></div>';
      }
      // 课程卡片
      var list = CF.getDayCourses(courses, displayWeek, day);
      for (var i = 0; i < list.length; i++) {
        html += renderCourseCard(list[i], settings, rows);
      }
      html += '</div>';
    }

    html += '</div>'; // cf-gridbody
    html += '</div></div>'; // cf-inner / cf-scroll
    return html;
  }

  // ==================== 列表视图 ====================

  function renderList(courses, displayWeek, settings) {
    var html = '';
    var hasAny = false;
    var dayCount = visibleDays(settings);
    var mon = CF.mondayOfWeek(settings.semesterStart, displayWeek);
    for (var day = 1; day <= dayCount; day++) {
      var list = CF.getDayCourses(courses, displayWeek, day);
      if (list.length) hasAny = true;
      var date = mon ? CF.addDays(mon, day - 1) : null;
      html += '<section class="list-day">';
      html += '<h3>' + CF.DAY_NAMES[day - 1] + (date ? '<small class="muted"> ' + md(date) + '</small>' : '') + '</h3>';
      if (!list.length) {
        html += '<div class="list-empty">无课</div>';
      } else {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          var color = colorVars(c.color);
          html += '<div class="list-row" data-color="' + esc(color.key) + '" style="border-left-color:' + color.main + '">';
          html += '<div class="lr-main">';
          html += '<div class="lr-time">' + esc(CF.sectionRangeText(settings, c)) + ' <small>第' + c.startSection + '-' + c.endSection + '节</small></div>';
          html += '<div class="lr-name">' + esc(c.name) + '</div>';
          html += '<div class="lr-sub">' + esc(c.location || '未填写教室') + (c.teacher ? ' · ' + esc(c.teacher) : '') + '</div>';
          if (c.note) html += '<div class="lr-note">' + esc(c.note) + '</div>';
          html += '</div>';
          html += '<div class="lr-side">';
          html += '<span class="lr-weeks">' + esc(CF.weeksText(c.weeks)) + '</span>';
          html += '<span class="lr-actions">';
          html += '<button class="btn btn-icon" data-action="edit-course" data-id="' + esc(c.id) + '" title="编辑" aria-label="编辑">' + icon('edit', 14) + '</button>';
          html += '<button class="btn btn-icon btn-danger-icon" data-action="delete-course" data-id="' + esc(c.id) + '" title="删除" aria-label="删除">' + icon('trash', 14) + '</button>';
          html += '</span>';
          html += '</div>';
          html += '</div>';
        }
      }
      html += '</section>';
    }
    if (!hasAny) {
      html = '<div class="big-empty">' + icon('calendar', 36) + '<p>本周暂无课程</p><button class="btn btn-primary" data-action="add-course">' + icon('plus') + '添加课程</button></div>';
    }
    return html;
  }

  // ==================== 课程表单（弹窗内的动态部分） ====================

  /** 周次选择网格（checkbox 按钮组） */
  function renderWeeksGrid(selectedWeeks, totalWeeks) {
    totalWeeks = Math.max(1, totalWeeks || 1);
    var sel = {};
    for (var i = 0; i < selectedWeeks.length; i++) sel[selectedWeeks[i]] = true;
    var html = '';
    for (var w = 1; w <= totalWeeks; w++) {
      html += '<button type="button" class="week-btn' + (sel[w] ? ' active' : '') + '" data-week="' + w + '">' + w + '</button>';
    }
    return html;
  }

  /** 单双周快捷按钮组 */
  function renderParityButtons() {
    return '<button type="button" class="btn btn-ghost" data-action="parity-all">全周</button>' +
      '<button type="button" class="btn btn-ghost" data-action="parity-odd">单周</button>' +
      '<button type="button" class="btn btn-ghost" data-action="parity-even">双周</button>';
  }

  /** 颜色选择器 */
  function renderColorSwatches(selected) {
    var colors = CF.COURSE_COLORS;
    var html = '';
    for (var i = 0; i < colors.length; i++) {
      var c = colors[i];
      html += '<button type="button" class="swatch' + (c.key === selected ? ' active' : '') + '" data-color="' + c.key + '" style="background:' + c.bg + ';border-color:' + c.main + '" title="' + esc(c.name) + '" aria-label="' + esc(c.name) + '"><span style="background:' + c.main + '"></span></button>';
    }
    return html;
  }

  /** 冲突确认文案 */
  function clashConfirmText(course, clashes) {
    var lines = ['注意：'];
    for (var i = 0; i < clashes.length; i++) {
      var cl = clashes[i];
      lines.push('《' + course.name + '》与《' + cl.other.name + '》在 ' + CF.weeksText(cl.weeks) + ' 时间冲突');
    }
    lines.push('仍要保存吗？');
    return lines.join('\n');
  }

  // ==================== 多学期 ====================

  /** 学期开始日期摘要：'2026-09-14' → '9.14 开学' */
  function startBrief(semesterStart) {
    var d = CF.parseDate(semesterStart);
    if (!d) return '未设置开学日期';
    return (d.getMonth() + 1) + '.' + d.getDate() + ' 开学';
  }

  /**
   * 学期列表（设置抽屉内）
   * 当前学期显示「当前」标记，其余项提供「切换」按钮
   */
  function renderSemesterList(semesters, activeId) {
    var list = Array.isArray(semesters) ? semesters : [];
    if (!list.length) return '<div class="hint">暂无学期</div>';
    var html = '<div class="sem-list">';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var isActive = s.id === activeId;
      html += '<div class="sem-row' + (isActive ? ' sem-active' : '') + '" data-id="' + esc(s.id) + '">';
      html += '<div class="sem-main">';
      html += '<span class="sem-name">' + esc(s.name || ('学期 ' + (i + 1))) + '</span>';
      html += '<span class="sem-meta">' + esc(startBrief(s.settings && s.settings.semesterStart)) +
        ' · ' + ((s.settings && s.settings.totalWeeks) || 0) + ' 周 · ' +
        ((s.courses && s.courses.length) || 0) + ' 门课</span>';
      html += '</div>';
      html += '<div class="sem-actions">';
      if (isActive) {
        html += '<span class="chip chip-brand">当前</span>';
      } else {
        html += '<button type="button" class="btn btn-ghost" data-action="switch-semester" data-id="' + esc(s.id) + '">切换</button>';
      }
      html += '<button type="button" class="btn btn-icon" data-action="rename-semester" data-id="' + esc(s.id) + '" title="重命名" aria-label="重命名">' + icon('edit', 14) + '</button>';
      html += '<button type="button" class="btn btn-icon btn-danger-icon" data-action="delete-semester" data-id="' + esc(s.id) + '" title="删除学期" aria-label="删除学期">' + icon('trash', 14) + '</button>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ==================== 导出 ====================

  return {
    esc: esc,
    icon: icon,
    colorOf: colorOf,
    colorVars: colorVars,
    hhmm: hhmm,
    humanMin: humanMin,
    businessDay: businessDay,
    visibleDays: visibleDays,
    renderWeekNav: renderWeekNav,
    renderToday: renderToday,
    renderStats: renderStats,
    renderGrid: renderGrid,
    renderList: renderList,
    renderWeeksGrid: renderWeeksGrid,
    renderParityButtons: renderParityButtons,
    renderColorSwatches: renderColorSwatches,
    clashConfirmText: clashConfirmText,
    startBrief: startBrief,
    renderSemesterList: renderSemesterList
  };
});
