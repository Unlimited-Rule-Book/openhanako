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
 *   ✅ 小数：一点五倍 → 1.5倍（**必须带量词**，见下）
 *   ✅ 多字数字 + 量词：三百六十五天 → 365天、十二个 → 12个
 *   ❌ 单字数字 + 量词：三个问题、这一轮、第一次 —— 一律不动
 *   ❌ 成语/固定搭配：一心一意、三心二意 —— 因为数字是单字，天然被排除
 *   ❌ 报时：九点十五、三点一刻、八点零五分 —— "点"在这里是时刻分隔符，不是小数点
 *   ❌ 概数：三四个人、五六天、三五天 —— 连着的单字数字是概数，不是"34""56"
 *
 * 逐条规则都有对应的测试用例（见 tests/itn-zh.test.ts），包括"不该改"的反例。
 */

const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS = { 十: 10, 百: 100, 千: 1000 };
const BIG_UNITS = { 万: 10000, 亿: 100000000 };

const NUM_CHARS = '零〇一二三四五六七八九两十百千万亿';

/**
 * 只能逐位读的单字数字（不含"两"，也不含十百千万亿）。
 *
 * 关键用途有两个：
 *   1. 小数的**小数部分**只允许出现在这里面的字 —— 一旦出现"十"（九点十五），
 *      说明这是报时而不是小数，必须整段保持原文（以前的做法是把映射不到的"十"
 *      悄悄丢掉，于是"九点十五"变成了"9.5"，属于静默改错）。
 *   2. 连着的单字数字（三四、五六、三五）口语里几乎都是**概数**，不是数字序列 ——
 *      量词场景下一律不转换。
 */
const SINGLE_DIGITS = '零〇一二三四五六七八九';
const SINGLE_DIGIT_RUN = `^[${SINGLE_DIGITS}]{2,}$`;

/**
 * 小数能跟的量词/单位：只有跟着这些才把"X点Y"当小数。
 * 故意**不含** 分/刻/钟/半/整（那些是报时用法），也不含"分"（金额的"三分钱"很少见，
 * 而"三点五分"几乎一定是时刻 3:05）。
 */
const DECIMAL_UNITS = [
  '倍', '个', '米', '公里', '千米', '厘米', '毫米', '平方米', '立方米',
  '元', '块', '度', '斤', '克', '千克', '公斤', '吨', '升', '毫升',
];

/** 量词/单位：只有"多字数字 + 这些字"才转 */
const MEASURE_WORDS = [
  '个', '次', '遍', '天', '年', '月', '日', '号', '周', '星期',
  '元', '块', '毛', '分', '角', '岁', '岁',
  '米', '公里', '千米', '厘米', '毫米', '平方米', '立方米',
  '克', '千克', '公斤', '斤', '吨', '毫升', '升',
  '秒', '分钟', '小时',
  // 注意：这里**故意没有"点"**。它是报时/小数点两用的字，
  // 当成普通量词会让"十二点三十"变成"12点三十"（混搭）、
  // 让报时语句被半途改写。保守起见整类不动。
  '人', '台', '件', '条', '张', '页', '本', '只', '头', '匹',
  '倍', '成', '份', '层', '楼', '间', '门', '辆', '架', '艘',
  '度', '步', '圈', '袋', '瓶', '杯', '箱', '套', '组', '笔',
];

/** 逐位读一段单字数字；只要有一个字不在表里就返回 null（绝不丢字） */
function readDigits(raw) {
  let out = '';
  for (const ch of raw) {
    if (DIGITS[ch] === undefined) return null;
    out += DIGITS[ch];
  }
  return out;
}

/**
 * 解析一段中文数字。解析不出来就返回 null（宁可不转）。
 * @returns {string|null} 阿拉伯数字字符串
 */
