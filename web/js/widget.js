/**
 * 课表小组件的渲染层（桌面端专用）
 *
 * 刻意做成「哑渲染」：这里不做任何课表判定 —— 不知道什么是周次、单双周、调休。
 * 主进程已经把一切都算进 view 里了（见 desktop/widget-store.js），
 * 本文件只负责把 view 翻译成 DOM 文字。
 *
 * 唯一它自己要算的东西是**倒计时的秒级插值**：
 * 主进程 30 秒才推一次数据，但「还有 4 分 12 秒上课」这种数字必须每秒都动。
 * 做法不是每秒问一次主进程（那是 30 倍的无谓 IPC），而是拿推送里带的
 * computedAt 当锚点，本地算出「上课那一刻的绝对时间」，之后纯本地递减。
 *
 * 文案计算全部是纯函数（remainText / headlineOf / …），可脱离浏览器单测 ——
 * 这类「跨天、跨状态」的文案最容易写错，而它们恰好是最容易测的部分。
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.CourseForgeWidgetUI = factory();
    // 桌面端自动挂载。桥由 preload 注入，正常早于本脚本；
    // 万一晚一步（脚本被缓存提前执行），等 DOM 就绪再补一次。
    if (root.document) {
      if (root.CourseForgeWidget) {
        root.CourseForgeWidgetUI.boot(root.CourseForgeWidget, root.document);
      } else {
        root.document.addEventListener('DOMContentLoaded', function () {
          if (root.CourseForgeWidget) {
            root.CourseForgeWidgetUI.boot(root.CourseForgeWidget, root.document);
          }
        });
      }
    }
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LOOKAHEAD_DAYS = 14;

  // ==================== 纯函数：文案 ====================

  /**
   * 毫秒 → 时长文案。
   * 一小时以上只说「小时 + 分钟」（秒级精度没有意义，还会闪得让人分心）；
   * 十分钟以内给到秒，因为学生这时真的在掐点。
   */
  function remainText(ms) {
    if (ms == null || !isFinite(ms)) return '';
    if (ms <= 0) return '0 秒';
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    // 整点时只说「1 小时」——「1 小时 0 分钟」是把内部单位泄漏到了界面上
    if (h > 0) return m > 0 ? (h + ' 小时 ' + m + ' 分钟') : (h + ' 小时');
    if (m >= 10) return m + ' 分钟';
    if (m > 0) return m + ' 分 ' + s + ' 秒';
    return s + ' 秒';
  }

  /** 顶部那行彩色短语：这一卡此刻最重要的一件事 */
  function headlineOf(view, remainMs) {
    var v = view || {};
    switch (v.phase) {
      case 'nodata': return '还没有课表';
      case 'beforeterm':
        return v.daysToStart > 0 ? '距开学还有 ' + v.daysToStart + ' 天' : '学期即将开始';
      case 'afterterm': return '学期已结束';
      case 'off': return '今天放假';
      case 'missing': return '作息时间缺失';
      case 'current':
        return (remainMs != null && remainMs > 0)
          ? '正在上课 · 还有 ' + remainText(remainMs)
          : '正在上课';
      case 'next':
        if (!v.next) return '';
        if (v.next.daysAhead > 0) return v.next.dayLabel + ' ' + v.next.startText + ' 上课';
        return (remainMs != null && remainMs > 0)
          ? '还有 ' + remainText(remainMs) + '上课'
          : '马上上课';
      default: return '接下来 ' + LOOKAHEAD_DAYS + ' 天没有课';
    }
  }

  /**
   * 该把哪门课摆在中间。
   * 「放假」那天特意把**下一节课**顶上来 —— 放假时用户最想知道的就是下一次什么时候上；
   * 只写「今天放假」等于什么也没回答。
   */
  function subjectOf(view) {
    var v = view || {};
    if (v.phase === 'off') return v.next || null;
    if (v.phase === 'beforeterm' || v.phase === 'afterterm') return null;
    if (v.phase === 'current') return v.current || null;
    return v.next || v.current || null;
  }

  /** 大标题：课名（或没有课可显示时的替代文字） */
  function nameOf(view) {
    var v = view || {};
    var s = subjectOf(v);
    if (s) return s.name || '';
    if (v.phase === 'beforeterm') return v.semesterName || '新学期';
    if (v.phase === 'afterterm') return v.semesterName || '学期已结束';
    if (v.phase === 'nodata') return '打开完整课表导入';
    if (v.phase === 'missing') return '请检查作息时间设置';
    return '';
  }

  /** 次行：时间 / 节次 / 地点，用 · 分隔，空字段自动省略 */
  function metaOf(view) {
    var v = view || {};
    var s = subjectOf(v);
    if (!s) {
      if (v.phase === 'beforeterm' && v.termStartLabel) return '开学日 ' + v.termStartLabel;
      if (v.courseCount > 0) return '本学期共 ' + v.courseCount + ' 门课程';
      return '';
    }
    var parts = [];
    // 不是今天的课要先说清是哪天，否则「08:00 ~ 09:40」会被当成今天要上课
    if (s.daysAhead > 0) parts.push(s.dayLabel);
    if (s.rangeText) parts.push(s.rangeText);
    if (s.sectionText) parts.push(s.sectionText);
    if (s.location) parts.push(s.location);
    return parts.join(' · ');
  }

  /** 左下角：今天的课还剩多少 */
  function todayTextOf(view) {
    var v = view || {};
    if (!v.hasData) return '';
    if (v.phase === 'current') {
      return v.todayRemaining > 0 ? '今天还有 ' + v.todayRemaining + ' 节' : '今天最后一节';
    }
    if (v.todayCount <= 0) return '今天没课';
    if (v.next && v.next.daysAhead === 0) return '今天共 ' + v.todayCount + ' 节';
    return '今天的课已上完';
  }

  /**
   * 倒计时的本地锚点。
   * 直接用主进程给好的**精确**上/下课时刻（startAt / endAt，epoch ms）。
   * 为什么不拿「距现在 N 分钟」自己加：那个字段是取整到分钟的，
   * 反推出来的时刻最多偏 30 秒，而最后十分钟是要显示到秒的 ——
   * 正好在用户最在意的窗口里差半分钟。
   */
  function anchorsOf(view) {
    var v = view || {};
    var base = (typeof v.computedAt === 'number' && isFinite(v.computedAt)) ? v.computedAt : null;
    var a = { computedAt: base, nextAt: null, curStartAt: null, curEndAt: null, curTotal: null };
    if (base == null) return a;

    if (v.phase === 'next' && v.next && v.next.daysAhead === 0
        && typeof v.next.startAt === 'number' && isFinite(v.next.startAt)) {
      a.nextAt = v.next.startAt;
    }
    if (v.phase === 'current' && v.current
        && typeof v.current.startAt === 'number' && isFinite(v.current.startAt)
        && typeof v.current.endAt === 'number' && isFinite(v.current.endAt)
        && v.current.endAt > v.current.startAt) {
      a.curStartAt = v.current.startAt;
      a.curEndAt = v.current.endAt;
      a.curTotal = v.current.endAt - v.current.startAt;
    }
    return a;
  }

  /** 当前进度百分比（0-100）；没有锚点时返回 null，由调用方保持原样 */
  function percentOf(anchors, nowMs) {
    if (!anchors || anchors.curStartAt == null || !anchors.curTotal) return null;
    var p = (nowMs - anchors.curStartAt) / anchors.curTotal * 100;
    return Math.max(0, Math.min(100, p));
  }

  /**
   * 下一场考试/事件的一行文案（foot 第三格）。
   * 只取第一条 —— 挂件 foot 只有一行位置，罗列是首页的事；
   * 倒计时文案用主进程算好的 countdownText，不在这边再发明一份。
   */
  function eventLineOf(view) {
    var v = view || {};
    if (!Array.isArray(v.events) || !v.events.length) return '';
    var ev = v.events[0];
    if (!ev || !ev.name) return '';
    // countdownText 由主进程算好（单一真相源）；这里是防御性兜底，
    // 本文件不依赖 core.js，所以兜底只能内联一份极简版
    var cd = ev.countdownText;
    if (!cd) {
      var n = ev.daysLeft;
      if (n === 0) cd = '今天';
      else if (n === 1) cd = '明天';
      else if (typeof n === 'number' && isFinite(n) && n > 1) cd = '还有 ' + n + ' 天';
    }
    if (!cd) return '';
    return (ev.kind === 'exam' ? '📝 ' : '📌 ') + ev.name + ' · ' + cd;
  }

  // ==================== DOM 渲染 ====================

  function textOf(doc, id, value) {
    var el = doc.getElementById(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  /**
   * 把 view 画到 DOM 上。传入 nowMs 是为了让「倒计时插值」可测：
   * 测试里给一个固定时刻，断言就完全确定，不需要等真实时间流逝。
   */
  function render(doc, view, nowMs) {
    if (!doc) return;
    var v = view || {};
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    var a = anchorsOf(v);

    var remain = null;
    if (a.nextAt != null) remain = a.nextAt - now;
    else if (a.curEndAt != null) remain = a.curEndAt - now;

    var card = doc.getElementById('card');
    // data-phase 同时驱动配色与进度条的显隐（见 widget.css）
    if (card && card.setAttribute) card.setAttribute('data-phase', v.phase || 'nodata');

    textOf(doc, 'wTerm', termOf(v));
    textOf(doc, 'wClock', v.clock || '');
    textOf(doc, 'wHeadline', headlineOf(v, remain));
    textOf(doc, 'wName', nameOf(v));
    textOf(doc, 'wMeta', metaOf(v));
    textOf(doc, 'wToday', todayTextOf(v));
    textOf(doc, 'wDate', v.dateLabel || '');
    textOf(doc, 'wEvent', eventLineOf(v));

    var fill = doc.getElementById('wFill');
    if (fill && fill.style) {
      var pct = percentOf(a, now);
      if (pct == null) pct = (v.current && v.current.percent != null) ? v.current.percent : 0;
      fill.style.width = Math.round(pct) + '%';
    }
  }

  /** 顶部左边：学期与周次 */
  function termOf(view) {
    var v = view || {};
    if (!v.hasData) return '课表工坊';
    var bits = [];
    if (v.weekLabel) bits.push(v.weekLabel);
    if (v.weekdayLabel) bits.push(v.weekdayLabel);
    var head = bits.join(' · ');
    return v.semesterName ? (head ? head + ' · ' + v.semesterName : v.semesterName) : head;
  }

  /**
   * 挂载：接上桥、定时刷新。
   * 桥或文档缺失时返回一个空壳句柄而不是抛异常 ——
   * 页面可能被当作普通网页打开（没有 preload），那时该安静地什么都不做。
   * @returns {{apply:Function, paint:Function, pull:Function, stop:Function}}
   */
  function boot(api, doc) {
    if (!api || !doc) {
      var noop = function () {};
      return { apply: noop, paint: noop, pull: noop, stop: noop };
    }
    var state = { view: null, anchors: null };

    function paint() {
      render(doc, state.view, Date.now());
    }

    function apply(view) {
      state.view = view || null;
      state.anchors = anchorsOf(state.view);
      paint();
    }

    function pull() {
      var r = null;
      try { r = api.getView(); } catch (e) { return; }
      // 桥返回的是 Promise；用 Promise.resolve 包一层，
      // 免得某个实现同步返回值时这里拿到 undefined 而静默不更新
      Promise.resolve(r).then(apply, function () { /* 主进程没应答就保持上一帧 */ });
    }

    var close = doc.getElementById('btnClose');
    if (close) close.addEventListener('click', function () { api.hide(); });
    var open = doc.getElementById('btnOpen');
    if (open) open.addEventListener('click', function () { api.openMain(); });
    var refresh = doc.getElementById('btnRefresh');
    if (refresh) refresh.addEventListener('click', pull);

    if (typeof api.onUpdate === 'function') api.onUpdate(apply);
    pull();

    // 每秒重画一次：只改文字和进度条宽度，主进程那边完全不用参与
    var timer = setInterval(paint, 1000);
    return {
      apply: apply,
      paint: paint,
      pull: pull,
      stop: function () { clearInterval(timer); }
    };
  }

  return {
    LOOKAHEAD_DAYS: LOOKAHEAD_DAYS,
    remainText: remainText,
    headlineOf: headlineOf,
    subjectOf: subjectOf,
    nameOf: nameOf,
    metaOf: metaOf,
    todayTextOf: todayTextOf,
    termOf: termOf,
    anchorsOf: anchorsOf,
    percentOf: percentOf,
    eventLineOf: eventLineOf,
    render: render,
    boot: boot
  };
});
