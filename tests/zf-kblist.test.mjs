/**
 * 正方课表接口（kbList JSON）解析测试
 *
 * 为什么这层非得测：结构化接口本该比抓 HTML 简单，真正的风险全在**字段名不统一** ——
 * 正方各版本/各校定制会改字段（xqj/xq、jcs/jc/jcor、zcd/zcmc…）。
 * 一旦某个学校换个字段名而解析器没覆盖，表现是「课表导进来少了几门课」——
 * 用户很难发现，后果却是真正会误事的（漏了一门课不知道自己漏了）。
 *
 * fixture 按实测到的正方结构写，同时故意混入几种真实变体：
 * 数字/字符串混合的星期、只给 xqjmc 不给 xqj、单双周、嵌套在 data 里、脏记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Edu = require(fileURLToPath(new URL('../web/js/edu-html.js', import.meta.url)));

/** 典型的一学期课表：三条正常记录 + 一条脏记录（没课程名） */
const KB_LIST = {
  kbList: [
    {
      kcmc: '高等数学(二)',
      xqjmc: '星期一',
      xqj: '1',
      jcs: '1-2',
      zcd: '1-16周',
      cdmc: '东区一教101',
      xm: '张老师',
      xqmc: '宝山校区',
      kch: '01234',
      jxbmc: '高数2-01班'
    },
    {
      kcmc: '大学英语',
      xqjmc: '星期三',
      jc: '3-4',
      zcmc: '1-8周(单)',
      cdmc: '东区二教205',
      xm: '李老师',
      xqmc: '宝山校区'
    },
    {
      kcmc: '程序设计基础',
      xqj: 5,
      jcs: '第5-6节',
      zcd: '2-16周',
      cdmc: '东区三教301',
      xm: '王老师',
      xqmc: '宝山校区'
    },
    { kcmc: '', xqj: '2', jcs: '1-2', cdmc: '空课名' }
  ],
  xqjmcMap: { '1': '星期一', '2': '星期二', '3': '星期三', '4': '星期四', '5': '星期五', '6': '星期六', '7': '星期日' },
  sjkList: []
};

test('kbList：正常记录全部识别，脏记录被跳过并给出警告', () => {
  const r = Edu.parseZfKbList(KB_LIST, { totalWeeks: 16 });

  assert.equal(r.layout, 'api', '结构化解析应标成 api 版面，与抓 HTML 区分开');
  assert.equal(r.items.length, 3, '三条正常记录应全部保留，缺课名的应被跳过');

  const gs = r.items[0];
  assert.equal(gs.name, '高等数学(二)');
  assert.equal(gs.teacher, '张老师');
  assert.equal(gs.location, '宝山校区 东区一教101', '校区与场地应拼成可读地点');
  assert.equal(gs.day, 1);
  assert.equal(gs.startSection, 1);
  assert.equal(gs.endSection, 2);
  assert.deepEqual(gs.weeks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.ok(/高等数学/.test(gs.raw), 'raw 应保留原始行，便于用户核对');

  assert.ok(r.warnings.some((w) => /跳过/.test(w)), '跳过记录必须报出来，不能静默丢课');
});

test('kbList：字段名变体（jc / zcmc / xqj 为数字 / 第X节写法）都能读', () => {
  const r = Edu.parseZfKbList(KB_LIST, {});

  const en = r.items.filter((it) => it.name === '大学英语')[0];
  assert.ok(en, '只给了 jc（不是 jcs）也应读得到节次');
  assert.equal(en.day, 3, '没给 xqj，应从 xqjmc「星期三」认出星期');
  assert.equal(en.startSection, 3);
  assert.equal(en.endSection, 4);
  assert.deepEqual(en.weeks, [1, 3, 5, 7], '「1-8周(单)」应只留单周');

  const cs = r.items.filter((it) => it.name === '程序设计基础')[0];
  assert.ok(cs, 'xqj 给成数字 5 也应识别');
  assert.equal(cs.day, 5);
  assert.equal(cs.startSection, 5, '「第5-6节」应读成 5-6');
  assert.equal(cs.endSection, 6);
  assert.deepEqual(cs.weeks, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test('kbList：没有星期就无法定位，宁可跳过也不猜一个位置', () => {
  const r = Edu.parseZfKbList({
    kbList: [{ kcmc: '某门课', jcs: '1-2', cdmc: 'A101' }]
  }, {});

  assert.equal(r.items.length, 0, '没有星期信息时不能默认塞到周一 —— 猜错会让用户以为课真在那天');
  assert.equal(r.layout, 'none');
  assert.ok(r.warnings.some((w) => /跳过|无法导入/.test(w)));
});

test('kbList：星期靠 xqjmcMap 反查（名称不是标准写法时）', () => {
  const r = Edu.parseZfKbList({
    kbList: [{ kcmc: '实验课', xqjmc: 'Day3', jcs: '1-2' }],
    xqjmcMap: { '1': 'Day1', '2': 'Day2', '3': 'Day3' }
  }, {});
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].day, 3, '标准写法认不出时，应回退到接口自带的映射表');
});

test('kbList：嵌套在 data 里 / 直接是数组 / 别名 xskbList 都要认', () => {
  const row = { kcmc: '体育', xqj: '4', jcs: '7-8', zcd: '1-16周' };

  const a = Edu.parseZfKbList({ data: { kbList: [row] } }, {});
  assert.equal(a.items.length, 1, 'kbList 放在 data 里也应认出来');

  const b = Edu.parseZfKbList([row], {});
  assert.equal(b.items.length, 1, '顶层直接是数组也应认出来');

  const c = Edu.parseZfKbList({ xskbList: [row] }, {});
  assert.equal(c.items.length, 1, '换个名字 xskbList 也应认出来');
});

test('kbList：重复记录会被去重（接口偶尔同一条课返回两遍）', () => {
  const row = { kcmc: '体育', xqj: '4', jcs: '7-8', zcd: '1-16周', cdmc: 'A101', xm: '赵老师' };
  const r = Edu.parseZfKbList({ kbList: [row, Object.assign({}, row)] }, {});
  assert.equal(r.items.length, 1);
});

test('kbList：返回的不是 JSON（会话过期被重定向到登录页）要给明确提示', () => {
  const r = Edu.parseZfKbList('<!DOCTYPE html><html><body>请先登录</body></html>', {});
  assert.equal(r.items.length, 0);
  assert.equal(r.layout, 'none');
  assert.ok(r.warnings.some((w) => /登录/.test(w)), '应提示是登录过期，而不是笼统的解析失败');
});

test('kbList：空数据 / 字段名完全不认识时不要假装成功', () => {
  const empty = Edu.parseZfKbList({ kbList: [] }, {});
  assert.equal(empty.items.length, 0);
  assert.ok(empty.warnings.length > 0);

  const alien = Edu.parseZfKbList({ kbList: [{ foo: '1', bar: '2' }] }, {});
  assert.equal(alien.items.length, 0);
  assert.ok(alien.warnings.some((w) => /跳过|无法导入/.test(w)));
});
