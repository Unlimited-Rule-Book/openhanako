/**
 * itn-zh.mjs — 中文数字 → 阿拉伯数字（保守版）
 *
 * 为什么不用官方的 itn_zh_number.fst：
 *   实测它**过度转换**。同一段音频：
 *     不开：重点呢想谈三个问题首先呢就是这一轮全球金融动量的表现
 *     开启：重点呢想谈3个问题首先呢就是这1轮全球金融动量的表现   ← "这一轮"变"这1轮"
 *   中文里"这一轮""三个"这种说法本来就该用汉字，转成数字是错的。
 *
 * 所以这里只做**高置信度**的转换，宁可少转也不乱转：
 *   ✅ 年份：二零二六年 → 2026年
 *   ✅ 百分数：百分之三十 → 30%
 *   ✅ 小数：三点五 → 3.5
 *   ✅ 多字数字 + 量词：三百六十五天 → 365天、十二个 → 12个
 *   ❌ 单字数字 + 量词：三个问题、这一轮、第一次 —— 一律不动
 *   ❌ 成语/固定搭配：一心一意、三心二意 —— 因为数字是单字，天然被排除
 *
 * 逐条规则都有对应的测试用例（见 try-itn.mjs），包括"不该改"的反例。
 */

const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS = { 十: 10, 百: 100, 千: 1000 };
const BIG_UNITS = { 万: 10000, 亿: 100000000 };

const NUM_CHARS = '零〇一二三四五六七八九两十百千万亿';

/** 量词/单位：只有"多字数字 + 这些字"才转 */
const MEASURE_WORDS = [
  '个', '次', '遍', '天', '年', '月', '日', '号', '周', '星期',
  '元', '块', '毛', '分', '角', '岁', '岁',
  '米', '公里', '千米', '厘米', '毫米', '平方米', '立方米',
  '克', '千克', '公斤', '斤', '吨', '毫升', '升',
  '秒', '分钟', '小时', '点',
  '人', '台', '件', '条', '张', '页', '本', '只', '头', '匹',
  '倍', '成', '份', '层', '楼', '间', '门', '辆', '架', '艘',
  '度', '步', '圈', '袋', '瓶', '杯', '箱', '套', '组', '笔',
];

/**
 * 解析一段中文数字。解析不出来就返回 null（宁可不转）。
 * @returns {string|null} 阿拉伯数字字符串
 */
export function parseChineseNumber(raw) {
  if (!raw) return null;

  // 纯数字序列（二零二六、八八六）：逐位读，常用于年份/编号
  if (/^[零〇一二三四五六七八九]+$/.test(raw)) {
    const digits = raw.split('').map(c => DIGITS[c]).join('');
    // "零零"这种不像正常表达，放弃
    if (/^0{2,}/.test(digits)) return null;
    return digits;
  }

  let total = 0;
  let section = 0;
  let number = null;
  for (const ch of raw) {
    if (DIGITS[ch] !== undefined) {
      // "零"是占位符，后面可以接数字（两千零五、一千零二十四）。
      // 除此之外出现连续两个数字字（如"一二三"）不是标准数字写法，放弃。
      if (number !== null && number !== 0) return null;
      number = DIGITS[ch];
      continue;
    }
    if (UNITS[ch] !== undefined) {
      // "十二"里的"十"前面没有数字，按 1 算；"百"同理（一百的省略说法）
      section += (number === null ? 1 : number) * UNITS[ch];
      number = null;
      continue;
    }
    if (BIG_UNITS[ch] !== undefined) {
      section = (section + (number === null ? 0 : number)) * BIG_UNITS[ch];
      total += section;
      section = 0;
      number = null;
      continue;
    }
    return null;
  }
  const value = total + section + (number === null ? 0 : number);
  if (!Number.isFinite(value) || value === 0) return null;
  return String(value);
}

/** 数字串至少两个字才考虑转 —— 这是"三个问题""这一轮"不被误伤的关键 */
const MULTI_CHAR_NUMBER = `[${NUM_CHARS}]{2,}`;

export function normalizeChineseNumbers(text) {
  if (!text) return text;
  let out = text;

  // 1) 小数：三点五 → 3.5（整数部分允许单字，因为"三点五"没有歧义）
  out = out.replace(
    new RegExp(`([${NUM_CHARS}]{1,})点([${NUM_CHARS}]{1,})(?![${NUM_CHARS}])`, 'g'),
    (m, intPart, fracPart) => {
      // "五点"这种可能是"五点钟"，只在后面不是"钟"时替换
      const int = parseChineseNumber(intPart);
      if (int === null) return m;
      // 小数部分必须逐位读
      const frac = fracPart.split('').map(c => DIGITS[c]).join('');
      if (/[^0-9]/.test(frac)) return m;
      return `${int}.${frac}`;
    },
  );

  // 2) 百分数：百分之三十 → 30%
  out = out.replace(
    new RegExp(`百分之([${NUM_CHARS}]{1,})`, 'g'),
    (m, num) => {
      const v = parseChineseNumber(num);
      return v === null ? m : `${v}%`;
    },
  );

  // 3) 年份：二零二六年 → 2026年（必须四位数字序列，避免"三年"被当成 3年）
  out = out.replace(
    new RegExp(`([零〇一二三四五六七八九]{3,4})年`, 'g'),
    (m, num) => `${num.split('').map(c => DIGITS[c]).join('')}年`,
  );

  // 4) 日期：十月八日 → 10月8日（这个模式没有歧义，允许单字数字）
  out = out.replace(
    new RegExp(`([${NUM_CHARS}]{1,})月([${NUM_CHARS}]{1,})(日|号)`, 'g'),
    (m, mm, dd, tail) => {
      const mv = parseChineseNumber(mm);
      const dv = parseChineseNumber(dd);
      return mv === null || dv === null ? m : `${mv}月${dv}${tail}`;
    },
  );

  // 5) 多字数字 + 量词：三百六十五天 → 365天、十二个 → 12个
  const measurePattern = MEASURE_WORDS.join('|');
  out = out.replace(
    new RegExp(`(${MULTI_CHAR_NUMBER})(${measurePattern})`, 'g'),
    (m, num, unit) => {
      const v = parseChineseNumber(num);
      return v === null ? m : `${v}${unit}`;
    },
  );

  return out;
}
