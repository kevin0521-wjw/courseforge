/**
 * CourseForge 课表文本解析引擎（纯函数，无 DOM 依赖）
 * 从「教务系统复制文本 / OCR 识别文本 / PDF 提取文本」中解析出课程条目
 * 支持：星期（周一/星期一/礼拜一）、节次（第3-4节 / 3,4节 / 5-6节）、
 *       周次（1-16周 / 单周 / 双周 / 1-8,10-16周）、时间（18:00-19:40 → 节次映射）、
 *       地点（X楼201 / BJ102 / 体育馆 等）与教师（显式标注或末尾短词启发式）
 * UMD 导出：浏览器挂 window.CourseParser，Node 直接 require 测试
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.CourseParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 中文星期 → 数字（1=周一 … 7=周日） */
  var DAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

  /** 课表表头/无关行关键词（命中即整行跳过） */
  var HEADER_WORDS = /(课程表|时间表|学期|学年|节次|星期几|上午|下午|晚上|作息|总课表|个人课表)/;

  // ==================== 基础工具 ====================

  /** 全角数字/标点 → 半角，统一各种破折号，方便正则处理 */
  function normalizeLine(s) {
    return String(s == null ? '' : s)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/[：]/g, ':').replace(/[，]/g, ',')
      .replace(/[－—–~～]/g, '-')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /** 展开数字区间；b 为空时返回单元素数组；a>b 自动交换 */
  function expandRange(a, b) {
    a = Number(a);
    if (b == null || b === '') return [a];
    b = Number(b);
    if (b < a) { var t = a; a = b; b = t; }
    var out = [];
    for (var i = a; i <= b; i++) out.push(i);
    return out;
  }

  /**
   * 解析周次描述文本 → 周次数组（升序去重）
   * 支持：'1-16'、'1,3,5-8'、'1-16(单)'、'2-16(双)'、'第1-16周'
   * 无有效内容返回 null（由调用方决定默认值）
   */
  function parseWeeksSpec(str) {
    var s = String(str == null ? '' : str);
    var parity = null;
    if (/单/.test(s)) parity = 'odd';
    else if (/双/.test(s)) parity = 'even';
    var weeks = [];
    var re = /(\d{1,2})\s*(?:[-]\s*(\d{1,2}))?/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var arr = expandRange(m[1], m[2]);
      for (var i = 0; i < arr.length; i++) {
        var w = arr[i];
        if (w >= 1 && w <= 60 && weeks.indexOf(w) === -1) weeks.push(w);
      }
    }
    if (!weeks.length) return null;
    weeks.sort(function (a, b) { return a - b; });
    if (parity === 'odd') weeks = weeks.filter(function (w) { return w % 2 === 1; });
    if (parity === 'even') weeks = weeks.filter(function (w) { return w % 2 === 0; });
    return weeks;
  }

  // ==================== 行内特征提取 ====================

  /** 提取行内所有星期（可多个，如「周一,周三」），返回数字数组；无则 [] */
  function extractDays(s) {
    var out = [];
    var re = /(?:星期|周|礼拜)\s*([一二三四五六日天])/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var d = DAY_MAP[m[1]];
      if (d && out.indexOf(d) === -1) out.push(d);
    }
    return out;
  }

  /** 提取行内周次区间（'1-16周'、'第3周'），返回 {weeks, matched:[原文]}；无则 {weeks:null, matched:[]} */
  function extractWeeks(s) {
    var matched = [];
    var nums = [];
    var re = /(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*周/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      matched.push(m[0]);
      var arr = expandRange(m[1], m[2]);
      for (var i = 0; i < arr.length; i++) {
        if (nums.indexOf(arr[i]) === -1) nums.push(arr[i]);
      }
    }
    if (!nums.length) return { weeks: null, matched: matched };
    nums.sort(function (a, b) { return a - b; });
    // 行内带「单/双」标记时做奇偶过滤（兼容 1-16周(单) / 单周 两种写法）
    if (/(单周|\(单\))/.test(s)) nums = nums.filter(function (w) { return w % 2 === 1; });
    else if (/(双周|\(双\))/.test(s)) nums = nums.filter(function (w) { return w % 2 === 0; });
    return { weeks: nums, matched: matched };
  }

  /** 提取节次，返回 {start, end, matched}；识别失败返回 null */
  function extractSections(s) {
    var m;
    // 第3-4节 / 第3,4节 / 第3节（含可选区间）
    m = /第\s*(\d{1,2})\s*(?:[-,]\s*(\d{1,2}))?\s*节/.exec(s);
    if (m) return { start: Number(m[1]), end: Number(m[2] || m[1]), matched: m[0] };
    // 3,4节 / 3、4节
    m = /(\d{1,2})\s*[,、]\s*(\d{1,2})\s*节/.exec(s);
    if (m) return { start: Number(m[1]), end: Number(m[2]), matched: m[0] };
    // 3-4节
    m = /(\d{1,2})\s*-\s*(\d{1,2})\s*节/.exec(s);
    if (m) return { start: Number(m[1]), end: Number(m[2]), matched: m[0] };
    return null;
  }

  /** 兜底：无「节」字时，识别「周一 3-4」这类紧凑写法（排除周次/时间/纯数字回溯） */
  function extractBareSections(s) {
    var m = /(?:^|[^\d:])(\d{1,2})\s*-\s*(\d{1,2})(?![\d\s]*[周:：])/.exec(s);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 14 && Number(m[2]) >= Number(m[1]) && Number(m[2]) <= 14) {
      return { start: Number(m[1]), end: Number(m[2]), matched: m[0].replace(/^[^\d]/, '') };
    }
    return null;
  }

  /** 'HH:MM-HH:MM' 起止时间 → 按作息表映射节次；无法映射返回 null */
  function extractSectionsByTime(s, sectionTimes) {
    var m = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(s);
    if (!m || !sectionTimes || !sectionTimes.length) return null;
    var startMin = Number(m[1]) * 60 + Number(m[2]);
    var endMin = Number(m[3]) * 60 + Number(m[4]);
    var start = 0, end = 0;
    for (var i = 0; i < sectionTimes.length; i++) {
      var t = sectionTimes[i] || {};
      if (toMin(t.start) === startMin) start = i + 1;
      if (toMin(t.end) === endMin) end = i + 1;
    }
    if (!start || !end) return null;
    return { start: start, end: Math.max(start, end), matched: m[0] };
  }

  function toMin(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  // ==================== 名称/地点/教师启发式 ====================

  /** 判断 token 是否像地点：教学楼/机房/体育馆/B\\d{3} 等 */
  function looksLikeLocation(t) {
    if (!t) return false;
    if (/(楼|馆|室|厅|房|栋|校区|操场|场)/.test(t)) return true;
    if (/^[A-Za-z]{1,4}\d{2,4}$/.test(t)) return true; // BJ102 / D202
    if (/^\d{3,4}$/.test(t)) return true;               // 纯教室号 301
    // 「教」单独不能当关键词（教育学/教育心理学都是课程名），必须带房间号才算：
    // 东区一教101 / 一教101 / 教三301
    if (/(?:教|楼|馆|室|厅|房|栋)[\u4e00-\u9fa5]{0,3}\d{1,4}[室A-Za-z]?$/.test(t)) return true;
    return false;
  }

  /**
   * 判断 token 是否像课程名。
   * 课名多为 2~12 个汉字，且常带「学/论/语/原理/导论/基础/实验/设计/技术/概论」等词尾；
   * 这些词尾正是人名不会有的，用它把课名与人名区分开。
   */
  function looksLikeCourseName(t) {
    if (!t) return false;
    if (looksLikeLocation(t)) return false;
    if (!/^[\u4e00-\u9fa5A-Za-z0-9+()（）\-·\s]{2,30}$/.test(t)) return false;
    // 典型课名词尾（人名几乎不会以此结尾）
    if (/(?:学|论|语|文|原理|导论|基础|实验|设计|技术|概论|方法|分析|结构|系统|数学|物理|化学|编程|经济|管理|史|纲要|政策|教育|体育|英语|训练|实践|专题|研究|应用|制作|赏析|欣赏)$/.test(t)) {
      return true;
    }
    // 含「+」「程序设计」「人工智能」等课程常见构词
    if (/[+＋]|程序设计|人工智能|数据库|计算机网络|操作系统/.test(t)) return true;
    // 其余长于 4 个汉字的，基本可以排除人名
    if (/^[\u4e00-\u9fa5]{5,}$/.test(t)) return true;
    return false;
  }

  /**
   * 判断 token 是否像教师名：2-4 个汉字（可带 老师/教授/讲师 后缀），且不含地点词。
   * 注意：中文姓名与「学术英语」这类短课名都是 2~4 个汉字，单看字数无法区分 ——
   * 所以这里排除掉「像课程名」的词，避免把课程名当成教师名（会导致课名被上一行覆盖）。
   */
  function looksLikeTeacher(t) {
    if (!t) return false;
    if (looksLikeLocation(t)) return false;
    if (looksLikeCourseName(t)) return false;
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(t)) return true;
    if (/^[\u4e00-\u9fa5]{2,4}(老师|教授|讲师|副教授)$/.test(t)) return true;
    return false;
  }

  /**
   * 剥掉课名尾部粘连的括号编号与节次括号。
   * 「体育(1)(GBK2800002)」→「体育」；「高等数学 B(1)(GBK0101003)」→「高等数学 B」；
   * 但「大学英语(听说)」这种括号里有汉字的要保留。
   *
   * 注意：不能只看单个 token —— splitRest 已按空白切分，「高等数学 B(1)(GBK0101003)」
   * 传进来的 token 其实只有「B(1)(GBK0101003)」，单看它会把合法的「B」一起剥掉。
   * 所以这里改用「空白 + 括号编号」的整体正则，在完整课名上剥离。
   */
  function stripCourseCode(name) {
    if (!name) return '';
    var out = String(name);
    // 反复剥离「(纯数字)」或「(字母数字编号，至少含一位数字)」，允许括号前有空格
    for (var guard = 0; guard < 4; guard++) {
      var next = out.replace(/\s*[（(\[]\s*(?:\d{1,2}|[A-Za-z][A-Za-z0-9\-—_.\/]*\d[A-Za-z0-9\-—_.\/]*|\d[A-Za-z0-9\-—_.\/]*)\s*[)）\]]\s*$/g, '');
      if (next === out) break;
      if (!next.trim()) break;  // 剥空了说明整串都是括号，保留原值更安全
      out = next;
    }
    // 收尾：去掉节次被摘除后留下的「孤立左括号」。
    // 形如「体育(7-8节)」—— 节次片段「(7-8节)」被主流程移走时会连带吃掉右括号，
    // 只剩一个「(」粘在课名尾部（实测会得到课名「体育(」）。
    out = out.replace(/[\s（(\[【]+$/, '');
    return out.trim();
  }

  /** 从行剩余文本中拆出 {name, teacher, location}
   *  课表行的典型顺序：课程名(前) … 地点(中) … 教师(后)
   *  因此：课程名 = 第一个非地点 token；教师 = 最后一个非地点 token（需像人名且≠课程名） */
  function splitRest(rest) {
    var tokens = rest.split(/[\s,;、/|·]+/).filter(function (t) {
      if (!t) return false;
      if (/^[()\[\]（）\-:：.]+$/.test(t)) return false;       // 纯符号残片
      return true;
    });
    var nonLoc = tokens.filter(function (t) { return !looksLikeLocation(t); });
    // 课名可能跨多个 token（「高等数学 B(1)(GBK0101003)」= 高等数学 + B(...)）。
    // 只取 nonLoc[0] 会丢掉「B」，所以把「后续 token 本身就是括号编号形态」的情形拼回来。
    // 关键：拼接条件必须很窄 —— 只有形如 `X(1)(CODE)` 的续写才拼，
    // 否则会把「第1-16周」的「第」、地点、教师一并吞进课名（实测会撞坏 4 个既有用例）。
    var nameParts = [nonLoc.length ? nonLoc[0] : ''];
    for (var n = 1; n < nonLoc.length; n++) {
      var tok = nonLoc[n];
      // 仅当「上一个片段已含括号编号」且「本 token 是字母/数字开头的短代号(带括号编号)」才续拼
      var prevHasCode = /[（(\[][^（()）\[\]]*[）)\]]\s*$/.test(nameParts[nameParts.length - 1]);
      var isCodeContinuation = /^[A-Za-z][A-Za-z0-9\-—_.]{0,9}(\s*[（(\[][^（()）\[\]]*[）)\]]\s*)+$/.test(tok);
      if (!(isCodeContinuation || (prevHasCode && /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(tok)))) break;
      nameParts.push(tok);
    }
    var name = stripCourseCode(nameParts.join(' '));
    // 若拼接结果为空（极端情况），退回单 token 行为
    if (!name && nonLoc.length) name = stripCourseCode(nonLoc[0]);
    var teacher = '';
    if (nonLoc.length >= 2) {
      var last = nonLoc[nonLoc.length - 1];
      if (last !== name && looksLikeTeacher(last)) teacher = last;
    }
    var location = '';
    for (var i = 0; i < tokens.length; i++) {
      if (looksLikeLocation(tokens[i])) { location = tokens[i]; break; }
    }
    return { name: name, teacher: teacher, location: location };
  }

  // ==================== 主入口 ====================

  /**
   * 解析课表文本
   * @param {string} text 多行文本
   * @param {object} opts { sectionTimes: [{label,start,end}], totalWeeks: Number }
   * @returns {{ items: Array, warnings: Array<string> }}
   *   item: { name, teacher, location, day, startSection, endSection, weeks, raw }
   *   startSection/endSection/weeks 可能为 null（识别失败，留待确认页手工修正）
   */
  function parseScheduleText(text, opts) {
    opts = opts || {};
    var sectionTimes = Array.isArray(opts.sectionTimes) ? opts.sectionTimes : null;
    var items = [];
    var warnings = [];
    var pendingName = ''; // 上一行识别出的课程名（处理「课程名一行、详情一行」的排版）

    var lines = String(text == null ? '' : text).split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var raw = lines[li].trim();
      if (!raw) continue;
      var s = normalizeLine(raw);

      var days = extractDays(s);
      var wk = extractWeeks(s);
      var sec = extractSections(s);
      var timeSec = null;

      // 去掉已识别片段，剩下的部分用来拆名称/地点/教师
      var rest = s;
      var removeMatched = function (arr) {
        for (var k = 0; k < arr.length; k++) rest = rest.split(arr[k]).join(' ');
      };

      // 表头/无关行：多星期且无节次 → 整行跳过
      if (days.length >= 3 && !sec) continue;
      if (HEADER_WORDS.test(s) && !sec && !days.length) continue;

      // 显式教师标注：教师:张三 / 老师:张三
      // 捕获必须止于「/ | , ; 」等分隔符，否则「教师:闵伟/选 课备注:…」会把「/选」一起吞进来；
      // 也止于「地点:」这类下一个标注的开头，避免「教师:胡珉/地点:东区一教101」整段被当成教师。
      var teacherExplicit = '';
      var tm = /(?:教师|老师|授课)[:：]\s*([^\s,;，/|、]+)/.exec(rest);
      if (tm) {
        teacherExplicit = tm[1].replace(/(?:地点|教室|授课地点|上课地点)[:：]?.*$/, '').trim();
      }

      // 显式地点标注：地点:东区一教101 / 教室:东区一教101
      // 网格型课表与列表型课表由调用方明确知道哪一列/哪一行是地点，
      // 用标注传进来比依赖启发式猜更可靠（如「东区一教101」这种写法容易漏判）。
      var locationExplicit = '';
      var lm = /(?:地点|教室|上课地点|授课地点)[:：]\s*([^\s,;，]+)/.exec(rest);
      if (lm) {
        locationExplicit = lm[1];
        rest = rest.split(lm[0]).join(' '); // 从剩余文本里摘掉，避免污染课程名/教师
      }

      // 节次识别：先标准节次 → 时间映射 → 紧凑兜底
      if (!sec) {
        timeSec = extractSectionsByTime(s, sectionTimes);
        if (timeSec) sec = timeSec;
      }
      if (!sec) {
        // 先从副本中剥离周次片段，再做紧凑节次兜底（防止「1-16周」被误读为「1-1节」）
        var restNoWeeks = rest;
        for (var k2 = 0; k2 < wk.matched.length; k2++) {
          restNoWeeks = restNoWeeks.split(wk.matched[k2]).join(' ');
        }
        var bare = extractBareSections(restNoWeeks);
        if (bare) sec = bare;
      }

      // 清理 rest：去掉星期、周次、节次、时间、显式教师片段
      var dayMatches = s.match(/(?:星期|周|礼拜)\s*[一二三四五六日天]/g) || [];
      removeMatched(dayMatches);
      removeMatched(wk.matched);
      if (sec && sec.matched) rest = rest.split(sec.matched).join(' ');
      if (timeSec && timeSec.matched) rest = rest.split(timeSec.matched).join(' ');
      if (/(单周|\(单\))/.test(rest)) rest = rest.replace(/单周|\(单\)/g, ' ');
      if (/(双周|\(双\))/.test(rest)) rest = rest.replace(/双周|\(双\)/g, ' ');
      // 显式教师标注可能被「/」切成多段（教师:闵伟/选 课备注:…）。
      // 只删一次会留下「/选」这类残片，而残片一旦排在课名前就会被 splitRest
      // 当成课名（实测「教师:闵伟/选 体育…」会解析出课名「选」）。
      // 所以这里做两件事：
      //   1) 吃掉「教师:xxx」及其后的分隔符与紧跟的选课类型残片（选/必/限/任/公选…）
      //   2) 确保残片被清干净，避免污染课名
      if (teacherExplicit) {
        rest = rest.replace(
          /(?:教师|老师|授课)[:：]\s*[^\s,;，/|、]*\s*[/|]?\s*(?:选修|必修|限选|任选|公选|选|必)?\s*/g,
          ' '
        );
      }
      rest = rest.replace(/第?\s*节/g, ' ');

      var parts = splitRest(rest);

      // 名称判定：仅当「该行只有一个人名样 token、没有其他教师候选」时，
      // 才认为它是教师并沿用上一行的课程名上下文（如「教学楼B105 陈老师」详情行）。
      // 行内已有独立教师候选（parts.teacher 非空）时，说明 parts.name 是真课程名，严禁互换。
      var name = parts.name;
      var teacher = parts.teacher;
      // 「互换」只在确实像详情行时才做：本行唯一可当课名的 token 其实像人名，
      // 且上一行留下了课名（pendingName）—— 形如「教学楼B105 陈老师」这种详情行。
      // 判据必须是「像人名且不像课名」（中文短课名如「学术英语」与人名同形，
      // 只看字数会误换，导致本行课名被上一行顶替；批量解析教务课表时必现串台）。
      if (name && pendingName && !teacher && looksLikeTeacher(name) && !looksLikeCourseName(name)) {
        teacher = name;
        name = pendingName;
      }
      // pendingName 只服务于「课名独占一行、详情在下一行」的相邻两行排版。
      // 用完立刻清空：否则下一行若没能解析出课名，会把上一条的课名继承过来。
      if (!name) {
        name = pendingName;
        pendingName = '';
      } else {
        pendingName = name;
      }
      // 显式「教师:xxx」标注优先级最高
      if (teacherExplicit) teacher = teacherExplicit;

      // 整行啥也没匹配到：当作待定课程名（可能下一行是详情），不告警
      if (!name && !days.length && !sec && !wk.weeks) {
        if (s.length <= 30 && /[\u4e00-\u9fa5A-Za-z]/.test(s)) pendingName = s.split(/\s+/)[0];
        continue;
      }

      if (!name) {
        warnings.push('无法识别课程名：' + raw);
        continue;
      }
      if (!days.length) {
        warnings.push('《' + name + '》缺少星期，已跳过：' + raw);
        continue;
      }

      // 每个星期生成一条（同一门课一周多次课）
      for (var di = 0; di < days.length; di++) {
        items.push({
          name: name,
          teacher: teacherExplicit || parts.teacher || '',
          location: locationExplicit || parts.location || '',
          day: days[di],
          startSection: sec ? sec.start : null,
          endSection: sec ? sec.end : null,
          weeks: wk.weeks || null,
          raw: raw
        });
      }

      if (!sec) warnings.push('《' + name + '》未能识别节次，请在确认页手工补填');
      if (!wk.weeks) { /* 周次缺省，由确认页按 totalWeeks 给默认 */ }
    }

    return { items: items, warnings: warnings };
  }

  // ==================== 导出 ====================

  return {
    parseScheduleText: parseScheduleText,
    parseWeeksSpec: parseWeeksSpec,
    DAY_MAP: DAY_MAP,
    // 供 edu-html.js（教务系统 HTML 课表解析）复用，避免重复实现同一套特征提取
    normalizeLine: normalizeLine,
    extractDays: extractDays,
    extractWeeks: extractWeeks,
    extractSections: extractSections,
    extractSectionsByTime: extractSectionsByTime,
    looksLikeLocation: looksLikeLocation,
    looksLikeTeacher: looksLikeTeacher,
    splitRest: splitRest
  };
});
