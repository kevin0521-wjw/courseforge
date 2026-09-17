/**
 * CourseForge 教务系统 HTML 课表解析（纯函数，无 DOM 依赖）
 *
 * 定位：把教务系统网页里的课表 DOM 直接解析成课程条目，省掉「手工复制文本」这一步。
 * 由于浏览器跨域限制，网页版拿不到教务系统页面；本模块由**桌面端主进程**取回 HTML 后调用，
 * 网页版则走「粘贴文本」。解析逻辑与取数方式解耦，因此可以脱离 Electron 完整单测。
 *
 * 支持的两种版面（教务系统最常见的两类）：
 *  1. 网格型：行=节次、列=星期一…星期日，格子里是课程信息（含 rowspan/colspan 合并单元格）
 *     也支持转置版面（行=星期、列=节次）
 *  2. 列表型：一行一门课，列为 课程名/教师/上课时间/上课地点
 *
 * 实现取舍：
 *  - 自带极简表格解析器，不引任何 HTML 解析库（保持零依赖，且能在 Node 直接测）
 *  - 单元格里的文字交给 parser.js 的启发式引擎处理，不重复造「教师/地点/周次」的识别逻辑
 *  - 识别不到的字段留 null，由导入确认表让用户手工修正（宁可留空也不要猜错）
 *
 * UMD 导出：浏览器挂 window.CourseForgeEdu，Node 直接 require 测试
 */
