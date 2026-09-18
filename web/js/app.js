/**
 * CourseForge 调度层
 * 职责：初始化、状态管理、事件绑定、统一刷新入口 refreshAll()
 * 铁律：渲染函数之间严禁互调；所有联动 = 改数据 → refreshAll()
 * 依赖：core.js（CF）、render.js（CR）、storage.js（ST）
 */
(function () {
  'use strict';

  var CF = window.CourseForge;
  var CR = window.CourseRender;
  var ST = window.CourseStorage;
  var CI = window.CourseImporter;
  var ICS = window.CourseForgeICS;
  var SI = window.CourseForgeShare;
  var RM = window.CourseForgeRemind;

  // 桌面端「常驻小组件」开关的重新同步函数；网页版恒为 null。
  // 开关状态的真身在主进程（托盘菜单也能改），所以每次打开设置抽屉都要重读一次，
  // 否则用户从托盘改了显隐、再打开设置会看到过期的勾选状态。
  var desktopWidgetResync = null;

  if (!CF || !CR || !ST) {
    // 依赖缺失属于致命错误，直接提示而不是白屏
    document.addEventListener('DOMContentLoaded', function () {
      var el = document.getElementById('mainView');
      if (el) el.innerHTML = '<div class="big-empty"><p>页面资源加载失败，请刷新重试。</p></div>';
    });
    return;
  }

  // ==================== 状态 ====================

  var state = {
    semesters: [],      // 全部学期（含当前）；当前学期的 courses/settings 由 persist() 同步进来
    activeId: null,     // 当前学期 id
    courses: [],        // 当前学期课程（工作副本，已 normalize）
    settings: null,     // 当前学期设置（已 normalize）
    displayWeek: 1,     // 当前展示周
    view: 'week',       // 'week' | 'list'
    editingId: null,    // 弹窗正在编辑的课程 id（null = 新增）
    draftWeeks: [],     // 弹窗当前选中的周次
    draftColor: 'blue', // 弹窗当前选中颜色
    themeMode: 'system', // 'system' | 'light' | 'dark'
    share: {            // 分享图弹窗的选项（不落盘：一次性操作，没必要记）
      scope: 'current', // 'current' 只看本周 | 'all' 全部周次
      theme: 'auto'     // 'auto' 跟随应用主题 | 'light' | 'dark'
    }
  };

  /** 取当前学期对象（找不到返回 null） */
  function activeSemesterObj() {
    for (var i = 0; i < state.semesters.length; i++) {
      if (state.semesters[i].id === state.activeId) return state.semesters[i];
    }
    return null;
  }

  /** 当前学期名称（用于界面展示） */
  function activeName() {
    var s = activeSemesterObj();
    return s ? s.name : '';
  }

  /** 真实日期对应的学期周次 */
  function realWeek() {
    return CF.getWeekNumber(state.settings.semesterStart, new Date());
  }

  /** 夹取到合法周次范围 */
  function clampWeek(w) {
    var total = state.settings.totalWeeks;
    if (!w || w < 1) w = 1;
    if (w > total) w = total;
    return w;
  }

  function findCourse(id) {
    for (var i = 0; i < state.courses.length; i++) {
      if (state.courses[i].id === id) return state.courses[i];
    }
    return null;
  }

  /**
   * 持久化整个工作区（schema v2）
   * 关键：先把工作副本回写进当前学期，再整体存盘 —— 这样「切换/新建学期的瞬间」不会丢当前进度
   */
  function persist() {
    var cur = activeSemesterObj();
    if (cur) {
      cur.courses = state.courses;
      cur.settings = state.settings;
    }
    ST.save({ version: 2, activeId: state.activeId, semesters: state.semesters });
    pushToDesktop();
  }

  /**
   * 把课表快照推给桌面端主进程（托盘提示与常驻小组件都靠它）。
   *
   * 挂在 persist() 里是因为那是所有数据变更的唯一收口 ——
   * 改课、切学期、改设置、导入，最后都会走到这里，不会漏。
   * 网页版没有这座桥，直接跳过；推送失败也绝不能影响主流程（课表存不存得下
   * 跟托盘显示无关），所以整段包了 try，异步失败只 warn。
   */
  function pushToDesktop() {
    var d = window.CourseForgeDesktop;
    if (!d || !d.shell || typeof d.shell.push !== 'function') return;
    var res = null;
    try {
      res = d.shell.push({
        version: 2,
        activeId: state.activeId,
        semesters: state.semesters
      });
    } catch (e) {
      return; // 桥不可用：当作网页版处理
    }
    if (res && typeof res.then === 'function') {
      res.then(function (r) {
        if (!r || r.ok !== true) {
          console.warn('[CourseForge] 桌面外壳没接受课表快照，托盘可能显示旧数据');
        }
      }, function () { /* 主进程还没就绪，下次 persist 会再推一次 */ });
    }
  }

  /**
   * 把某个学期装载成当前工作副本
   * 注意：调用前必须已 persist()，否则当前学期的改动会丢
   */
  function loadSemester(id, keepWeek) {
    var target = null;
    for (var i = 0; i < state.semesters.length; i++) {
      if (state.semesters[i].id === id) target = state.semesters[i];
    }
    if (!target) return false;
    state.activeId = target.id;
    state.courses = target.courses.map(CF.normalizeCourse);
    state.settings = CF.normalizeSettings(target.settings);
    state.displayWeek = keepWeek ? clampWeek(state.displayWeek) : clampWeek(realWeek());
    return true;
  }

  // ==================== 统一刷新入口 ====================

  /** 只重绘「今日课程」面板（实时倒计时用，避免整页重排打断用户操作） */
  function refreshLive() {
    var el = document.getElementById('todayPanel');
    if (el) el.innerHTML = CR.renderToday(state.courses, realWeek(), state.settings, new Date());
  }

  function refreshAll() {
    var el;

    el = document.getElementById('weekNav');
    if (el) el.innerHTML = CR.renderWeekNav(state.displayWeek, state.settings, realWeek(), activeName());

    el = document.getElementById('statsBar');
    if (el) el.innerHTML = CR.renderStats(state.courses, state.displayWeek, state.settings);

    refreshLive();

    var main = document.getElementById('mainView');
    if (main) {
      main.innerHTML = (state.view === 'week')
        ? CR.renderGrid(state.courses, state.displayWeek, state.settings, new Date())
        : CR.renderList(state.courses, state.displayWeek, state.settings);
    }

    // 视图切换按钮高亮
    var bw = document.getElementById('btnViewWeek');
    var bl = document.getElementById('btnViewList');
    if (bw) bw.classList.toggle('active', state.view === 'week');
    if (bl) bl.classList.toggle('active', state.view === 'list');

    // 示例课程清理按钮显隐
    var hasDemo = state.courses.some(function (c) { return String(c.id).indexOf('demo_') === 0; });
    var bcs = document.getElementById('btnClearSample');
    if (bcs) bcs.hidden = !hasDemo;

    // 学期列表（设置抽屉内）
    var semList = document.getElementById('semesterList');
    if (semList) semList.innerHTML = CR.renderSemesterList(state.semesters, state.activeId);

    // 考试与事件倒计时条（最近 3 条；没有则整条隐藏）
    renderEventsBar();
  }

  // ==================== 课程弹窗 ====================

  function openModal(course, prefill) {
    var form = document.getElementById('courseForm');
    if (!form) return;
    state.editingId = course ? course.id : null;

    document.getElementById('modalTitle').textContent = course ? '编辑课程' : '添加课程';
    // 输入框统一用 id 访问（比 form.name 命名属性更稳，jsdom 也能跑）
    document.getElementById('courseName').value = course ? course.name : '';
    document.getElementById('courseTeacher').value = course ? course.teacher : '';
    document.getElementById('courseLocation').value = course ? course.location : '';
    document.getElementById('courseDay').value = course ? String(course.day) : String((prefill && prefill.day) || 1);
    var sec = (prefill && prefill.section) || 1;
    document.getElementById('courseStart').value = course ? course.startSection : sec;
    document.getElementById('courseEnd').value = course ? course.endSection : sec;
    document.getElementById('courseNote').value = course ? course.note : '';

    var total = state.settings.totalWeeks;
    state.draftWeeks = course ? course.weeks.slice() : CF.generateWeeks(1, Math.min(16, total), 'all', total);
    state.draftColor = course ? course.color : 'blue';

    renderDraft();
    var del = document.getElementById('btnDeleteCourse');
    if (del) del.hidden = !course;

    document.getElementById('modalOverlay').hidden = false;
    // 聚焦到课程名（移动端不强制弹键盘，桌面端方便输入）
    try { document.getElementById('courseName').focus({ preventScroll: true }); } catch (e) { /* 老浏览器兜底 */ }
  }

  /** 弹窗内动态区域重绘（周次网格 + 颜色），只影响弹窗，不触发全局刷新 */
  function renderDraft() {
    var wg = document.getElementById('weeksGrid');
    if (wg) wg.innerHTML = CR.renderWeeksGrid(state.draftWeeks, state.settings.totalWeeks);
    var cs = document.getElementById('colorSwatches');
    if (cs) cs.innerHTML = CR.renderColorSwatches(state.draftColor);
  }

  function closeModal() {
    var overlay = document.getElementById('modalOverlay');
    if (overlay) overlay.hidden = true;
    state.editingId = null;
  }

  function onDeleteCourse(id) {
    var c = findCourse(id);
    if (!c) return;
    if (!window.confirm('确定删除《' + c.name + '》吗？')) return;
    state.courses = state.courses.filter(function (x) { return x.id !== id; });
    persist();
    closeModal();
    refreshAll();
    showToast('已删除《' + c.name + '》');
  }

  function onSaveCourse(e) {
    e.preventDefault();
    var draft = {
      id: state.editingId || undefined,
      name: document.getElementById('courseName').value,
      teacher: document.getElementById('courseTeacher').value,
      location: document.getElementById('courseLocation').value,
      day: Number(document.getElementById('courseDay').value),
      startSection: Number(document.getElementById('courseStart').value),
      endSection: Number(document.getElementById('courseEnd').value),
      weeks: state.draftWeeks.slice(),
      color: state.draftColor,
      note: document.getElementById('courseNote').value
    };
    var c = CF.normalizeCourse(draft);
    var errs = CF.validateCourse(c, state.settings, state.courses);
    if (errs.length) {
      showToast(errs[0]);
      return;
    }
    // 冲突为警告：允许用户确认后继续保存
    var clashes = CF.findCourseClashes(c, state.courses);
    if (clashes.length && !window.confirm(CR.clashConfirmText(c, clashes))) return;

    if (state.editingId) {
      for (var i = 0; i < state.courses.length; i++) {
        if (state.courses[i].id === state.editingId) { state.courses[i] = c; break; }
      }
    } else {
      state.courses.push(c);
    }
    persist();
    closeModal();
    refreshAll();
    showToast('已保存《' + c.name + '》');
  }

  // ==================== 备份 / 恢复 / 清空 ====================

  function dateStamp() {
    var d = new Date();
    return '' + d.getFullYear() + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + (d.getDate() < 10 ? '0' : '') + d.getDate();
  }

  function exportJSON() {
    persist(); // 先把工作副本同步进学期，避免导出到旧的课程列表
    var payload = JSON.stringify({
      version: 2,
      activeId: state.activeId,
      semesters: state.semesters
    }, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'courseforge-backup-' + dateStamp() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    showToast('备份已导出（' + state.semesters.length + ' 个学期）');
  }

  function onImportFile(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = ''; // 允许连续导入同一个文件
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data = null;
      try {
        data = JSON.parse(String(reader.result));
      } catch (err) {
        window.alert('导入失败：文件不是合法的 JSON。');
        return;
      }
      // 兼容 v1（扁平）与 v2（多学期）：统一走 normalizeWorkspace
      var ws = CF.normalizeWorkspace(data);
      if (!ws) {
        window.alert('导入失败：文件格式不符合 CourseForge 备份结构。');
        return;
      }
      var inCourses = 0;
      for (var i = 0; i < ws.semesters.length; i++) inCourses += ws.semesters[i].courses.length;
      var msg = '导入将替换当前全部数据，确定继续吗？\n\n'
        + '当前：' + state.semesters.length + ' 个学期 / ' + state.courses.length + ' 门课\n'
        + '导入：' + ws.semesters.length + ' 个学期 / ' + inCourses + ' 门课';
      if (!window.confirm(msg)) return;

      state.semesters = ws.semesters;
      // loadSemester 会 normalize 并把展示周切到本学期
      loadSemester(ws.activeId, false);
      persist();
      syncSettingsUI();
      refreshAll();
      showToast('导入成功，共 ' + ws.semesters.length + ' 个学期 / ' + inCourses + ' 门课');
    };
    reader.onerror = function () {
      window.alert('导入失败：文件读取错误。');
    };
    reader.readAsText(file, 'utf-8');
  }

  function onClearSample() {
    var n = state.courses.filter(function (c) { return String(c.id).indexOf('demo_') === 0; }).length;
    if (!n) return;
    if (!window.confirm('确定清除 ' + n + ' 门示例课程吗？')) return;
    state.courses = state.courses.filter(function (c) { return String(c.id).indexOf('demo_') !== 0; });
    persist();
    refreshAll();
    showToast('示例课程已清除');
  }

  /** 清空当前学期的课程（其它学期不受影响） */
  function onClearAll() {
    if (!state.courses.length) {
      showToast('当前学期没有课程');
      return;
    }
    if (!window.confirm('确定清空当前学期「' + activeName() + '」的全部课程吗？\n其它学期的数据不受影响。')) return;
    if (!window.confirm('再次确认：真的要清空吗？建议先「导出备份」。')) return;
    state.courses = [];
    persist();
    refreshAll();
    showToast('当前学期课程已清空');
  }

  // ==================== 多学期 ====================

  /** 打开「新建学期」弹窗，并预填下一个学期的默认值 */
  function openSemesterModal() {
    var d = CF.nextSemesterDefaults(activeSemesterObj());
    var nameEl = document.getElementById('semesterName');
    var startEl = document.getElementById('semesterStart');
    var keepEl = document.getElementById('semesterKeepTimes');
    var copyEl = document.getElementById('semesterCopyCourses');
    if (!nameEl || !startEl) return;
    nameEl.value = d.name;
    startEl.value = d.settings.semesterStart;
    if (keepEl) keepEl.checked = true;
    if (copyEl) copyEl.checked = false;
    document.getElementById('semesterModal').hidden = false;
    try { nameEl.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
  }

  function closeSemesterModal() {
    var m = document.getElementById('semesterModal');
    if (m) m.hidden = true;
  }

  /** 切换当前学期 */
  function switchSemester(id) {
    if (!id || id === state.activeId) return;
    persist(); // 先把当前学期的改动落盘，否则切换即丢失
    var target = null;
    for (var i = 0; i < state.semesters.length; i++) {
      if (state.semesters[i].id === id) target = state.semesters[i];
    }
    if (!target) return;
    loadSemester(id, false);
    persist();
    syncSettingsUI();
    syncSemesterModalDefaults();
    refreshAll();
    showToast('已切换到「' + target.name + '」');
  }

  /** 新建学期并立即切过去 */
  function onCreateSemester() {
    var nameEl = document.getElementById('semesterName');
    var startEl = document.getElementById('semesterStart');
    var keepEl = document.getElementById('semesterKeepTimes');
    var copyEl = document.getElementById('semesterCopyCourses');
    if (!nameEl || !startEl) return;

    var start = CF.parseDate(startEl.value);
    if (!start) {
      showToast('请选择开学日期');
      return;
    }
    var keep = keepEl ? keepEl.checked : true;
    var copy = copyEl ? copyEl.checked : false;

    persist(); // 保证旧学期的课程/设置是最新的

    var cur = state.settings;
    var settings = keep
      ? CF.normalizeSettings({
        semesterStart: CF.formatDate(start),
        totalWeeks: cur.totalWeeks,
        sectionsPerDay: cur.sectionsPerDay,
        showWeekend: cur.showWeekend,
        sectionTimes: cur.sectionTimes
      })
      : CF.normalizeSettings({ semesterStart: CF.formatDate(start) });

    var courses = copy ? state.courses.map(function (c) {
      // 不带 id 传入 → normalizeCourse 会重新发号，避免两个学期共用同一课程 id
      return CF.normalizeCourse({
        name: c.name, teacher: c.teacher, location: c.location,
        day: c.day, startSection: c.startSection, endSection: c.endSection,
        weeks: c.weeks, color: c.color, note: c.note
      });
    }) : [];

    var res = CF.addSemester({ activeId: state.activeId, semesters: state.semesters }, {
      name: nameEl.value,
      settings: settings,
      courses: courses
    });
    state.semesters = res.workspace.semesters;
    state.activeId = res.workspace.activeId;
    state.courses = res.semester.courses;
    state.settings = res.semester.settings;
    state.displayWeek = clampWeek(realWeek());
    persist();
    closeSemesterModal();
    syncSettingsUI();
    syncSemesterModalDefaults();
    refreshAll();
    showToast('已创建「' + res.semester.name + '」并切换过去'
      + (copy ? '，已复制 ' + courses.length + ' 门课' : ''));
  }

  /** 重命名学期 */
  function onRenameSemester(id) {
    var sem = null;
    for (var i = 0; i < state.semesters.length; i++) {
      if (state.semesters[i].id === id) sem = state.semesters[i];
    }
    if (!sem) return;
    var name = window.prompt('重命名学期：', sem.name);
    if (name === null) return;
    var res = CF.renameSemester({ activeId: state.activeId, semesters: state.semesters }, id, name);
    if (!res.ok) {
      showToast(res.reason === 'empty' ? '名称不能为空' : '学期不存在');
      return;
    }
    state.semesters = res.workspace.semesters;
    persist(); // 必须落盘：改名只改了内存里的学期对象，不写回刷新就丢
    refreshAll();
    showToast('已重命名为「' + CF.findSemester(res.workspace, id).name + '」');
  }

  /** 删除学期（至少保留一个） */
  function onDeleteSemester(id) {
    var sem = null;
    for (var i = 0; i < state.semesters.length; i++) {
      if (state.semesters[i].id === id) sem = state.semesters[i];
    }
    if (!sem) return;
    if (state.semesters.length <= 1) {
      showToast('至少要保留一个学期');
      return;
    }
    if (!window.confirm('删除学期「' + sem.name + '」及其 ' + sem.courses.length + ' 门课程？\n此操作不可恢复，建议先「导出备份」。')) return;

    persist(); // 保证当前学期的数据已同步，避免误删旧数据
    var res = CF.removeSemester({ activeId: state.activeId, semesters: state.semesters }, id);
    if (!res.ok) {
      showToast(res.reason === 'last' ? '至少要保留一个学期' : '学期不存在');
      return;
    }
    state.semesters = res.workspace.semesters;
    // 删掉的是当前学期时会自动切到剩下的第一个，这里重新装载
    loadSemester(res.workspace.activeId, false);
    persist();
    syncSettingsUI();
    syncSemesterModalDefaults();
    refreshAll();
    showToast('已删除学期「' + sem.name + '」');
  }

  /** 让弹窗里的默认值始终对应当前学期（打开弹窗时也会重算一次） */
  function syncSemesterModalDefaults() {
    var d = CF.nextSemesterDefaults(activeSemesterObj());
    var nameEl = document.getElementById('semesterName');
    var startEl = document.getElementById('semesterStart');
    if (nameEl && !nameEl.value) nameEl.value = d.name;
    if (startEl && !startEl.value) startEl.value = d.settings.semesterStart;
  }

  // ==================== 设置抽屉 ====================

  function syncSettingsUI() {
    var panel = document.getElementById('settingsPanel');
    if (!panel) return;
    var startDate = document.getElementById('settingsSemesterStart');
    var totalWeeks = document.getElementById('settingsTotalWeeks');
    var sectionsPerDay = document.getElementById('settingsSectionsPerDay');
    var showWeekend = document.getElementById('settingsShowWeekend');
    if (startDate) startDate.value = state.settings.semesterStart || '';
    if (totalWeeks) totalWeeks.value = state.settings.totalWeeks;
    if (sectionsPerDay) sectionsPerDay.value = state.settings.sectionsPerDay;
    if (showWeekend) showWeekend.checked = state.settings.showWeekend !== false;
    // 作息时间只读预览
    var preview = document.getElementById('sectionTimesPreview');
    if (preview) {
      var rows = '';
      var times = state.settings.sectionTimes;
      for (var i = 0; i < Math.max(state.settings.sectionsPerDay, Math.min(times.length, 14)); i++) {
        var t = times[i];
        if (!t) break;
        rows += '<div class="st-row"><span>' + CR.esc(t.label) + '</span><span>' + CR.esc(t.start || '--:--') + ' ~ ' + CR.esc(t.end || '--:--') + '</span></div>';
      }
      preview.innerHTML = rows;
    }
    syncRemindUI();
    syncEventsUI();
  }

  /** 把提醒相关的设置与权限状态刷到设置抽屉里 */
  function syncRemindUI() {
    var enabled = document.getElementById('settingsRemindEnabled');
    var lead = document.getElementById('settingsRemindLead');
    var cfg = RM ? RM.remindConfig(state.settings) : { enabled: false, lead: 10 };

    if (enabled) enabled.checked = cfg.enabled;
    if (lead) {
      // 选项由 RM.LEAD_CHOICES 生成，保证「界面能选的」和「引擎接受的」是同一份
      if (!lead.options.length && RM) {
        for (var i = 0; i < RM.LEAD_CHOICES.length; i++) {
          var v = RM.LEAD_CHOICES[i];
          var opt = document.createElement('option');
          opt.value = String(v);
          opt.textContent = v === 0 ? '上课时提醒' : v + ' 分钟前';
          lead.appendChild(opt);
        }
      }
      lead.value = String(cfg.lead);
      lead.disabled = !cfg.enabled;
    }
    updateNotifyUI();
  }

  /** 通知权限状态文案（三种权限 + 环境不支持，说清楚各自该怎么办） */
  function updateNotifyUI() {
    var el = document.getElementById('notifyState');
    if (el) el.textContent = notifyStateText();
  }

  // ==================== 考试与事件 ====================

  /** 当前学期的事件数组（事件直接挂在学期对象上，跟学期一起切换/备份/删除） */
  function activeEvents() {
    var sem = activeSemesterObj();
    return (sem && Array.isArray(sem.events)) ? sem.events : [];
  }

  /** '2026-09-30' → '9 月 30 日'（个位不加 0，与今日面板同风格） */
  function shortDateText(dateStr) {
    var p = String(dateStr || '').split('-');
    if (p.length !== 3) return dateStr;
    return Number(p[1]) + ' 月 ' + Number(p[2]) + ' 日';
  }

  /** 首页倒计时条：最近 3 条事件，今天的高亮；一条也没有时整条隐藏 */
  function renderEventsBar() {
    var bar = document.getElementById('eventsBar');
    if (!bar) return;
    var list = CF.upcomingEvents(activeEvents(), new Date(), 3);
    if (!list.length) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      var cls = 'event-chip' + (ev.kind === 'exam' ? ' event-exam' : '') + (ev.daysLeft === 0 ? ' event-today' : '');
      var time = ev.time ? ' ' + CR.esc(ev.time) : '';
      html += '<span class="' + cls + '" title="' + CR.esc(ev.name + ' · ' + ev.date + (ev.time ? ' ' + ev.time : '')) + '">'
        + (ev.kind === 'exam' ? '📝' : '📌') + CR.esc(ev.name)
        + '<b>' + CR.esc(CF.countdownTextOf(ev.daysLeft)) + '</b>'
        + '<i>' + CR.esc(shortDateText(ev.date)) + time + '</i></span>';
    }
    bar.innerHTML = html;
  }

  /** 设置抽屉里的管理列表：显示本学期全部事件（含已过去的，标灰），可删 */
  function syncEventsUI() {
    var box = document.getElementById('eventsList');
    if (!box) return;
    var all = CF.normalizeEvents(activeEvents());
    all.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    if (!all.length) {
      box.innerHTML = '<p class="hint">还没有考试或事件，用下面一行添加。</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < all.length; i++) {
      var ev = all[i];
      var left = CF.daysUntil(ev.date, new Date());
      var past = (left == null || left < 0);
      var when = shortDateText(ev.date) + (ev.time ? ' ' + CR.esc(ev.time) : '');
      html += '<div class="event-row' + (past ? ' event-past' : '') + '">'
        + '<span class="event-kind">' + (ev.kind === 'exam' ? '考试' : '事件') + '</span>'
        + '<span class="event-name">' + CR.esc(ev.name) + '</span>'
        + '<span class="event-when">' + when + (past ? '（已过）' : '') + '</span>'
        + '<button type="button" class="btn btn-ghost danger-text" data-action="delete-event" data-id="' + CR.esc(ev.id) + '" aria-label="删除 ' + CR.esc(ev.name) + '">删除</button>'
        + '</div>';
    }
    box.innerHTML = html;
  }

  /** 添加事件：只动当前学期，清洗后整体回写（坏数据在 normalize 里就被拦下了） */
  function onAddEvent() {
    var nameEl = document.getElementById('eventName');
    var dateEl = document.getElementById('eventDate');
    var timeEl = document.getElementById('eventTime');
    var kindEl = document.getElementById('eventKind');
    var name = nameEl ? nameEl.value.trim() : '';
    if (!name) { showToast('请填写名称'); return; }
    var date = dateEl ? dateEl.value : '';
    if (!date) { showToast('请选择日期'); return; }
    var ev = CF.normalizeEvent({
      name: name,
      date: date,
      time: timeEl ? timeEl.value : '',
      kind: kindEl ? kindEl.value : 'custom'
    });
    if (!ev) { showToast('日期无效，请重新选择'); return; }
    var sem = activeSemesterObj();
    if (!sem) return;
    sem.events = CF.normalizeEvents((sem.events || []).concat([ev]));
    persist();
    if (nameEl) nameEl.value = '';
    if (timeEl) timeEl.value = '';
    syncEventsUI();
    renderEventsBar();
    // 刚录入手边的考试时立刻查一轮：用户最需要的反馈就是「这门考试 X 天后」，
    // 比干巴巴的「已添加」更有信息量（窗口内会覆盖掉这条确认 toast）
    runExamTick();
    if (!document.getElementById('toast').hidden) return; // 弹了考试提醒就别再盖「已添加」
    showToast('已添加' + (ev.kind === 'exam' ? '考试' : '事件') + '：' + ev.name);
  }

  /** 删除事件：按 id 找到才删，找不到安静跳过（重复点击不炸） */
  function onDeleteEvent(id) {
    var sem = activeSemesterObj();
    if (!sem || !Array.isArray(sem.events) || !id) return;
    var kept = [];
    for (var i = 0; i < sem.events.length; i++) {
      if (sem.events[i].id !== id) kept.push(sem.events[i]);
    }
    if (kept.length === sem.events.length) return;
    sem.events = CF.normalizeEvents(kept);
    persist();
    syncEventsUI();
    renderEventsBar();
  }

  function onSettingsSave() {
    var panel = document.getElementById('settingsPanel');
    if (!panel) return;
    var startDate = document.getElementById('settingsSemesterStart');
    var totalWeeks = document.getElementById('settingsTotalWeeks');
    var sectionsPerDay = document.getElementById('settingsSectionsPerDay');
    var showWeekend = document.getElementById('settingsShowWeekend');
    var remindOn = document.getElementById('settingsRemindEnabled');
    var remindLead = document.getElementById('settingsRemindLead');
    if (!startDate.value) {
      showToast('请选择学期开始日期');
      return;
    }
    var next = CF.normalizeSettings({
      semesterStart: startDate.value,
      totalWeeks: Number(totalWeeks.value),
      sectionsPerDay: Number(sectionsPerDay.value),
      showWeekend: showWeekend ? showWeekend.checked : true,
      sectionTimes: state.settings.sectionTimes,
      // 调休标记与提醒配置不属于这个表单的可见字段，但必须一起带过去，
      // 否则「保存设置」会把用户之前标的放假日期静默抹掉
      days: state.settings.days,
      remind: RM ? RM.remindSettings(state.settings, {
        enabled: remindOn ? remindOn.checked : false,
        lead: remindLead ? Number(remindLead.value) : undefined
      }) : state.settings.remind
    });
    // 学期日期可能被改过，顺手清掉已经落在学期之外的调休标记，免得 days 无限长大
    var before = Object.keys(next.days || {}).length;
    next.days = RM ? RM.pruneDayMarks(next) : next.days;
    var dropped = before - Object.keys(next.days || {}).length;

    // 作息预设：选了预设就用预设节次覆盖（并同步每日节次数）
    var presetSel = document.getElementById('settingsTimePreset');
    if (presetSel && presetSel.value !== 'keep') {
      next.sectionTimes = CF.getPresetTimes(presetSel.value);
      next.sectionsPerDay = next.sectionTimes.length;
    }
    state.settings = next;
    state.displayWeek = clampWeek(state.displayWeek);
    persist();
    syncSettingsUI();
    refreshAll();
    runReminderTick(); // 刚把提醒打开时，别等到下一次定时器才有反应
    showToast('设置已保存' + (dropped > 0 ? '（清理了 ' + dropped + ' 个学期外的调休标记）' : ''));
    panel.hidden = true;
  }

  // ==================== 课表导入（照片/PDF/文本） ====================

  /** 导入器回调：把确认过的课程写入主状态 */
  function applyImported(list, mode, skipped) {
    if (!list || !list.length) {
      showToast('没有可导入的课程（请检查名称/节次是否完整）');
      return;
    }
    if (mode === 'replace') {
      if (!window.confirm('将用导入的 ' + list.length + ' 门课程替换现有 ' + state.courses.length + ' 门，确定吗？')) return;
      state.courses = list;
    } else {
      state.courses = state.courses.concat(list);
    }
    persist();
    if (CI) CI.close();
    refreshAll();
    showToast('已导入 ' + list.length + ' 门课程' + (skipped ? '（' + skipped + ' 条无效已跳过）' : ''));
  }

  // ==================== 主题（跟随系统 / 浅色 / 深色） ====================

  var THEME_KEY = 'wb_courseforge_theme';
  var THEMES = ['system', 'light', 'dark'];
  var THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };

  function readThemeMode() {
    try {
      var m = localStorage.getItem(THEME_KEY);
      return THEMES.indexOf(m) >= 0 ? m : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** 把三态模式解析成实际主题 */
  function resolveTheme(mode) {
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    return systemPrefersDark() ? 'dark' : 'light';
  }

  /** 应用主题：写 html[data-theme] + 同步按钮图标与浏览器主题色 */
  function applyTheme(mode) {
    var resolved = resolveTheme(mode);
    document.documentElement.setAttribute('data-theme', resolved);
    var btn = document.getElementById('btnTheme');
    if (btn) {
      var iconName = mode === 'system' ? 'monitor' : (mode === 'dark' ? 'moon' : 'sun');
      btn.innerHTML = CR.icon(iconName, 18);
      btn.setAttribute('data-theme-mode', mode);
      btn.title = '主题：' + THEME_LABEL[mode] + '（点击切换）';
      btn.setAttribute('aria-label', '切换主题，当前' + THEME_LABEL[mode]);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f131a' : '#2f6fed');
    // 桌面端原生标题栏跟随
    if (window.CourseForgeDesktop && window.CourseForgeDesktop.setTheme) {
      try { window.CourseForgeDesktop.setTheme(resolved); } catch (e) { /* 老版本主进程忽略 */ }
    }
  }

  function toggleTheme() {
    var next = THEMES[(THEMES.indexOf(state.themeMode) + 1) % THEMES.length];
    state.themeMode = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
    applyTheme(next);
    showToast('主题：' + THEME_LABEL[next]);
  }

  // ==================== 上课提醒 ====================

  /** 已弹过的提醒 key（由 remind.runTick 维护，跨 tick 去重） */
  var firedAlerts = {};

  /** 通知权限：'unsupported' | 'default' | 'granted' | 'denied' */
  function notifyPermission() {
    if (typeof window.Notification === 'undefined') return 'unsupported';
    return window.Notification.permission || 'default';
  }

  function notifyStateText() {
    var p = notifyPermission();
    if (p === 'unsupported') return '当前环境不支持系统通知，提醒会改成页面内提示。';
    if (p === 'granted') return '浏览器通知已允许，到点会弹系统通知。';
    if (p === 'denied') return '浏览器通知被拒绝，提醒只会显示在页面里。可在地址栏左侧的站点设置里重新允许。';
    return '还没有允许通知权限。点下面按钮授权后，切到别的标签页也能收到提醒。';
  }

  /**
   * 真正把提醒送出去。
   * 拿不到系统通知权限就退化成页内提示 —— 提醒这件事宁可弱一点，也不能静默丢掉。
   */
  function deliverAlert(a) {
    try {
      if (notifyPermission() === 'granted') {
        var n = new window.Notification(a.title, { body: a.body, tag: a.key, icon: 'icon.svg' });
        n.onclick = function () {
          try { window.focus(); } catch (e) { /* 某些环境不允许聚焦 */ }
          n.close();
        };
        return;
      }
    } catch (e) { /* 构造通知失败就往下走，退化成页内提示 */ }
    showToast(a.title + (a.body ? ' · ' + a.body : ''));
  }

  /** 跑一轮提醒检查；提醒没开时顺手把去重表清空，避免关掉再打开后「旧账」被翻出来 */
  function runReminderTick() {
    if (!RM || !state.settings) return;
    if (!RM.remindConfig(state.settings).enabled) {
      firedAlerts = {};
      return;
    }
    var res = RM.runTick(
      { courses: state.courses, settings: state.settings, fired: firedAlerts },
      new Date(),
      deliverAlert
    );
    firedAlerts = res.fired;
  }

  // ==================== 考试提醒（7 天内每天每条弹一次） ====================
  //
  // 与上课提醒共用 deliverAlert，但**不依赖上课提醒开关**——
  // 「我不想每节课都被提醒」和「下周的考试别忘了我还是想知道的」是两件事。
  // 去重账本单独存，不混进课表工作区：它是一次性的「今天提过没有」，
  // 跟着备份/导出走只会把 A 机器的旧账带去 B 机器。
  var EXAM_NOTIFIED_KEY = 'wb_courseforge_exam_notified';
  var EXAM_LEAD_DAYS = 7;

  /** 读去重账本；坏数据一律当空账本，不为它报错 */
  function loadExamNotified() {
    try {
      var m = JSON.parse(window.localStorage.getItem(EXAM_NOTIFIED_KEY));
      return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
    } catch (e) { return {}; }
  }

  function saveExamNotified(map) {
    try { window.localStorage.setItem(EXAM_NOTIFIED_KEY, JSON.stringify(map)); } catch (e) { /* 存不上就存不上，最多明天重复提醒一次 */ }
  }

  /** 跑一轮考试提醒；判定在 remind.js 的纯函数里，这里只负责通知和记账 */
  function runExamTick() {
    if (!RM) return;
    var events = activeEvents();
    if (!events.length) return;
    var notified = loadExamNotified();
    var due = RM.dueExamAlerts(events, new Date(), notified, EXAM_LEAD_DAYS);
    if (!due.length) return;
    var todayKey = due[0].notifiedKey;
    for (var i = 0; i < due.length; i++) {
      deliverAlert({ title: due[i].title, body: due[i].body, key: due[i].key });
      notified[due[i].id] = todayKey;
    }
    // 账本每天自净：只留今天的记录，不让它无限长大
    for (var k in notified) {
      if (Object.prototype.hasOwnProperty.call(notified, k) && notified[k] !== todayKey) delete notified[k];
    }
    saveExamNotified(notified);
  }

  /**
   * 切换今天的调休标记：'' → 'off'/'makeup'，再点一次取消。
   * 为什么会放在「今天」面板而不是设置里：调休是当天才知道的事，
   * 埋在设置里等于没有 —— 竞品普遍做成「今天/明天一键换课」就是这个道理。
   */
  function onToggleDayMark(mark) {
    if (!RM) { showToast('提醒模块未加载，请刷新页面'); return; }
    var today = CF.formatDate(new Date());
    var days = RM.toggleDayMark(state.settings, today, mark);
    var next = CF.normalizeSettings({
      semesterStart: state.settings.semesterStart,
      totalWeeks: state.settings.totalWeeks,
      sectionsPerDay: state.settings.sectionsPerDay,
      showWeekend: state.settings.showWeekend,
      sectionTimes: state.settings.sectionTimes,
      remind: state.settings.remind,
      days: days
    });
    state.settings = next;
    firedAlerts = {}; // 标记变了，今天该不该提醒也跟着变，去重表必须一起重置
    persist();
    refreshAll();
    var now = RM.dayMark(state.settings, today);
    showToast(now === 'off' ? '已标记今天放假，上课提醒会跳过'
      : (now === 'makeup' ? '已标记今天调休补课' : '已取消今天的标记'));
  }

  // ==================== 今日课程实时刷新 ====================

  var liveTimer = null;

  function startClock() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(function () {
      // 提醒先跑，且**不受 document.hidden 影响** —— 页面被切到后台、窗口被最小化，
      // 恰恰是最需要提醒的时候；把提醒和重绘一起跳过等于「最小化就静默失联」。
      // 重绘才需要跳过（省电，也避免打断用户）。
      runReminderTick();
      runExamTick(); // 考试提醒和上课提醒同一节奏，也不受 document.hidden 影响
      if (document.hidden) return;
      refreshLive();
    }, 30000);
    // Node / jsdom 环境下定时器会阻止进程退出（测试跑不完），主动标记为「不阻塞」
    if (liveTimer && typeof liveTimer.unref === 'function') liveTimer.unref();
  }

  // ==================== 日历导出（.ics） ====================

  function exportICS() {
    if (!ICS) { showToast('日历模块未加载，请刷新页面'); return; }
    if (!state.courses.length) { showToast('还没有课程可导出'); return; }
    var res;
    try {
      res = ICS.buildICS(state.courses, state.settings, {
        now: new Date(),
        calendarName: '课表工坊课程表'
      });
    } catch (e) {
      showToast('生成日历失败：' + (e && e.message ? e.message : '未知错误'));
      return;
    }
    if (!res.events) {
      showToast('作息时间不完整，无法生成日程（请先在设置里选作息预设）');
      return;
    }
    var blob = new Blob([res.text], { type: 'text/calendar;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ICS.suggestFileName(new Date());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    showToast('已导出 ' + res.events + ' 个日程，双击 .ics 即可导入手机日历'
      + (res.truncated ? '（超出上限已截断）' : ''));
  }

  // ==================== 课表分享图 ====================

  /**
   * 从当前主题的 CSS 变量解析课程配色。
   *
   * 为什么不在 JS 里也维护一份深色配色：一定会漂移 —— CSS 改了没人记得改 JS，
   * 表现就是「深色模式下导出的图还是浅色配色」，而这件事在浅色模式下永远看不到。
   * 直接读计算样式，配色就只有 CSS 一个来源。
   * 读不到（老浏览器 / 未挂载）时回落到 core.js 的预设值。
   */
  function resolveCssPalette() {
    var out = {};
    var colors = (CF && CF.COURSE_COLORS) || [];
    var styles = null;
    try { styles = window.getComputedStyle(document.documentElement); } catch (e) { styles = null; }
    for (var i = 0; i < colors.length; i++) {
      var key = colors[i].key;
      var main = colors[i].main;
      var bg = colors[i].bg;
      if (styles) {
        var m = String(styles.getPropertyValue('--c-' + key + '-main') || '').trim();
        var b = String(styles.getPropertyValue('--c-' + key + '-bg') || '').trim();
        if (m) main = m;
        if (b) bg = b;
      }
      out[key] = { main: main, bg: bg };
    }
    return out;
  }

  var shareMeasureFn = null;

  /** 量文字宽度的函数只建一次：每次重建 canvas 都会让浏览器分配离屏缓冲 */
  function shareMeasure() {
    if (!shareMeasureFn) shareMeasureFn = SI.makeMeasure(document);
    return shareMeasureFn;
  }

  /** 分享图实际用的主题（'auto' → 跟随应用当前主题） */
  function shareTheme() {
    return state.share.theme === 'auto' ? resolveTheme(state.themeMode) : state.share.theme;
  }

  /** 只有正在看「本周」且看的确实是真实当前周时，才高亮今天那一列 */
  function shareToday() {
    if (state.share.scope !== 'current') return 0;
    if (state.displayWeek !== realWeek()) return 0;
    var d = new Date().getDay(); // 0 = 周日
    return d === 0 ? 7 : d;
  }

  function currentSemesterName() {
    var sem = activeSemesterObj();
    return (sem && sem.name) || '我的课表';
  }

  function buildShareLayout() {
    return SI.buildLayout({
      courses: state.courses,
      settings: state.settings,
      semesterName: currentSemesterName(),
      week: state.displayWeek,
      scope: state.share.scope,
      theme: shareTheme(),
      today: shareToday(),
      palette: resolveCssPalette(),
      measure: shareMeasure()
    });
  }

  /** 预览区里的提示文案。用 textContent 而不是 innerHTML —— 异常文本不该当 HTML 解析 */
  function setShareMessage(msg) {
    var host = document.getElementById('sharePreview');
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    var p = document.createElement('p');
    p.className = 'share-loading';
    p.textContent = msg;
    host.appendChild(p);
  }

  /** 把选中态同步到按钮上（选项状态与 UI 只有这一处映射，避免两处各写一半） */
  function syncShareUI() {
    var groups = [
      ['share-scope', 'data-scope', state.share.scope],
      ['share-theme', 'data-theme', state.share.theme]
    ];
    for (var g = 0; g < groups.length; g++) {
      var btns = document.querySelectorAll('[data-action="' + groups[g][0] + '"]');
      for (var i = 0; i < btns.length; i++) {
        var v = btns[i].getAttribute(groups[g][1]);
        if (v === groups[g][2]) btns[i].classList.add('active');
        else btns[i].classList.remove('active');
      }
    }
  }

  function renderSharePreview() {
    // 先把选中态同步上去，再做重活。
    // 反过来写（画完再同步）会有一个小坑：出图失败时提前 return，
    // 用户点了「全部周次」却看不到按钮选中 —— 像是点了没反应。
    syncShareUI();

    if (!SI) { setShareMessage('图片模块未加载，请刷新页面重试'); return; }
    if (!state.courses.length) { setShareMessage('还没有课程，先添加课程或导入课表'); return; }

    var layout, canvas;
    try {
      layout = buildShareLayout();
      canvas = SI.drawToCanvas(layout, document);
    } catch (e) {
      setShareMessage('生成预览失败：' + (e && e.message ? e.message : '未知错误'));
      return;
    }

    var host = document.getElementById('sharePreview');
    if (host) {
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(canvas);
    }

    var hint = document.getElementById('shareHint');
    if (hint) {
      hint.textContent = '图片 ' + layout.width + '×' + layout.height
        + ' · 共 ' + layout.meta.courseCount + ' 门课';
    }
  }

  function openShareModal() {
    var m = document.getElementById('shareModal');
    if (!m) return;
    m.hidden = false;
    renderSharePreview();
  }

  function closeShareModal() {
    var m = document.getElementById('shareModal');
    if (m) m.hidden = true;
  }

  function onShareScope(el) {
    var v = el && el.getAttribute('data-scope') === 'all' ? 'all' : 'current';
    if (v === state.share.scope) return;
    state.share.scope = v;
    renderSharePreview();
  }

  function onShareTheme(el) {
    var v = (el && el.getAttribute('data-theme')) || 'auto';
    if (['auto', 'light', 'dark'].indexOf(v) < 0) v = 'auto';
    if (v === state.share.theme) return;
    state.share.theme = v;
    renderSharePreview();
  }

  function onSaveShare() {
    if (!SI) { showToast('图片模块未加载，请刷新页面'); return; }
    if (!state.courses.length) { showToast('还没有课程可分享'); return; }

    var layout;
    try {
      layout = buildShareLayout();
    } catch (e) {
      showToast('生成图片失败：' + (e && e.message ? e.message : '未知错误'));
      return;
    }

    var fileName = SI.suggestFileName(new Date(), currentSemesterName(),
      layout.meta.scope, layout.meta.week);

    // 生成是同步的，但 toBlob 是异步的 —— 期间禁用按钮，避免连点导出好几份
    var btn = document.getElementById('btnSaveShare');
    if (btn) btn.disabled = true;

    SI.exportPNG(layout, { document: document, fileName: fileName }, function (err, res) {
      if (btn) btn.disabled = false;
      if (err || !res) {
        showToast('保存失败：' + ((err && err.message) || '未知错误'));
        return;
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(res.blob);
      a.download = res.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      showToast('已生成课表图片（' + layout.width + '×' + layout.height + '），保存到下载目录');
    });
  }

  /**
   * 分享图「复制到剪贴板」：和保存共用同一套 layout/exportPNG，
   * 只是最后一步从「触发下载」换成「写剪贴板」。
   * ClipboardItem 在部分环境（旧 WebView / 非用户手势）不可用，
   * 失败时明确说原因，别让用户以为复制成功了却粘出来是空气。
   */
  function onCopyShare() {
    if (!SI) { showToast('图片模块未加载，请刷新页面'); return; }
    if (!state.courses.length) { showToast('还没有课程可分享'); return; }

    var layout;
    try {
      layout = buildShareLayout();
    } catch (e) {
      showToast('生成图片失败：' + (e && e.message ? e.message : '未知错误'));
      return;
    }

    var nav = window.navigator;
    var btn = document.getElementById('btnCopyShare');
    var finish = function (ok, msg) {
      if (btn) btn.disabled = false;
      showToast(msg);
    };

    if (!nav.clipboard || typeof nav.clipboard.write !== 'function'
      || typeof window.ClipboardItem !== 'function') {
      showToast('当前环境不支持复制图片，请用「保存图片」');
      return;
    }

    if (btn) btn.disabled = true;
    SI.exportPNG(layout, { document: document, fileName: 'clipboard.png' }, function (err, res) {
      if (err || !res) { finish(false, '复制失败：' + ((err && err.message) || '未知错误')); return; }
      try {
        nav.clipboard.write([new window.ClipboardItem({ 'image/png': res.blob })])
          .then(function () {
            finish(true, '已复制到剪贴板（' + layout.width + '×' + layout.height + '），直接粘贴即可');
          })
          .catch(function (e) {
            // 常见于权限被拒或非用户手势触发；兜底方案是保存
            finish(false, '复制失败：' + ((e && e.message) || '剪贴板权限被拒绝') + '，可用「保存图片」代替');
          });
      } catch (e) {
        finish(false, '复制失败：' + ((e && e.message) || '未知错误'));
      }
    });
  }

  // ==================== PWA（可添加到桌面 / 离线可用） ====================

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // file:// 或桌面端本地文件环境下 Service Worker 不可用，静默跳过
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    try {
      // 新版本 SW 接管后自动刷新一次，让「刚发布的修复」当场生效。
      //
      // 背景：sw.js 早期用 cache-first，已部署的新代码要等用户访问两次才生效。
      // 表现就是「我这边明明改好并发布了，用户打开还是报同样的错」——
      // 上两轮排查就被这个现象带偏过（误以为是修复本身没起作用）。
      // 首次安装时 controller 从 null 变有值也会触发 controllerchange，
      // 那种情况不刷新（hadController 为 false），免得白白多刷一次页面。
      var hadController = !!navigator.serviceWorker.controller;
      var reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || reloaded) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').catch(function () { /* 离线能力非核心，失败不影响使用 */ });
    } catch (e) { /* 忽略 */ }
  }

  // ==================== Toast ====================

  var toastTimer = null;

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('show');
      t.hidden = true;
    }, 2200);
  }

  // ==================== 事件分发 ====================

  var ACTIONS = {
    'prev-week': function () { state.displayWeek = clampWeek(state.displayWeek - 1); refreshAll(); },
    'next-week': function () { state.displayWeek = clampWeek(state.displayWeek + 1); refreshAll(); },
    'this-week': function () { state.displayWeek = clampWeek(realWeek()); refreshAll(); },
    'view-week': function () { state.view = 'week'; refreshAll(); },
    'view-list': function () { state.view = 'list'; refreshAll(); },
    'add-course': function () { openModal(null, null); },
    'edit-course': function (el) {
      var c = findCourse(el.getAttribute('data-id'));
      if (c) openModal(c, null);
    },
    'delete-course': function (el) { onDeleteCourse(el.getAttribute('data-id')); },
    'close-modal': closeModal,
    'save-course': function () {
      var form = document.getElementById('courseForm');
      if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    },
    'open-settings': function () {
      syncSettingsUI();
      syncEventsUI();
      if (desktopWidgetResync) desktopWidgetResync();
      document.getElementById('settingsPanel').hidden = false;
    },
    'close-settings': function () { document.getElementById('settingsPanel').hidden = true; },
    'save-settings': onSettingsSave,
    // 考试与事件
    'add-event': onAddEvent,
    'delete-event': function (el) { onDeleteEvent(el.getAttribute('data-id')); },
    'export-json': exportJSON,
    'export-ics': exportICS,
    'print-schedule': function () { window.print(); },
    // 课表分享图
    'share-image': openShareModal,
    'close-share': closeShareModal,
    'share-scope': onShareScope,
    'share-theme': onShareTheme,
    'save-share': onSaveShare,
    'copy-share': onCopyShare,
    'toggle-theme': toggleTheme,
    'import-json': function () { document.getElementById('importFile').click(); },
    'clear-sample': onClearSample,
    'clear-all': onClearAll,
    // 多学期（工作区）
    'open-semester-modal': openSemesterModal,
    'close-semester-modal': closeSemesterModal,
    'create-semester': onCreateSemester,
    'switch-semester': function (el) { switchSemester(el.getAttribute('data-id')); },
    'rename-semester': function (el) { onRenameSemester(el.getAttribute('data-id')); },
    'delete-semester': function (el) { onDeleteSemester(el.getAttribute('data-id')); },
    'parity-all': function () { state.draftWeeks = CF.generateWeeks(1, state.settings.totalWeeks, 'all', state.settings.totalWeeks); renderDraft(); },
    'parity-odd': function () { state.draftWeeks = CF.generateWeeks(1, state.settings.totalWeeks, 'odd', state.settings.totalWeeks); renderDraft(); },
    'parity-even': function () { state.draftWeeks = CF.generateWeeks(1, state.settings.totalWeeks, 'even', state.settings.totalWeeks); renderDraft(); },
    // 上课提醒 / 调休
    'request-notify': requestNotifyPermission,
    'mark-day-off': function () { onToggleDayMark('off'); },
    'mark-day-makeup': function () { onToggleDayMark('makeup'); },
    'clear-day-mark': function () { onToggleDayMark(''); }
  };

  /**
   * 申请通知权限。
   * 两种 API 都要接：新版返回 Promise，老版（含部分 Safari）只回调，
   * 只认一种的话在另一种上会静默什么都不发生 —— 用户点了按钮但没反应，最难排查。
   */
  function requestNotifyPermission() {
    if (typeof window.Notification === 'undefined') {
      showToast('当前环境不支持系统通知，提醒会改成页面内提示');
      return;
    }
    var done = function (res) {
      updateNotifyUI();
      if (res === 'granted') showToast('已允许通知，上课前会提醒你');
      else if (res === 'denied') showToast('通知被拒绝，可以到浏览器站点设置里重新允许');
      else showToast('没有做出选择，可以稍后再点一次');
    };
    try {
      var r = window.Notification.requestPermission(done);
      if (r && typeof r.then === 'function') r.then(done);
    } catch (e) {
      showToast('申请通知权限失败：' + (e && e.message ? e.message : '未知错误'));
    }
    updateNotifyUI();
  }

  function onDocumentClick(e) {
    // 弹窗遮罩点击关闭
    if (e.target && e.target.id === 'modalOverlay') { closeModal(); return; }
    if (e.target && e.target.id === 'importModal') { if (CI) CI.close(); return; }
    if (e.target && e.target.id === 'semesterModal') { closeSemesterModal(); return; }

    // data-action 按钮（最近的一个）
    var el = e.target.closest ? e.target.closest('[data-action]') : null;
    if (el) {
      var action = el.getAttribute('data-action');
      if (ACTIONS[action]) { ACTIONS[action](el); return; }
    }

    // 课程卡片：点击编辑
    var card = e.target.closest ? e.target.closest('.cf-card') : null;
    if (card && card.getAttribute('data-id')) {
      ACTIONS['edit-course'](card);
      return;
    }

    // 空白格子：点击添加（预填星期与节次）
    var cell = e.target.closest ? e.target.closest('.cf-cell') : null;
    if (cell) {
      openModal(null, {
        day: Number(cell.getAttribute('data-day')) || 1,
        section: Number(cell.getAttribute('data-section')) || 1
      });
    }
  }

  function onDocumentChange(e) {
    var t = e.target;
    if (!t) return;
    // 弹窗内周次按钮 / 颜色选择（button 无 change，走 click，这里兜底不需要）
    if (t.id === 'importFile') { onImportFile(e); return; }
  }

  function onModalClick(e) {
    // 周次按钮：切换选中状态
    var wb = e.target.closest ? e.target.closest('.week-btn') : null;
    if (wb) {
      var w = Number(wb.getAttribute('data-week'));
      var idx = state.draftWeeks.indexOf(w);
      if (idx === -1) {
        state.draftWeeks.push(w);
        state.draftWeeks.sort(function (a, b) { return a - b; });
      } else {
        state.draftWeeks.splice(idx, 1);
      }
      renderDraft();
      return;
    }
    // 颜色选择
    var sw = e.target.closest ? e.target.closest('.swatch') : null;
    if (sw) {
      state.draftColor = sw.getAttribute('data-color') || 'blue';
      renderDraft();
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      closeModal();
      closeSemesterModal();
      var imp = document.getElementById('importModal');
      if (imp && !imp.hidden && CI) CI.close();
      var panel = document.getElementById('settingsPanel');
      if (panel) panel.hidden = true;
    }
  }

  // ==================== 初始化 ====================

  function seed() {
    // 全新环境：以本周一为学期开始，预置示例课程，并生成一个默认学期
    var start = CF.mondayOf(new Date());
    var settings = CF.normalizeSettings({ semesterStart: CF.formatDate(start) });
    var courses = CF.buildSampleCourses().map(function (c) {
      c.id = 'demo_' + CF.uid();
      return CF.normalizeCourse(c);
    });
    // normalizeSemester 会按开学日期自动命名（如「2026 秋季学期」）
    var sem = CF.normalizeSemester({ settings: settings, courses: courses });
    var ws = { activeId: sem.id, semesters: [sem] };
    ST.save({ version: 2, activeId: ws.activeId, semesters: ws.semesters });
    return ws;
  }

  /**
   * 「桌面常驻小组件」开关（仅桌面端显示）。
   *
   * 两个刻意的设计：
   *   1) 它不进 settings、不跟随「保存设置」—— 控制的是窗口显隐，必须立刻生效。
   *      等用户再点一次保存才动，会让人以为点了没反应。
   *   2) 状态真身在主进程（托盘菜单也能改），所以打开抽屉时重读一次。
   *      并且调用失败要把勾选**改回去** —— 界面显示「已开启」而窗口根本没出来，
   *      是比功能坏掉更糟的一种状态：用户会一直等一个不会出现的东西。
   */
  function mountDesktopWidgetSetting() {
    var d = window.CourseForgeDesktop;
    var field = document.getElementById('desktopWidgetField');
    var box = document.getElementById('settingsDesktopWidget');
    if (!d || !d.shell || !field || !box) return;
    if (typeof d.shell.status !== 'function') return;

    field.hidden = false;

    desktopWidgetResync = function () {
      var r = d.shell.status();
      if (!r || typeof r.then !== 'function') return;
      r.then(function (st) {
        if (st && typeof st.widgetVisible === 'boolean') box.checked = st.widgetVisible;
      }, function () { /* 读不到就维持现状，不猜 */ });
    };

    box.addEventListener('change', function () {
      var want = box.checked;
      var call = want ? d.shell.showWidget : d.shell.hideWidget;
      var r = call();
      if (!r || typeof r.then !== 'function') return;
      r.then(function (ok) {
        if (ok !== true) {
          box.checked = !want;
          showToast(want ? '小组件没能打开，可能被系统拦下了' : '小组件没能关闭');
        }
      }, function () {
        box.checked = !want;
        showToast('桌面外壳没有响应，小组件未改变');
      });
    });

    desktopWidgetResync();
  }

  function init() {
    // 兼容 v1 旧数据：normalizeWorkspace 内部完成迁移；只有「完全无数据」才播种示例
    var ws = CF.normalizeWorkspace(ST.load());
    if (!ws) ws = seed();

    state.semesters = ws.semesters;
    loadSemester(ws.activeId, false);
    state.themeMode = readThemeMode();

    persist(); // 立刻回写：把 v1 数据升级为 v2 落盘，避免下次再迁移

    applyTheme(state.themeMode);
    bindEvents();
    // 导入模块挂载（照片 OCR / PDF / 粘贴文本 → 解析确认 → 入库）
    if (CI) CI.mount({
      getSettings: function () { return state.settings; },
      apply: applyImported,
      toast: showToast
    });
    // 单双周快捷按钮（静态内容，只需渲染一次）
    var parityBar = document.getElementById('parityBar');
    if (parityBar && !parityBar.childElementCount) parityBar.innerHTML = CR.renderParityButtons();
    // 桌面端环境标识
    var chip = document.getElementById('syncChip');
    if (chip && window.CourseForgeDesktop) chip.textContent = '桌面版 · 本地保存';
    // 桌面端专属设置项（常驻小组件）：网页版没有这段桥，整块保持隐藏
    mountDesktopWidgetSetting();
    // 新建学期弹窗的默认值
    syncSemesterModalDefaults();
    // 今日课程实时刷新（每分钟一次，页面不可见时暂停重绘但保留提醒）
    startClock();
    registerSW();
    refreshAll();
    // 首屏就检查一次提醒：用户可能就是在课前两分钟才打开页面的，
    // 那正是最该立刻提醒的时刻，等到 30 秒后的第一次 tick 也不算错，但没必要等
    syncRemindUI();
    runReminderTick();
    runExamTick(); // 首屏同样直查一次考试提醒，理由同上
  }

  function bindEvents() {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('change', onDocumentChange);
    document.addEventListener('keydown', onKeydown);

    var modal = document.getElementById('modalOverlay');
    if (modal) modal.addEventListener('click', onModalClick);

    var form = document.getElementById('courseForm');
    if (form) form.addEventListener('submit', onSaveCourse);

    var delBtn = document.getElementById('btnDeleteCourse');
    if (delBtn) delBtn.addEventListener('click', function () {
      if (state.editingId) onDeleteCourse(state.editingId);
    });

    // 跟随系统模式下，系统切换深浅色时自动跟随
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onSchemeChange = function () {
        if (state.themeMode === 'system') applyTheme('system');
      };
      if (mq.addEventListener) mq.addEventListener('change', onSchemeChange);
      else if (mq.addListener) mq.addListener(onSchemeChange);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
