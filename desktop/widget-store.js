/**
 * 桌面常驻小组件的数据中枢
 *
 * 职责很窄：持有「当前课表」的一份内存快照，把它翻译成**三处共用**的展示数据 ——
 *   ① 托盘 tooltip      ② 托盘菜单第一行      ③ 小组件窗口
 * 三处若各算各的，迟早出现「托盘说 8:00、窗口说 8:05」这种自相矛盾。
 * 所以判定逻辑只写一遍 —— 就在 web/js/remind.js 里 —— 这里只负责组装文案与形状。
 *
 * 为什么主进程敢直接复用网页端的 core.js / remind.js：
 *   它们是 UMD 模块，Node 侧 require 即可。这是**唯一**能保证「网页里看到的」
 *   与「托盘里显示的」永远一致的做法；复制一份逻辑过来，改一边忘一边只是时间问题。
 *
 * 为什么快照只在内存、不落盘：
 *   课表已经由网页端存进 localStorage，主进程再存一份就是两份真相，
 *   而且用户「删掉某个学期」之后托盘上会残留旧数据 —— 很难被发现的那种 bug。
 *   这里只服务于当前这次运行，启动时由主窗口推一次即可。
 *   真正需要落盘的是「小组件在屏幕上的位置 / 是否显示」这类偏好，那在 desktop-shell.js 里。
 *
 * 不依赖 electron，可直接被 node --test 单测（这也是它单独成文件的原因）。
 */
'use strict';

const path = require('path');

/** 往后找课的最大天数：托盘上写「接下来 14 天没有课」比无限找更诚实 */
const LOOKAHEAD_DAYS = 14;

/** 节次文本：'第 1-2 节' / '第 3 节' */
function sectionText(course) {
  const s = Number(course && course.startSection) || 0;
  const e = Number(course && course.endSection) || 0;
  if (!s) return '';
  if (!e || e === s) return '第 ' + s + ' 节';
  return '第 ' + s + '-' + e + ' 节';
}

