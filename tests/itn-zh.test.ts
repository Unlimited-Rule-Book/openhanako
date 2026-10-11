/**
 * 中文数字规整（ITN）的契约测试。
 *
 * 这层最容易出的错不是"少转"，而是**静默改错**：把报时当小数、把概数当数字，
 * 而且改错了还不报错（用户要事后听回文本才发现）。所以这里两条线都要盯死：
 *   · 该保持原文的，一个字节都不能变
 *   · 该转的，必须转对
 */

import { describe, expect, it } from 'vitest';
import { normalizeChineseNumbers, parseChineseNumber } from '../tools/asr-sidecar/itn-zh.mjs';

describe('中文数字规整（ITN）', () => {
  describe('必须保持原文不变（改错比不转更糟）', () => {
    const cases = [
      // 报时：这里的"点"是时刻分隔符，不是小数点
      '九点十五',
      '五点五十到',
      '我三点四十出发',
      '三点一刻',
      '十二点三十',
      '八点零五分',
      // 概数：连着的单字数字是"几个"的意思，不是 34/56/78/35
      '三四个人',
      '五六天',
      '七八个',
      '三五天',
      '二三十个',
      // 原本就该保持的（单字数字 + 量词）
      '三个问题',
      '这一轮',
      '第一次',
      // 百分数里挂了非单字小数（"十五"含"十"，是报时写法），整段保持原文，绝不半转
      '百分之九点十五',
    ];

    for (const input of cases) {
      it(`「${input}」保持原样`, () => {
        expect(normalizeChineseNumbers(input)).toBe(input);
      });
    }
  });

  describe('应当转换（且不能丢字）', () => {
    const cases: Array<[string, string]> = [
      ['十二个', '12个'],
      ['三百六十五天', '365天'],
      ['二零二六年', '2026年'],
      ['百分之三十', '30%'],
      ['一点五倍', '1.5倍'],
      ['一百零五块', '105块'],
      ['三千五百人', '3500人'],
      ['十二月二十五号', '12月25号'],
      // 年份 + 月份要一起转完，不能留"2026年十月"
      ['二〇二六年十月', '2026年10月'],
      ['二零二六年十一月', '2026年11月'],
      // 年份 + 月 + 日 也整段转完
      ['二〇二六年十月八日', '2026年10月8日'],
      // 百分数里的小数要一起吃掉，不能留"55%点五"
      ['百分之五十五点五', '55.5%'],
      ['百分之十二点五', '12.5%'],
    ];

    for (const [input, expected] of cases) {
      it(`「${input}」→「${expected}」`, () => {
        expect(normalizeChineseNumbers(input)).toBe(expected);
      });
    }
  });

  describe('数字解析器', () => {
    it('解析不出就返回 null（宁可不转）', () => {
      // 纯数字序列会被逐位读成 34 —— 这正是量词规则**必须**单独排除概数的原因
      expect(parseChineseNumber('三四')).toBe('34');
      expect(parseChineseNumber('这一')).toBeNull();
      // 单字"零"能解析成 0，但量词规则要求至少两个字，所以"零个"这类不会被改写
      expect(parseChineseNumber('零')).toBe('0');
      expect(normalizeChineseNumbers('零个')).toBe('零个');
    });

    it('解析结果永远是纯数字（不允许夹带字符）', () => {
      for (const raw of ['十二', '三百六十五', '两千零五', '二零二六', '三万五千']) {
        expect(parseChineseNumber(raw)).toMatch(/^[0-9]+$/);
      }
    });
  });

  it('一句话里同时有报时和数字时，只转该转的', () => {
    // "下午三点"是报时（不动），"十二个"该转
    expect(normalizeChineseNumbers('下午三点见，我买十二个'))
      .toBe('下午三点见，我买12个');
  });
});