(function (root, factory) {
  var CP = (typeof module === 'object' && typeof module.exports === 'object')
    ? require('./parser.js')
    : root.CourseParser;
  var api = factory(CP);
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    root.CourseForgeEdu = api;
  }
})(typeof self !== 'undefined' ? self : this, function (CP) {
  'use strict';

  // ==================== HTML 基础：实体解码与标签剥离 ====================

  /** 常见 HTML 实体解码（含数字实体；教务系统里 &nbsp; 极多） */
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
        var code = parseInt(hex, 16);
        return (code >= 0 && code <= 0x10ffff) ? String.fromCodePoint(code) : '';
      })
      .replace(/&#(\d+);/g, function (_, dec) {
        var code = parseInt(dec, 10);
        return (code >= 0 && code <= 0x10ffff) ? String.fromCodePoint(code) : '';
      })
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&amp;/gi, '&'); // &amp; 必须最后处理，否则 &amp;lt; 会被解成 <
  }

  /** 把 <script>/<style> 整段去掉：它们的代码文本会污染单元格内容 */
  function dropScripts(html) {
    return String(html == null ? '' : html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, ''); // 注释里也可能写着课程名，去掉避免误命中
  }

  /**
   * 剥掉标签得到纯文本。
   * 换行规则很关键：<br> 和块级标签的收尾都要转成 \n，
   * 否则「课程名 / 教师 / 地点」会被粘成一个长串，启发式就拆不开了。
   */
  function stripTags(html) {
    return decodeEntities(
      String(html == null ? '' : html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article)\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
    );
  }

  /**
   * 单元格取纯文本。
   * 保留空行：教务系统用空行（往往就是 <br><br> 或一串 &nbsp;）分隔同一格里的多门课，
   * 压掉空行会让几门课粘成一段，所以这里把连续空行统一压成一个「段落分隔」。
   */
  function cellText(html) {
    var lines = stripTags(html).split('\n').map(function (l) {
      return l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim();
    });
    return lines.join('\n')
      .replace(/\n{2,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '')
      .trim();
  }

  /** 单元格按空行切成若干块（每块通常是一门课的完整描述） */
  function cellBlocks(text) {
    return String(text == null ? '' : text)
      .split(/\n{2,}/)
      .map(function (t) { return t.trim(); })
      .filter(function (t) { return t !== ''; });
  }

  /**
   * 解析单元格内容 → 课程条目数组。
   *
   * 这是本模块最容易踩坑的地方，两条路都不通：
   *  - 整段丢给解析引擎：格子内容是「课程名 / 教师 / 地点 / 周次」的字段堆叠，没有星期，
   *    引擎会按「缺少星期」把每一行都丢掉，结果一门课都解析不出来；
   *  - 逐行丢给引擎：每一行都会被当成独立课程，「张老师」也会变成一门课，一门课裂成四门。
   *
   * 因此先按空行切块（一格多课的分隔），每块再按行分类，
   * 最后拼成一行带「地点:」「教师:」显式标注的文本，交给引擎做它擅长的归一化。
   * 一个块 = 一门课，块内信息归并，不会裂开。
   *
   * @param {string} text 单元格文本
   * @param {number} day 该单元格所在列的星期（1-7），用于补足块内缺失的星期
   */
  function blockToLine(block, day) {
    var lines = String(block || '').split('\n').map(function (t) { return t.trim(); })
      .filter(function (t) { return t !== ''; });
    if (!lines.length) return '';

    var name = '', teacher = '', location = '', weeks = '', extra = [];
    var start = 0;

    // 第一行默认是课程名（教务系统网格格子的惯例）。
    // 但如果它本身就是地点或周次行，说明这个格子没写课名，交给后面的分类逻辑处理。
    var first = CP.normalizeLine(lines[0]);
    var firstIsPlace = CP.looksLikeLocation(lines[0]);
    var firstIsWeeks = !!CP.extractWeeks(first).weeks;
    if (lines.length > 1 && !firstIsPlace && !firstIsWeeks) {
      name = lines[0];
      start = 1;
    }

    for (var i = start; i < lines.length; i++) {
      var l = lines[i];
      var n = CP.normalizeLine(l);
      if (!weeks && CP.extractWeeks(n).weeks) { weeks = l; continue; }
      if (!location && CP.looksLikeLocation(l)) { location = l; continue; }
      // 教师判定要排除「已经确定的课程名」，否则 4 字课名（数据结构）会被当成姓名
      if (!teacher && l !== name && CP.looksLikeTeacher(l)) { teacher = l; continue; }
      if (!name) { name = l; continue; }
      extra.push(l);
    }

    var parts = [];
    if (name) parts.push(name);
    if (location) parts.push('地点:' + location.replace(/[\s,;，]+/g, ''));
    if (teacher) parts.push('教师:' + teacher.replace(/[\s,;，]+/g, ''));
    if (weeks) parts.push(weeks);
    for (var k = 0; k < extra.length; k++) parts.push(extra[k]);

    // 块内没写星期就补一个（星期来自列位置），否则引擎会整行丢弃
    if (day && !CP.extractDays(CP.normalizeLine(parts.join(' '))).length) {
      parts.unshift('星期' + DAY_CN[day]);
    }
    return parts.join(' ');
  }

  /** 解析单元格 → 课程条目（按空行分块，每块一门课） */
  function splitCellItems(text, day, opts) {
    var blocks = cellBlocks(text);
    var items = [];
    var warnings = [];
    for (var i = 0; i < blocks.length; i++) {
      var line = blockToLine(blocks[i], day);
      if (!line) continue;
      var res = CP.parseScheduleText(line, opts);
      for (var k = 0; k < res.items.length; k++) items.push(res.items[k]);
      for (var w = 0; w < res.warnings.length; w++) warnings.push(res.warnings[w]);
    }
    return { items: items, warnings: warnings };
  }


  // ==================== 表格解析 ====================

  /** 标签扫描用的正则：属性值里的 > 不会提前截断标签 */
  var TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

  /**
   * 这些标签的「收尾」在视觉上等于换行。
   * parseGrid 是逐标签累加文本的，标签本身会被消费掉，
   * 所以必须显式补一个 \n —— 否则 <br> 会凭空消失，
   * 「课程名 / 教师 / 地点 / 周次」会被粘成「高等数学张老师东区一教1011-16周」，
   * 启发式拆不开，整条解析全废。
   */
  var BLOCK_TAGS = /^(?:p|div|li|tr|td|th|h[1-6]|section|article|blockquote|pre|dd|dt)$/;

  function readAttr(attrs, name) {
    var m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))', 'i').exec(attrs || '');
    if (!m) return null;
    return m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
  }

  /**
   * 取出所有顶层 <table> 的 HTML 片段。
   * 用大括号配对式的深度计数，保证嵌套表格不会把外层提前截断。
   */
  function extractTables(html) {
    var src = dropScripts(html);
    var out = [];
    var openRe = /<table\b[^>]*>/gi;
    var m;
    while ((m = openRe.exec(src)) !== null) {
      var start = m.index;
      var i = openRe.lastIndex;
      var depth = 1;
      var scan = /<\/?table\b[^>]*>/gi;
      scan.lastIndex = i;
      var t;
      while ((t = scan.exec(src)) !== null) {
        depth += t[0][1] === '/' ? -1 : 1;
        if (depth === 0) {
          out.push(src.slice(start, scan.lastIndex));
          openRe.lastIndex = scan.lastIndex;
          break;
        }
      }
      if (depth !== 0) break; // 表格没闭合，放弃后续
    }
    return out;
  }

  /**
   * 表格 → 二维矩阵。
   * 处理 rowspan/colspan：合并单元格会在它覆盖的每个位置重复出现同一个对象，
   * 因此「一个格子横跨多节次」这种情况，节次列读到的仍是同一个范围。
   * 嵌套表格不参与结构（只作为文字内容并入所在单元格）。
   */
  function parseGrid(tableHtml) {
    var rows = [];   // [{ cells: [{ text, colspan, rowspan, isHeader }] }]
    var curRow = null;
    var curCell = null;
    var depth = 1;

    var inner = String(tableHtml || '').replace(/^<table\b[^>]*>/i, '');
    TAG_RE.lastIndex = 0;
    var m;
    var lastIndex = 0;

    function pushCell() {
      if (curCell && curRow) {
        curCell.text = cellText(curCell.text);
        curRow.cells.push(curCell);
      }
      curCell = null;
    }

    while ((m = TAG_RE.exec(inner)) !== null) {
      var text = inner.slice(lastIndex, m.index);
      if (curCell) curCell.text += text;
      lastIndex = TAG_RE.lastIndex;

      var closing = m[1] === '/';
      var tag = m[2].toLowerCase();
      var attrs = m[3] || '';

      if (tag === 'table') {
        depth += closing ? -1 : 1;
        if (depth <= 0) break; // 外层表格结束
        continue;
      }
      if (depth > 1) continue; // 嵌套表格的结构不参与解析，文字照收

      // 先补换行语义，再处理结构标签
      if (tag === 'br') {
        if (curCell) curCell.text += '\n';
        continue;
      }
      if (closing && BLOCK_TAGS.test(tag) && curCell) curCell.text += '\n';

      if (tag === 'tr') {
        if (closing) {
          pushCell();
          if (curRow) rows.push(curRow);
          curRow = null;
        } else {
          if (curRow) { pushCell(); rows.push(curRow); } // 容错：<tr> 未闭合
          curRow = { cells: [] };
        }
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        if (closing) pushCell();
        else {
          pushCell(); // 容错：<td> 未闭合
          if (!curRow) curRow = { cells: [] };
          curCell = {
            text: '',
            colspan: Math.max(1, parseInt(readAttr(attrs, 'colspan'), 10) || 1),
            rowspan: Math.max(1, parseInt(readAttr(attrs, 'rowspan'), 10) || 1),
            isHeader: tag === 'th' || /scope\s*=\s*["']?col/i.test(attrs),
            textAlign: readAttr(attrs, 'align') || readAttr(attrs, 'style') || ''
          };
        }
        continue;
      }
    }
    pushCell();
    if (curRow && curRow.cells.length) rows.push(curRow);

    // ---- 展开合并单元格为矩形矩阵 ----
    var matrix = [];
    var spanLeft = [];   // 每个列位置还剩余多少行被 rowspan 占据
    var spanCell = [];   // 对应位置要填的单元格对象
    var maxCols = 0;

    for (var ri = 0; ri < rows.length; ri++) {
      var out = [];
      var col = 0;
      var cells = rows[ri].cells;
      for (var ci = 0; ci < cells.length; ci++) {
        // 先跳过被上面 rowspan 占住的列
        while (spanLeft[col] > 0) { out[col] = spanCell[col]; spanLeft[col]--; col++; }
        var cell = cells[ci];
        // 记录单元格首次出现的行：rowspan 合并在后续行会重复出现同一个对象，
        // 解析时靠它判断「这门课从第几节开始、跨几节」，而不是把同一门课当成两门。
        if (cell.originRow == null) { cell.originRow = ri; cell.originCol = col; }
        for (var k = 0; k < cell.colspan; k++) {
          out[col] = cell;
          if (cell.rowspan > 1) { spanLeft[col] = cell.rowspan - 1; spanCell[col] = cell; }
          col++;
        }
      }
      // 行尾仍可能被上一行的 rowspan 覆盖
      while (spanLeft[col] > 0) { out[col] = spanCell[col]; spanLeft[col]--; col++; }
      maxCols = Math.max(maxCols, out.length);
      matrix.push(out);
    }

    // 补成等宽矩形，避免后面到处判空
    for (var r = 0; r < matrix.length; r++) {
      while (matrix[r].length < maxCols) matrix[r].push(null);
    }
    return matrix;
  }

  /** 矩阵取文本（null 安全） */
  function textAt(matrix, r, c) {
    var cell = matrix[r] && matrix[r][c];
    return cell ? (cell.text || '') : '';
  }

  // ==================== 语义识别 ====================

  var DAY_WORD = /^(?:星期|周|礼拜)\s*([一二三四五六日天1-7])$/;
  var DAY_EN = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  /** 数字星期 → 汉字（合成「星期一」这类补全文本时用） */
  var DAY_CN = ['', '一', '二', '三', '四', '五', '六', '日'];

  /** 单元格文本 → 星期几（1-7），识别不出返回 null */
  function dayOfText(text) {
    var raw = String(text == null ? '' : text).replace(/\s+/g, '');
    if (!raw || raw.length > 12) return null; // 太长的肯定不是表头

    var m = DAY_WORD.exec(raw);
    if (m) {
      var c = m[1];
      if (/[1-7]/.test(c)) return Number(c);
      return CP.DAY_MAP[c] || null;
    }
    // 表头常写成「星期一(Mon)」：先剥掉括号注释再试一次
    var zh = raw.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '');
    m = DAY_WORD.exec(zh);
    if (m) {
      var c2 = m[1];
      if (/[1-7]/.test(c2)) return Number(c2);
      return CP.DAY_MAP[c2] || null;
    }
    // 纯英文表头：Mon / Monday / 星期一 Mon
    var en = /^(mon|tue|wed|thu|fri|sat|sun)/i.exec(raw.replace(/[^A-Za-z]/g, ''));
    if (en) return DAY_EN[en[1].toLowerCase()] || null;
    return null;
  }

  /** 行里是否像「节次」标注：第1节 / 1-2节 / 08:00-08:45 */
  function looksLikeSection(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s || s.length > 16) return false;
    return /^第\s*\d+\s*(?:[-–—~至]\s*\d+\s*)?节?$/.test(s)
      || /^\d{1,2}\s*[-–—~至,，]\s*\d{1,2}\s*节?$/.test(s)
      || /^\d{1,2}\s*节$/.test(s)
      || /^\d{1,2}:\d{2}\s*[-–—~至]\s*\d{1,2}:\d{2}$/.test(s);
  }

  /**
   * 找表头行：同一行里出现 ≥4 个「星期X」才算（避免把课程里的「周一」误当表头）。
   * 返回 { row, map: { 列号: 星期 } } 或 null
   */
  function findDayHeaderRow(matrix) {
    var best = null;
    for (var r = 0; r < matrix.length; r++) {
      var map = {};
      var hit = 0;
      for (var c = 0; c < (matrix[r] || []).length; c++) {
        var d = dayOfText(textAt(matrix, r, c));
        if (d) { map[c] = d; hit++; }
      }
      if (hit >= 4 && (!best || hit > best.hit)) best = { row: r, map: map, hit: hit };
    }
    return best;
  }

  /** 转置版面：星期在行、节次在列 */
  function findDayHeaderCol(matrix) {
    var cols = matrix.reduce(function (n, row) { return Math.max(n, row.length); }, 0);
    for (var c = 0; c < cols; c++) {
      var map = {};
      var hit = 0;
      for (var r = 0; r < matrix.length; r++) {
        var d = dayOfText(textAt(matrix, r, c));
        if (d) { map[r] = d; hit++; }
      }
      if (hit >= 4) return { col: c, map: map, hit: hit };
    }
    return null;
  }

  /** 读节次区间：优先标准写法，其次按时间映射作息表，最后裸数字兜底 */
  function readSections(text, sectionTimes) {
    var s = CP.normalizeLine(String(text == null ? '' : text));
    if (!s) return null;
    var sec = CP.extractSections(s);
    if (!sec && sectionTimes) sec = CP.extractSectionsByTime(s, sectionTimes);
    if (!sec) {
      var m = /^(\d{1,2})\s*[-–—~至,，]\s*(\d{1,2})/.exec(s.replace(/[节第]/g, '').trim());
      if (m) sec = { start: Number(m[1]), end: Number(m[2]), matched: m[0] };
      else {
        m = /^(\d{1,2})$/.exec(s.trim());
        if (m) sec = { start: Number(m[1]), end: Number(m[1]), matched: m[0] };
        else if (sectionTimes) {
          // 形如「上午第1节」这类也走时间映射
          sec = CP.extractSectionsByTime(s, sectionTimes);
        }
      }
    }
    if (!sec || !sec.start) return null;
    return { start: Number(sec.start), end: Number(sec.end || sec.start) };
  }

  // ==================== 列表型课表 ====================

  var LIST_COLS = {
    name: /^(?:课程名称|课程名|教学班名称|课名|名称)$/,
    teacher: /^(?:任课教师|授课教师|教师|老师)$/,
    time: /^(?:上课时间|授课时间|节次|时间|周次安排)$/,
    location: /^(?:上课地点|教学地点|授课地点|地点|教室)$/
  };

  /** 表头行 → 列映射 { name: 列号, teacher: 列号, ... }，识别不出返回 null */
  function mapListHeader(row) {
    var map = {};
    var hit = 0;
    for (var c = 0; c < (row || []).length; c++) {
      var t = (textAt([row], 0, c) || '').replace(/\s/g, '');
      if (!t) continue;
      for (var key in LIST_COLS) {
        if (LIST_COLS[key].test(t) && map[key] == null) { map[key] = c; hit++; break; }
      }
    }
    // 至少要有「课名」和（时间 或 地点）才当作列表型课表
    if (map.name == null) return null;
    if (map.time == null && map.location == null) return null;
    return map;
  }

  function parseListTable(matrix, opts, warnings) {
    var items = [];
    for (var r = 0; r < matrix.length; r++) {
      var map = mapListHeader(matrix[r]);
      if (!map) continue;
      // 找到表头了，往下逐行取课
      for (var i = r + 1; i < matrix.length; i++) {
        var row = matrix[i];
        if (!row) continue;
        var name = map.name != null ? textAt(matrix, i, map.name) : '';
        if (!name) continue;
        if (mapListHeader(row)) continue; // 又一行表头，跳过
        if (/^(?:合计|备注|说明)/.test(name)) continue;

        var time = map.time != null ? textAt(matrix, i, map.time) : '';
        var loc = map.location != null ? textAt(matrix, i, map.location) : '';
        var teacher = map.teacher != null ? textAt(matrix, i, map.teacher) : '';

        // 合成一行文本交给启发式引擎。
        // 「地点:」「教师:」显式标注是关键：列表型课表已经明确知道哪一列是什么，
        // 再让启发式去猜（如「东区一教101」是否像地点）纯属把确定信息退回给猜测。
        var line = [name.replace(/\n/g, ' '), time.replace(/\n/g, ' '),
          loc ? ('地点:' + loc.replace(/[\s,;，]+/g, ' ').trim()) : '',
          teacher ? ('教师:' + teacher.replace(/[\s,;，]+/g, ' ').trim()) : '']
          .filter(Boolean).join(' ');
        var res = CP.parseScheduleText(line, { sectionTimes: opts.sectionTimes, totalWeeks: opts.totalWeeks });
        for (var k = 0; k < res.items.length; k++) items.push(res.items[k]);
      }
      return items; // 只认第一个像表头的行
    }
    warnings.push('未识别出课程列表表头（需要「课程名称」列 + 时间或地点列）');
    return items;
  }

  // ==================== 网格型课表 ====================

  /**
   * 解析网格型课表。dayCols / sectionRows 由表头推导。
   *
   * 关键点：
   *  - 遍历「位置」而不是「单元格」会让 rowspan 合并的课被解析两次，
   *    因此用 processed 记录已处理的单元格对象，同一对象只处理一次；
   *  - 合并单元格的节次跨度取「首次出现的行」的节次 + rowspan-1，
   *    这样一个跨第1-2节的格子会得到 1-2 节，而不是两个 1-1 / 2-2 的重复课。
   */
  function parseGridTable(matrix, header, opts, warnings) {
    var items = [];
    var sectionCol = -1;
    // 节次列 = 表头行左侧第一个「不像星期」的列
    for (var c = 0; c < (matrix[header.row] || []).length; c++) {
      if (header.map[c] != null) break;
      sectionCol = c;
    }

    var processed = [];
    var lastSections = null;

    for (var r = header.row + 1; r < matrix.length; r++) {
      var rowSec = sectionCol >= 0 ? readSections(textAt(matrix, r, sectionCol), opts.sectionTimes) : null;
      if (rowSec) lastSections = rowSec;

      for (var col = 0; col < matrix[r].length; col++) {
        if (header.map[col] == null) continue;
        var cell = matrix[r][col];
        if (!cell || processed.indexOf(cell) !== -1) continue;
        processed.push(cell);

        var text = cell.text || '';
        if (!text) continue;
        // 「上午/下午/晚上」这类行分组标题不是课
        if (/^(?:上午|下午|晚上|早晨|中午)\s*$/.test(text.replace(/\s/g, ''))) continue;

        // 节次：格子自带优先；否则用「首次出现那一行」的节次，再按 rowspan 补足跨度
        var originSec = sectionCol >= 0
          ? readSections(textAt(matrix, cell.originRow == null ? r : cell.originRow, sectionCol), opts.sectionTimes)
          : null;
        var ownSec = readSections(text, opts.sectionTimes);
        var span = Math.max(1, Number(cell.rowspan) || 1);

        var res = splitCellItems(text, header.map[col], opts);
        for (var k = 0; k < res.items.length; k++) {
          var it = res.items[k];
          if (!it.name) continue;
          if (!it.day) it.day = header.map[col]; // 格子里没写星期就用列位置补
          if (it.startSection == null) {
            var base = ownSec || originSec || rowSec || lastSections;
            if (base) {
              it.startSection = base.start;
              it.endSection = base.start + span - 1;
            }
          }
          items.push(it);
        }
      }
    }
    return items;
  }

  /** 转置网格：行=星期、列=节次 */
  function parseTransposedTable(matrix, header, opts) {
    var items = [];
    var sectionRow = -1;
    for (var r = 0; r < matrix.length; r++) {
      if (header.map[r] != null) break;
      sectionRow = r;
    }
    var processed = [];
    for (var row = 0; row < matrix.length; row++) {
      var day = header.map[row];
      if (day == null) continue;
      for (var c = 0; c < matrix[row].length; c++) {
        var cell = matrix[row][c];
        if (!cell || processed.indexOf(cell) !== -1) continue;
        processed.push(cell);
        var text = cell.text || '';
        if (!text) continue;

        var span = Math.max(1, Number(cell.colspan) || 1);
        var ownSec = readSections(text, opts.sectionTimes);
        var originSec = sectionRow >= 0
          ? readSections(textAt(matrix, sectionRow, cell.originCol == null ? c : cell.originCol), opts.sectionTimes)
          : null;

        var res = splitCellItems(text, day, opts);
        for (var k = 0; k < res.items.length; k++) {
          var it = res.items[k];
          if (!it.name) continue;
          if (!it.day) it.day = day;
          if (it.startSection == null && (ownSec || originSec)) {
            it.startSection = (ownSec || originSec).start;
            it.endSection = (ownSec || originSec).start + span - 1;
          }
          items.push(it);
        }
      }
    }
    return items;
  }

  // ==================== 主入口 ====================

  /**
   * 解析教务系统课表页面的 HTML
   * @param {string} html 页面 HTML（桌面端主进程取回的整页或局部）
   * @param {object} [opts] { sectionTimes, totalWeeks }
   * @returns {{ items: Array, warnings: Array<string>, layout: string, tables: number }}
   *   layout: 'grid' | 'transposed' | 'list' | 'none'
   */
  function parseEduHtml(html, opts) {
    opts = opts || {};
    var warnings = [];
    var tables = extractTables(html);

    if (!tables.length) {
      warnings.push('页面里没有找到表格，可能课表是图片或异步加载的');
      return { items: [], warnings: warnings, layout: 'none', tables: 0 };
    }

    // 网格型优先：课表页通常只有一张主表，但页面上常有装饰性小表，按面积优先挑
    var bestGrid = null;
    var bestList = null;

    for (var i = 0; i < tables.length; i++) {
      var matrix = parseGrid(tables[i]);
      if (!matrix.length) continue;

      var listItems = null;
      var header = findDayHeaderRow(matrix);
      var transposed = header ? null : findDayHeaderCol(matrix);

      if (header || transposed) {
        var items = header
          ? parseGridTable(matrix, header, opts, warnings)
          : parseTransposedTable(matrix, transposed, opts);
        var score = items.length;
        if (score > 0 && (!bestGrid || score > bestGrid.score)) {
          bestGrid = {
            score: score,
            items: items,
            layout: header ? 'grid' : 'transposed'
          };
        }
        continue;
      }

      // 不是网格型，试试列表型
      if (!bestList) {
        listItems = parseListTable(matrix, opts, []);
        if (listItems.length) bestList = listItems;
      }
    }

    if (bestGrid) {
      return {
        items: dedupe(bestGrid.items),
        warnings: warnings,
        layout: bestGrid.layout,
        tables: tables.length
      };
    }
    if (bestList) {
      return { items: dedupe(bestList), warnings: warnings, layout: 'list', tables: tables.length };
    }

    warnings.push('找到了表格，但没识别出课表结构（既没有星期表头，也没有课程列表表头）');
    return { items: [], warnings: warnings, layout: 'none', tables: tables.length };
  }

  /** 去掉完全重复的条目：合并单元格与页面重复渲染都会产生副本 */
  function dedupe(items) {
    var seen = {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = [it.name, it.teacher, it.location, it.day, it.startSection, it.endSection,
        (it.weeks || []).join('/')].join('|');
      if (seen[key]) continue;
      seen[key] = true;
      out.push(it);
    }
    return out;
  }

  // ==================== 结构化接口：正方 jwglxt 的课表 JSON ====================

  /**
   * 相比解析 HTML，接口数据是有字段名的，本该更简单 —— 真正的麻烦是**字段名不统一**：
   * 正方各版本、各校定制都会改字段（xqj/xq、jcs/jc/jcor、zcd/zcmc…）。
   * 所以这里按「同义词组」取值，命中第一个非空值就用。
   * 宁可多列几个别名，也不要因为学校换了个字段名就整门课凭空消失。
   */
  var ZF_FIELDS = {
    name: ['kcmc', 'kcmcDisplay', 'jxbmc', 'kcb', 'courseName'],
    teacher: ['xm', 'jsxm', 'xmDisplay', 'teacherName'],
    location: ['cdmc', 'jxdd', 'cdmcDisplay', 'roomName'],
    campus: ['xqmc', 'campusName'],
    dayName: ['xqjmc', 'xqjmcDisplay', 'xingqi', 'weekName'],
    dayNum: ['xqj', 'xq', 'weekDay'],
    sections: ['jcs', 'jc', 'jcor', 'jcs2', 'sections'],
    weeks: ['zcd', 'zcmc', 'zcmcDisplay', 'zhouci', 'weeks']
  };

  /** 在若干同义字段名里取第一个非空值（统一转成去空白的字符串） */
  function pickField(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v == null) continue;
      var s = String(v).replace(/\s+/g, ' ').trim();
      if (s) return s;
    }
    return '';
  }

  /**
   * 从接口响应里掏出课表行数组。
   * 不同版本会把 kbList 塞在不同外壳里（顶层 / data 里 / 直接就是数组），
   * 甚至换个名字（xskbList）。这里宽容地都认，认不出再让上层报错。
   * 顺带取回 xqjmcMap（{1:'星期一'}），它是星期字段缺失时最可靠的补位来源。
   */
  function extractKbRows(obj) {
    var rows = [];
    var dayMap = null;

    function push(v) {
      if (Object.prototype.toString.call(v) === '[object Array]') {
        for (var i = 0; i < v.length; i++) rows.push(v[i]);
      }
    }
    function collect(o) {
      if (!o || typeof o !== 'object') return;
      push(o.kbList);
      push(o.xskbList);
      push(o.kbListXq);
      if (!dayMap && o.xqjmcMap && typeof o.xqjmcMap === 'object') dayMap = o.xqjmcMap;
    }

    if (Object.prototype.toString.call(obj) === '[object Array]') {
      push(obj);
    } else {
      collect(obj);
      if (obj && typeof obj === 'object') collect(obj.data);
    }
    return { rows: rows, dayMap: dayMap };
  }

  /** 星期：先信数字字段，再按名称文本认，最后拿接口给的映射表反查 */
  function dayFromRow(row, dayMap) {
    var n = Number(pickField(row, ZF_FIELDS.dayNum));
    if (n >= 1 && n <= 7) return n;

    var name = pickField(row, ZF_FIELDS.dayName);
    if (!name) return null;
    var byText = CP.extractDays(name);
    if (byText.length) return byText[0];

    if (dayMap) {
      for (var k in dayMap) {
        if (!Object.prototype.hasOwnProperty.call(dayMap, k)) continue;
        if (String(dayMap[k]).replace(/\s+/g, '') === name.replace(/\s+/g, '')) {
          var kn = Number(k);
          if (kn >= 1 && kn <= 7) return kn;
        }
      }
    }
    return null;
  }

  /** 节次：复用读表格那一套（'第1-2节'、'1-2'、'3,4' 都能读） */
  function sectionsFromRow(row, opts) {
    var str = pickField(row, ZF_FIELDS.sections);
    if (!str) return null;
    var sec = readSections(str, opts && opts.sectionTimes);
    if (sec) return sec;
    var nums = String(str).match(/\d{1,2}/g);
    if (nums && nums.length) {
      var arr = [];
      for (var i = 0; i < nums.length; i++) arr.push(Number(nums[i]));
      return { start: Math.min.apply(null, arr), end: Math.max.apply(null, arr) };
    }
    return null;
  }

  /** 周次：复用文本导入的周次解析（含单双周） */
  function weeksFromRow(row) {
    var str = pickField(row, ZF_FIELDS.weeks);
    if (!str) return null;
    return CP.parseWeeksSpec(str);
  }

  /** 地点：正方把校区（xqmc）与场地（cdmc）分开给，拼成一个可读地点 */
  function joinLocation(campus, room) {
    if (!campus) return room;
    if (!room) return campus;
    if (room.indexOf(campus) === 0) return room; // 场地名里已经带了校区，别拼成「宝山校区 宝山校区A101」
    return campus + ' ' + room;
  }

  /**
   * 解析正方课表接口的 JSON
   * @param {string|object} payload 接口返回的原始文本或已解析对象
   * @param {object} [opts] { sectionTimes, totalWeeks }
   * @returns {{ items: Array, warnings: Array<string>, layout: string, tables: number }}
   *   layout 固定为 'api'，与 HTML 版面的 'grid'/'list' 区分开
   */
  function parseZfKbList(payload, opts) {
    opts = opts || {};
    var warnings = [];
    var obj = payload;

    if (typeof payload === 'string') {
      try {
        obj = JSON.parse(payload);
      } catch (e) {
        // 最常见的原因是会话过期，接口把登录页 HTML 当 200 返回了
        warnings.push('接口返回的不是合法 JSON，多半是登录已过期（被重定向到登录页）');
        return { items: [], warnings: warnings, layout: 'none', tables: 0 };
      }
    }

    var got = extractKbRows(obj);
    if (!got.rows.length) {
      warnings.push('接口返回里没有课表数据（kbList 为空或字段名不认识）');
      return { items: [], warnings: warnings, layout: 'none', tables: 0 };
    }

    var items = [];
    var skipped = 0;
    for (var i = 0; i < got.rows.length; i++) {
      var row = got.rows[i];
      if (!row || typeof row !== 'object') { skipped++; continue; }

      var name = pickField(row, ZF_FIELDS.name);
      if (!name) { skipped++; continue; }

      var day = dayFromRow(row, got.dayMap);
      // 没有星期就没法摆进课表。猜一个位置比留空更糟 —— 用户会以为课真在那天
      if (!day) { skipped++; continue; }

      var sec = sectionsFromRow(row, opts);
      var teacher = pickField(row, ZF_FIELDS.teacher);
      var location = joinLocation(pickField(row, ZF_FIELDS.campus), pickField(row, ZF_FIELDS.location));

      var rawParts = [name];
      if (teacher) rawParts.push(teacher);
      var wRaw = pickField(row, ZF_FIELDS.weeks);
      if (wRaw) rawParts.push(wRaw);
      var sRaw = pickField(row, ZF_FIELDS.sections);
      if (sRaw) rawParts.push(sRaw);
      if (location) rawParts.push(location);

      items.push({
        name: name,
        teacher: teacher,
        location: location,
        day: day,
        startSection: sec ? sec.start : null,
        endSection: sec ? sec.end : null,
        weeks: weeksFromRow(row),
        raw: rawParts.join(' / ')
      });
    }

    if (skipped) {
      warnings.push('有 ' + skipped + ' 条记录缺少课程名或星期信息，已跳过（可在确认表里手工补录）');
    }
    if (!items.length) {
      warnings.push('没有一条记录能定位到星期，无法导入');
    }

    return {
      items: dedupe(items),
      warnings: warnings,
      layout: items.length ? 'api' : 'none',
      tables: 0
    };
  }

  return {
    parseEduHtml: parseEduHtml,
    parseZfKbList: parseZfKbList,
    extractKbRows: extractKbRows,
    extractTables: extractTables,
    parseGrid: parseGrid,
    cellText: cellText,
    cellBlocks: cellBlocks,
    blockToLine: blockToLine,
    splitCellItems: splitCellItems,
    stripTags: stripTags,
    decodeEntities: decodeEntities,
    dayOfText: dayOfText,
    readSections: readSections,
    looksLikeSection: looksLikeSection,
    findDayHeaderRow: findDayHeaderRow,
    findDayHeaderCol: findDayHeaderCol,
    parseListTable: parseListTable,
    dedupe: dedupe
  };
});