/** '9 月 16 日' */
function dateLabel(d) {
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

/**
 * 周次文案。
 * 特意区分「还没开学」与「学期已结束」：直接显示「第 0 周」「第 25 周」
 * 会让人以为程序算错了，而实际上这两种情况在开学前后每天都会遇到。
 */
function weekLabelOf(week, totalWeeks) {
  if (!isFinite(week)) return '';
  if (week < 1) return '未开学';
  if (totalWeeks && week > totalWeeks) return '学期已结束';
  return '第 ' + week + ' 周';
}

/**
 * 把 dayTimeline 的 item 转成可跨 IPC 传递的纯数据。
 * 关键：Date 对象不能直接给对方 —— 渲染进程要自己按秒插值倒计时，
 * 所以这里换算成「距现在多少分钟」，并把基准时刻一并给出（computedAt）。
 */
function itemOf(raw, now, daysAhead, dayLabel, CF, R, settings) {
  const c = raw.course || {};
  const startInMin = Math.round((raw.start - now) / 60000);
  const endInMin = Math.round((raw.end - now) / 60000);
  const totalMin = Math.round((raw.end - raw.start) / 60000);
  const state = startInMin > 0 ? 'before' : (endInMin > 0 ? 'now' : 'done');
  const st = CF.getSectionTime(settings, c.startSection);
  const et = CF.getSectionTime(settings, c.endSection);
  return {
    name: c.name || '未命名课程',
    location: c.location || '',
    teacher: c.teacher || '',
    note: c.note || '',
    startText: st.start || '',
    endText: et.end || '',
    rangeText: CF.sectionRangeText(settings, c),
    sectionText: sectionText(c),
    weeksText: CF.weeksText ? (CF.weeksText(c.weeks) || '') : '',
    dayLabel: dayLabel,
    daysAhead: daysAhead,
    state: state,
    // 精确的上/下课时刻（epoch ms）。
    // ⚠️ 必须给这个，不能让渲染层用 startsInMin 反推：那个字段取整到分钟，
    //    反推出来的「上课那一刻」最多会偏 30 秒，而渲染层在最后十分钟要显示到秒 ——
    //    倒计时会比真实打铃时间早或晚半分钟，正好落在学生最在意的那个窗口里。
    startAt: raw.start.getTime(),
    endAt: raw.end.getTime(),
    // 只有「今天的课」才谈得上倒计时；跨天的课给 null，
    // 由界面写成「明天 08:00」而不是「还有 1020 分钟」——后者没人愿意心算
    startsInMin: daysAhead === 0 ? startInMin : null,
    endsInMin: daysAhead === 0 && state === 'now' ? endInMin : null,
    // totalMin 让渲染层能自己插值进度条，不必每秒再问一次主进程
    totalMin: totalMin,
    percent: state === 'now' && totalMin > 0
      ? Math.max(0, Math.min(100, Math.round((totalMin - endInMin) / totalMin * 100)))
      : null
  };
}

/**
 * 一句话状态。托盘 tooltip 与小组件顶部都用它，避免两处措辞不一致。
 *
 * 按显式 phase 分支而不是一路 if 到底 —— 因为「没开学」「已结课」「放假」「作息缺失」
 * 这几种情况都会表现为「没有下一节课」，用条件顺序去区分迟早会漏掉一种，
 * 而它们的成因和用户该做的事完全不同。
 *
 * @returns {string}
 */
function statusLineOf(view) {
  if (!view.hasData) return '还没有课表 —— 打开课表导入或新建';

  if (view.phase === 'beforeterm') {
    return view.daysToStart > 0
      ? '距开学还有 ' + view.daysToStart + ' 天'
      : '学期即将开始';
  }
  if (view.phase === 'afterterm') return '学期已结束';

  if (view.phase === 'off') {
    return view.next
      ? '今天放假 · 下次课 ' + view.next.dayLabel + ' ' + view.next.startText
      : '今天放假';
  }

  if (view.current) {
    return '正在上 ' + view.current.name + ' · 还有 ' + view.current.endsInMin + ' 分钟';
  }

  if (view.next) {
    const n = view.next;
    if (n.daysAhead === 0) {
      // 措辞上留出「马上上课：」这一档：倒计时归零后还在这一节开始前的窗口里，
      // 写成「0 分钟后上课」很怪，写成「马上上 X」则不成话
      const lead = n.startsInMin <= 0 ? '马上上课：' : (n.startsInMin + ' 分钟后上课：');
      return lead + n.name + (n.location ? ' · ' + n.location : '');
    }
    return n.dayLabel + ' ' + n.startText + ' ' + n.name + (n.location ? ' · ' + n.location : '');
  }

  if (view.phase === 'missing') {
    // 有课却算不出时间，几乎总是「作息没配」，这是个和「没课」完全不同的故障
    return '有课但作息时间缺失 —— 打开课表检查作息设置';
  }
  return '接下来 ' + LOOKAHEAD_DAYS + ' 天没有课';
}

/**
 * 跨天的课该怎么称呼。
 * 关键是别把「下周三」说成「周三」—— 在周五看来「周三」默认指本周那个已经过去的周三，
 * 于是这句提示等于没说清楚。判据是「从今天走到那天会不会跨过一个周一」。
 *
 * ⚠️ 拼接时只能加「本」或「下」，**不能加「本周」「下周」** ——
 * DAY_NAMES 里已经是「周三」这种带「周」的写法，写全就成了「下周周三」。
 * （同一个坑在分享图的「1-16 周周」上已经踩过一次，见 share-image.js。）
 */
function dayLabelFor(now, daysAhead, targetStart, CF, R) {
  if (daysAhead === 0) return '今天';
  if (daysAhead === 1) return '明天';
  const sameWeek = (R.weekdayOf(now) + daysAhead) <= 7;
  return (sameWeek ? '本' : '下') + CF.DAY_NAMES[R.weekdayOf(targetStart) - 1];
}

/**
 * @param {object} opts
 * @param {string} [opts.webJsDir] core.js / remind.js 所在目录（默认 desktop/../web/js）
 * @param {function} [opts.log]
 */
function createWidgetStore(opts) {
  const o = opts || {};
  // require 的相对路径是相对**本模块**解析的，调用方传相对路径必然找不到文件，
  // 所以这里统一 resolve 成绝对路径 —— 免得每个调用点各自记得传绝对路径
  const webJsDir = path.resolve(o.webJsDir || path.join(__dirname, '..', 'web', 'js'));
  const log = typeof o.log === 'function' ? o.log : function () {};

  // 复用网页端同一份判定逻辑（UMD，Node 侧可直接 require）
  const CF = require(path.join(webJsDir, 'core.js'));
  const R = require(path.join(webJsDir, 'remind.js'));

  let workspace = null;

  /**
   * 更新快照。传入任何东西都不会抛：非法输入按「没有数据」处理，
   * 因为这是 IPC 的另一端，一个坏包不该把托盘整个搞挂。
   */
  function setWorkspace(raw) {
    let ws = null;
    try {
      ws = CF.normalizeWorkspace(raw);
    } catch (e) {
      log('课表快照解析失败：' + ((e && e.message) || e));
      ws = null;
    }
    workspace = ws;
    return !!ws;
  }

  function hasWorkspace() {
    return !!workspace;
  }

  function clear() {
    workspace = null;
  }

  /** 兜底的空视图：所有字段都在，界面不需要到处写 `view.next &&` */
  function emptyView(now) {
    return {
      hasData: false,
      computedAt: now.getTime(),
      clock: R.hhmm(now),
      date: CF.formatDate(now),
      dateLabel: dateLabel(now),
      weekday: R.weekdayOf(now),
      weekdayLabel: CF.DAY_NAMES[R.weekdayOf(now) - 1],
      semesterName: '',
      week: 0,
      weekLabel: '',
      inTerm: false,
      off: false,
      totalWeeks: 0,
      courseCount: 0,
      todayCount: 0,
      todayRemaining: 0,
      daysToStart: 0,
      termStart: '',
      termStartLabel: '',
      // phase 是状态的单一真相源，statusLine 只是它的文案投影；
      // 界面也可以据此换配色（如放假用灰、正在上用强调色）
      phase: 'nodata',
      current: null,
      next: null,
      events: []
    };
  }

  /** 完整视图（小组件窗口用；托盘 tooltip 由它派生，保证两边一致） */
  function buildView(now) {
    const t = (now instanceof Date) ? now : new Date();
    const view = emptyView(t);

    const sem = workspace ? CF.activeSemester(workspace) : null;
    if (!sem) {
      view.statusLine = statusLineOf(view);
      return view;
    }

    const settings = sem.settings || {};
    const courses = sem.courses || [];
    const totalWeeks = settings.totalWeeks || 20;
    const week = CF.getWeekNumber(settings.semesterStart, t);

    view.hasData = true;
    view.semesterName = sem.name || '';
    view.week = week;
    view.weekLabel = weekLabelOf(week, totalWeeks);
    view.inTerm = week >= 1 && week <= totalWeeks;
    view.totalWeeks = totalWeeks;
    view.courseCount = courses.length;
    view.termStart = settings.semesterStart || '';
    const sd = CF.parseDate(view.termStart);
    view.termStartLabel = sd ? dateLabel(sd) : '';

    // 距开学天数：只在开学前有意义（开学后置 0，免得界面拿到负数还要自己判断）
    if (week < 1) {
      const first = CF.mondayOfWeek(settings.semesterStart, 1);
      if (first) {
        view.daysToStart = Math.max(0,
          Math.round((CF.startOfDay(first) - CF.startOfDay(t)) / 86400000));
      }
    }

    const tl = R.dayTimeline(courses, settings, t);
    view.off = !!tl.off;
    view.todayCount = tl.items.length;

    // 「今天有课但算不出时间」= 作息缺失。只看 items 是查不出来的：
    // 作息缺失时 items 也是空，跟「今天没课」长得一模一样。
    const listedToday = tl.off ? [] : CF.getDayCourses(courses, week, R.weekdayOf(t));
    const missingTimes = listedToday.length > 0 && tl.items.length === 0;

    if (tl.current) {
      view.current = itemOf(tl.current, t, 0, '今天', CF, R, settings);
    }

    // 今天 (0) → 明天 (1) → 之后按「本周X / 下周X」叫，用 nextUpcoming 一次找齐
    const hit = R.nextUpcoming(courses, settings, t, LOOKAHEAD_DAYS);
    if (hit) {
      view.next = itemOf(hit.item, t, hit.daysAhead,
        dayLabelFor(t, hit.daysAhead, hit.item.start, CF, R), CF, R, settings);
    }

    // 今日还要上几节（不含正在上的那节）
    for (let i = 0; i < tl.items.length; i++) {
      if (tl.items[i].start > t) view.todayRemaining++;
    }

    // 状态的单一真相源：优先级从「整个学期」到「今天此刻」逐级收窄
    if (week < 1) view.phase = 'beforeterm';
    else if (totalWeeks && week > totalWeeks) view.phase = 'afterterm';
    else if (view.off) view.phase = 'off';
    else if (view.current) view.phase = 'current';
    else if (view.next) view.phase = 'next';
    else if (missingTimes) view.phase = 'missing';
    else view.phase = 'none';

    view.statusLine = statusLineOf(view);

    // 考试与自定义事件：跟课程无关，无论学期内还是假期都展示
    // （「暑假里还挂着 8 月底的驾照考试」是合理诉求，不能因为放假就吞掉）
    view.events = CF.upcomingEvents(sem.events, t, 2);
    return view;
  }

  /** 托盘 tooltip：两行，第一行是周次与日期，第二行是状态 */
  function tooltip(now) {
    const v = buildView(now);
    const head = v.hasData
      ? ('课表工坊 · ' + (v.weekLabel ? v.weekLabel + ' ' : '') + v.weekdayLabel + ' ' + v.date)
      : '课表工坊';
    let line = v.statusLine || '';
    // 7 天内的考试值得在托盘上占一行 —— 学生看托盘就是怕错过东西
    // （普通事件不上托盘：截止日是自己记的事，托盘留给最硬的 deadline）
    let examLine = '';
    if (v.hasData && Array.isArray(v.events)) {
      for (let i = 0; i < v.events.length; i++) {
        const ev = v.events[i];
        if (ev.kind !== 'exam' || ev.daysLeft > 7) continue;
        examLine = '📝 ' + ev.name + ' ' + (ev.countdownText || CF.countdownTextOf(ev.daysLeft));
        break;
      }
    }
    // Windows 托盘提示超过约 127 字符会被截断，先自己截，免得断在半个字上
    const full = head + (line ? '\n' : '') + line + (examLine ? '\n' + examLine : '');
    return full.length > 120 ? full.slice(0, 119) + '…' : full;
  }

  return {
    setWorkspace: setWorkspace,
    hasWorkspace: hasWorkspace,
    clear: clear,
    buildView: buildView,
    tooltip: tooltip
  };
}

module.exports = {
  createWidgetStore: createWidgetStore,
  statusLineOf: statusLineOf,
  dayLabelFor: dayLabelFor,
  weekLabelOf: weekLabelOf,
  sectionText: sectionText,
  dateLabel: dateLabel,
  LOOKAHEAD_DAYS: LOOKAHEAD_DAYS
};
