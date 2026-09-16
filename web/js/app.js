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
    themeMode: 'system' // 'system' | 'light' | 'dark'
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
  }

  function onSettingsSave() {
    var panel = document.getElementById('settingsPanel');
    if (!panel) return;
    var startDate = document.getElementById('settingsSemesterStart');
    var totalWeeks = document.getElementById('settingsTotalWeeks');
    var sectionsPerDay = document.getElementById('settingsSectionsPerDay');
    var showWeekend = document.getElementById('settingsShowWeekend');
    if (!startDate.value) {
      showToast('请选择学期开始日期');
      return;
    }
    var next = CF.normalizeSettings({
      semesterStart: startDate.value,
      totalWeeks: Number(totalWeeks.value),
      sectionsPerDay: Number(sectionsPerDay.value),
      showWeekend: showWeekend ? showWeekend.checked : true,
      sectionTimes: state.settings.sectionTimes
    });
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
    showToast('设置已保存');
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

  // ==================== 今日课程实时刷新 ====================

  var liveTimer = null;

  function startClock() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(function () {
      if (document.hidden) return; // 页面不可见时不刷新，省电
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
    'open-settings': function () { syncSettingsUI(); document.getElementById('settingsPanel').hidden = false; },
    'close-settings': function () { document.getElementById('settingsPanel').hidden = true; },
    'save-settings': onSettingsSave,
    'export-json': exportJSON,
    'export-ics': exportICS,
    'print-schedule': function () { window.print(); },
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
    'parity-even': function () { state.draftWeeks = CF.generateWeeks(1, state.settings.totalWeeks, 'even', state.settings.totalWeeks); renderDraft(); }
  };

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
    // 新建学期弹窗的默认值
    syncSemesterModalDefaults();
    // 今日课程实时刷新（每分钟一次，页面不可见时暂停）
    startClock();
    registerSW();
    refreshAll();
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