export function parseChineseNumber(raw) {
  if (!raw) return null;

  // 纯数字序列（二零二六、八八六）：逐位读，常用于年份/编号
  if (new RegExp(`^[${SINGLE_DIGITS}]+$`).test(raw)) {
    const digits = readDigits(raw);
    if (digits === null) return null;
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

  // 1) 小数：一点五倍 → 1.5倍
  //   两个必要条件，缺一不转：
  //     · 小数部分**只能是单字数字**（出现"十"就是报时：九点十五、三点一刻）
  //     · 后面必须跟小数量词（倍/个/米/元…），"分/刻/钟/半/整"不在其中：
  //       那些是时刻（八点零五分、五点钟），转成小数是错的
  const decimalUnitPattern = DECIMAL_UNITS.join('|');
  out = out.replace(
    new RegExp(`([${NUM_CHARS}]{1,})点([${SINGLE_DIGITS}]{1,})(?=${decimalUnitPattern})`, 'g'),
    (m, intPart, fracPart) => {
      const int = parseChineseNumber(intPart);
      if (int === null) return m;
      const frac = readDigits(fracPart);
      // 读不出来（不该发生，兜一层）就保持原文 —— 这里绝不能丢字
      if (frac === null || frac === '') return m;
      return `${int}.${frac}`;
    },
  );

  // 2) 百分数：百分之三十 → 30%、百分之五十五点五 → 55.5%
  //    这里必须把小数部分一起吃掉，否则会留下"55%点五"这种半转混搭。
  //    小数部分仍然**只允许单字数字**（与第 1 条同源约束）：
  //    末尾的 (?!点[NUM_CHARS]) 就是防半转 —— 如果后面还挂着我们吃不掉的
  //    "点XX"（例如"百分之五点十五"，小数部分是"十五"，含"十"不是合法小数），
  //    就整段不匹配、保持原文，绝不留下"5%点十五"。
  out = out.replace(
    new RegExp(`百分之([${NUM_CHARS}]{1,})(?:点([${SINGLE_DIGITS}]{1,}))?(?!点[${NUM_CHARS}])`, 'g'),
    (m, intPart, fracPart) => {
      const v = parseChineseNumber(intPart);
      if (v === null) return m;
      if (fracPart === undefined) return `${v}%`;
      const frac = readDigits(fracPart);
      // 读不出来就整段保持原文 —— 这一层是绝不允许丢字的兜底
      if (frac === null || frac === '') return m;
      return `${v}.${frac}%`;
    },
  );

  // 3) 年份：二零二六年 → 2026年（必须四位数字序列，避免"三年"被当成 3年）
  out = out.replace(
    new RegExp(`([${SINGLE_DIGITS}]{3,4})年`, 'g'),
    (m, num) => {
      const digits = readDigits(num);
      return digits === null ? m : `${digits}年`;
    },
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

  // 5) 年份后紧跟月份：二零二六年十月 → 2026年10月
  //    第 3 条只把年份转成数字，剩下的"十月"没人管，于是出现"2026年十月"这种半转。
  //    这里只对**数字年份**动手（`[0-9]{3,4}年`，即第 3 条已经转换过的年份），
  //    所以单独的"二零二六年"（没有月份）不会走进来，仍是 2026年。
  //    日期型（"…年十月八日"）已由第 4 条整段处理掉，这里不会再碰。
  out = out.replace(
    new RegExp(`([0-9]{3,4}年)([${NUM_CHARS}]{1,})月`, 'g'),
    (m, year, mm) => {
      const mv = parseChineseNumber(mm);
      return mv === null ? m : `${year}${mv}月`;
    },
  );

  // 6) 多字数字 + 量词：三百六十五天 → 365天、十二个 → 12个
  //    但要排除"连着的单字数字"：三四个人、五六天、三五天 是**概数**，不是 34/56/35。
  //    （年份/编号那类逐位读的场景由上面第 3、4 条负责。）
  const measurePattern = MEASURE_WORDS.join('|');
  out = out.replace(
    new RegExp(`(${MULTI_CHAR_NUMBER})(${measurePattern})`, 'g'),
    (m, num, unit) => {
      if (new RegExp(SINGLE_DIGIT_RUN).test(num)) return m; // 概数，保持原文
      const v = parseChineseNumber(num);
      return v === null ? m : `${v}${unit}`;
    },
  );

  return out;
}
