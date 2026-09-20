/**
 * 中文数字解析：把「十二」「一百二十」「五千」「两万」等中文数词解析为数值。
 *
 * 支持：
 * - 零~九、两（=2）；
 * - 十 / 百 / 千 位权（「十二」=12、「一百二十」=120、「三千五」=3500）；
 * - 万 / 亿 节权（「两万」=20000、「一亿两千万」=120000000）；
 * - 混合写法「1.5万」「2千」由调用方拆开解析（见 facts.ts）。
 *
 * 无法解析（含非数词字符）时返回 null。
 */

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CN_SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG_UNITS: Record<string, number> = { 万: 10000, 亿: 100000000 };

/** 解析纯中文数词（不含阿拉伯数字与小数点）。 */
export function parseChineseNumber(text: string): number | null {
  if (!text) return null;
  let total = 0; // 已结算的万/亿节累计
  let section = 0; // 当前节内累计
  let digit = 0; // 待入位的数字（「十」前可省略一）
  for (const ch of text) {
    const d = CN_DIGITS[ch];
    if (d !== undefined) {
      digit = d;
      continue;
    }
    const small = CN_SMALL_UNITS[ch];
    if (small !== undefined) {
      section += (digit === 0 ? 1 : digit) * small;
      digit = 0;
      continue;
    }
    const big = CN_BIG_UNITS[ch];
    if (big !== undefined) {
      section = (section + digit) * big;
      total += section;
      section = 0;
      digit = 0;
      continue;
    }
    return null; // 含非数词字符
  }
  return total + section + digit;
}

/** 判断字符串是否纯中文数词。 */
export function isChineseNumber(text: string): boolean {
  return parseChineseNumber(text) !== null;
}
