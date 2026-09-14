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
    courses: [],        // 课程列表（已 normalize）
    settings: null,     // 设置（已 normalize）
    displayWeek: 1,     // 当前展示周
    view: 'week',       // 'week' | 'list'
    editingId: null,    // 弹窗正在编辑的课程 id（null = 新增）
    draftWeeks: [],     // 弹窗当前选中的周次
    draftColor: 'blue'  // 弹窗当前选中颜色
  };

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

  /** 持久化当前状态 */
  function persist() {
    ST.save({ version: 1, courses: state.courses, settings: state.settings });
  }

  // ==================== 统一刷新入口 ====================

  function refreshAll() {
    var now = new Date();
    var el;

    el = document.getElementById('weekNav');
    if (el) el.innerHTML = CR.renderWeekNav(state.displayWeek, state.settings, realWeek());

    el = document.getElementById('statsBar');
    if (el) el.innerHTML = CR.renderStats(state.courses, state.displayWeek, state.settings);

    el = document.getElementById('todayPanel');
    if (el) el.innerHTML = CR.renderToday(state.courses, realWeek(), state.settings, now);

    var main = document.getElementById('mainView');
    if (main) {
      main.innerHTML = (state.view === 'week')
        ? CR.renderGrid(state.courses, state.displayWeek, state.settings, now)
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
    var payload = JSON.stringify({ version: 1, courses: state.courses, settings: state.settings }, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'courseforge-backup-' + dateStamp() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    showToast('备份已导出');
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
      if (!data || !Array.isArray(data.courses)) {
        window.alert('导入失败：文件格式不符合 CourseForge 备份结构。');
        return;
      }
      var courses = data.courses.map(CF.normalizeCourse);
      var settings = CF.normalizeSettings(data.settings);
      if (!window.confirm('导入将替换当前全部数据（' + state.courses.length + ' 门课 → ' + courses.length + ' 门课），确定继续吗？')) return;
      state.courses = courses;
      state.settings = settings;
      state.displayWeek = clampWeek(realWeek());
      persist();
      syncSettingsUI();
      refreshAll();
      showToast('导入成功，共 ' + courses.length + ' 门课');
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

  function onClearAll() {
    if (!state.courses.length && !ST.load()) {
      showToast('当前没有数据');
      return;
    }
    if (!window.confirm('确定清空全部课程数据吗？此操作不可恢复！')) return;
    if (!window.confirm('再次确认：真的要清空吗？建议先「导出备份」。')) return;
    state.courses = [];
    ST.clear();
    persist();
    refreshAll();
    showToast('数据已清空');
  }

  // ==================== 设置抽屉 ====================

  function syncSettingsUI() {
    var panel = document.getElementById('settingsPanel');
    if (!panel) return;
    var startDate = document.getElementById('settingsSemesterStart');
    var totalWeeks = document.getElementById('settingsTotalWeeks');
    var sectionsPerDay = document.getElementById('settingsSectionsPerDay');
    if (startDate) startDate.value = state.settings.semesterStart || '';
    if (totalWeeks) totalWeeks.value = state.settings.totalWeeks;
    if (sectionsPerDay) sectionsPerDay.value = state.settings.sectionsPerDay;
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
    if (!startDate.value) {
      showToast('请选择学期开始日期');
      return;
    }
    var next = CF.normalizeSettings({
      semesterStart: startDate.value,
      totalWeeks: Number(totalWeeks.value),
      sectionsPerDay: Number(sectionsPerDay.value),
      sectionTimes: state.settings.sectionTimes
    });
    state.settings = next;
    state.displayWeek = clampWeek(state.displayWeek);
    persist();
    syncSettingsUI();
    refreshAll();
    showToast('设置已保存');
    panel.hidden = true;
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
    'import-json': function () { document.getElementById('importFile').click(); },
    'clear-sample': onClearSample,
    'clear-all': onClearAll,
    'parity-all': function () { state.draftWeeks = CF.generateWeeks(1, state.settings.totalWeeks, 'all', state.settings.totalWeeks); renderDraft(); },
    'parity-odd': function () { state.draftWeeks = CF.generateWeeks(1, state.settings.totalWeeks, 'odd', state.settings.totalWeeks); renderDraft(); },
    'parity-even': function () { state.draftWeeks = CF.generateWeeks(1, state.settings.totalWeeks, 'even', state.settings.totalWeeks); renderDraft(); }
  };

  function onDocumentClick(e) {
    // 弹窗遮罩点击关闭
    if (e.target && e.target.id === 'modalOverlay') { closeModal(); return; }

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
      var panel = document.getElementById('settingsPanel');
      if (panel) panel.hidden = true;
    }
  }

  // ==================== 初始化 ====================

  function seed() {
    // 全新环境：以本周一为学期开始，预置示例课程
    var start = CF.mondayOf(new Date());
    var settings = CF.normalizeSettings({ semesterStart: CF.formatDate(start) });
    var courses = CF.buildSampleCourses().map(function (c) {
      c.id = 'demo_' + CF.uid();
      return CF.normalizeCourse(c);
    });
    var data = { version: 1, courses: courses, settings: settings };
    ST.save(data);
    return data;
  }

  function init() {
    var data = ST.load();
    if (!data || !Array.isArray(data.courses) || !data.courses.length) {
      data = seed();
    }
    state.courses = data.courses.map(CF.normalizeCourse);
    state.settings = CF.normalizeSettings(data.settings);
    state.displayWeek = clampWeek(realWeek());

    bindEvents();
    // 单双周快捷按钮（静态内容，只需渲染一次）
    var parityBar = document.getElementById('parityBar');
    if (parityBar && !parityBar.childElementCount) parityBar.innerHTML = CR.renderParityButtons();
    // 桌面端环境标识
    var chip = document.getElementById('syncChip');
    if (chip && window.CourseForgeDesktop) chip.textContent = '桌面版 · 本地保存';
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
