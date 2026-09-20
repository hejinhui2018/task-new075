import { describe, expect, it } from 'vitest';
import {
  extractFacts,
  formatValueForRaw,
  isLegalLocked,
  matchFacts,
  numberToChinese,
  parseChineseNumeral,
  parseNumber,
  valuesEqual,
  type Fact,
} from '../facts';

const factsOf = (text: string): Fact[] => extractFacts(text, 'e0');
const byKind = (facts: Fact[], kind: Fact['kind']) => facts.filter((f) => f.kind === kind);

describe('中文数字解析与格式化', () => {
  it('解析常见中文数字', () => {
    expect(parseChineseNumeral('十二')).toBe(12);
    expect(parseChineseNumeral('三十')).toBe(30);
    expect(parseChineseNumeral('四十五')).toBe(45);
    expect(parseChineseNumeral('一百')).toBe(100);
    expect(parseChineseNumeral('一百二十')).toBe(120);
    expect(parseChineseNumeral('两百')).toBe(200);
    expect(parseChineseNumeral('五千')).toBe(5000);
    expect(parseChineseNumeral('一万')).toBe(10000);
    expect(parseChineseNumeral('十二万')).toBe(120000);
    expect(parseChineseNumeral('一百零五')).toBe(105);
  });

  it('非法输入返回 null', () => {
    expect(parseChineseNumeral('')).toBeNull();
    expect(parseChineseNumeral('abc')).toBeNull();
    expect(parseChineseNumeral('12')).toBeNull();
  });

  it('中文数字格式化（候选改写给回中文）', () => {
    expect(numberToChinese(45)).toBe('四十五');
    expect(numberToChinese(90)).toBe('九十');
    expect(numberToChinese(10)).toBe('十');
    expect(numberToChinese(105)).toBe('一百零五');
    expect(numberToChinese(900000)).toBe('九十万');
    expect(numberToChinese(1200000)).toBe('一百二十万');
    expect(numberToChinese(3.5)).toBeNull();
  });

  it('parseNumber 同时支持阿拉伯与中文数字', () => {
    expect(parseNumber('1,200,000')).toBe(1200000);
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber('三十')).toBe(30);
  });
});

describe('事实抽取：金额', () => {
  it('识别万元 / 元 / 亿元并规范化为元', () => {
    const facts = byKind(factsOf('项目预算：设计费 50 万元、开发费 40 万元，费用合计 90 万元。'), 'amount');
    expect(facts.map((f) => f.value)).toEqual([500000, 400000, 900000]);
    expect(facts.map((f) => f.label)).toEqual(['设计费', '开发费', '费用']);
    expect(facts[2].derived).toBe(true);
    expect(facts[0].derived).toBe(false);
  });

  it('无「元」时需金额语境（合计 120 万）', () => {
    const withCue = byKind(factsOf('三项费用合计 120 万。'), 'amount');
    expect(withCue).toHaveLength(1);
    expect(withCue[0].value).toBe(1200000);
    // 无金额语境的「5000 万」不抽取为金额
    expect(byKind(factsOf('注册用户超 5000 万。'), 'amount')).toHaveLength(0);
  });

  it('货币符号与中文数字金额', () => {
    expect(byKind(factsOf('服务费 ¥200。'), 'amount')[0].value).toBe(200);
    expect(byKind(factsOf('服务费人民币 200 元。'), 'amount')[0].value).toBe(200);
    expect(byKind(factsOf('每年投入不少于五千万元。'), 'amount')[0].value).toBe(50000000);
    expect(byKind(factsOf('总额 1.5 亿元。'), 'amount')[0].value).toBe(150000000);
  });
});

describe('事实抽取：比例 / 日期 / 时长 / 数量', () => {
  it('比例：阿拉伯与中文百分数', () => {
    expect(byKind(factsOf('分行覆盖率达 105%。'), 'ratio')[0].value).toBe(105);
    expect(byKind(factsOf('占比百分之三十。'), 'ratio')[0].value).toBe(30);
    expect(byKind(factsOf('占比百分之三点五。'), 'ratio')[0].value).toBeCloseTo(3.5);
  });

  it('日期：完整 / 缺年份 / 季度', () => {
    const full = byKind(factsOf('【2026年9月10日 · 上海】今日宣布。'), 'date')[0];
    expect(full.value).toBe(20260910);
    expect(full.yearless).toBe(false);
    const range = byKind(factsOf('公测期自 2026 年 10 月 1 日至 11 月 1 日。'), 'date');
    expect(range.map((f) => f.value)).toEqual([20261001, 1101]);
    expect(range[1].yearless).toBe(true);
    const quarter = byKind(factsOf('平台将于2026年第四季度开放公测。'), 'date')[0];
    expect(quarter.value).toBe(20261228);
  });

  it('时长：统一换算为天', () => {
    expect(byKind(factsOf('退款期限为 30 天。'), 'duration')[0].value).toBe(30);
    expect(byKind(factsOf('试用期 3 个月。'), 'duration')[0].value).toBe(90);
    expect(byKind(factsOf('质保两年。'), 'duration')[0].value).toBe(730);
    expect(byKind(factsOf('账期 1.5 个月。'), 'duration')[0].value).toBe(45);
    expect(byKind(factsOf('对账周期不超过 10 天。'), 'duration')[0].label).toBe('对账周期');
  });

  it('「2026 年」是年份不是时长', () => {
    expect(byKind(factsOf('公司2025年年度报告。'), 'duration')).toHaveLength(0);
  });

  it('数量：中文数字 + 量词名词', () => {
    const q = byKind(factsOf('首批覆盖北辰银行华东区十二家分行。'), 'quantity')[0];
    expect(q.value).toBe(12);
    expect(q.noun).toBe('分行');
    expect(byKind(factsOf('预计覆盖一百家机构。'), 'quantity')[0].value).toBe(100);
    expect(byKind(factsOf('已服务超过两百家企业客户。'), 'quantity')[0].value).toBe(200);
  });

  it('不抽取：条款序号、脚注号、电话号码', () => {
    expect(factsOf('第 4 条：争议提交仲裁。')).toHaveLength(0);
    expect(factsOf('其他未尽事宜，详见第 4 条。')).toHaveLength(0);
    expect(factsOf('媒体垂询：电话 021-5555-6666。')).toHaveLength(0);
    expect(factsOf('注1：退款期限以合同为准。')).toHaveLength(0);
  });
});

describe('语义标签提取', () => {
  it('从数字左侧上下文提取标签', () => {
    expect(byKind(factsOf('平台退款期限为 45 天（注1）。'), 'duration')[0].label).toBe('平台退款期限');
    expect(byKind(factsOf('注1：退款期限 30 天，以合同约定为准。'), 'duration')[0].label).toBe('退款期限');
    expect(byKind(factsOf('平台数据留存期为 5 年。'), 'duration')[0].label).toBe('平台数据留存期');
  });
});

describe('身份匹配：不按文本值误配', () => {
  it('相同数字出现在不同承诺中各自配对', () => {
    const base = factsOf('退款期限为 30 天，公测周期为 30 天。');
    const brand = factsOf('退款期限为 45 天，公测周期为 30 天。');
    const pairs = matchFacts(base, brand);
    const paired = new Map(pairs.filter(([a, b]) => a && b).map(([a, b]) => [a!.labelKey, b!]));
    // 「退款期限」的新值是 45 天，「公测周期」仍是 30 天——按标签配对而非数值
    expect(paired.get('退款期限')!.value).toBe(45);
    expect(paired.get('公测周期')!.value).toBe(30);
  });

  it('单位换算后相等视为同一值', () => {
    const a = factsOf('费用合计 120 万元。');
    const b = factsOf('费用合计 1200000 元。');
    const [pair] = matchFacts(a, b);
    expect(pair[0]).toBeDefined();
    expect(pair[1]).toBeDefined();
    expect(valuesEqual(pair[0]!, pair[1]!)).toBe(true);
  });

  it('时长单位换算：1.5 个月 = 45 天 ≠ 10 天', () => {
    const months = factsOf('账期 1.5 个月。')[0];
    const days45 = factsOf('账期 45 天。')[0];
    const days10 = factsOf('账期 10 天。')[0];
    expect(valuesEqual(months, days45)).toBe(true);
    expect(valuesEqual(months, days10)).toBe(false);
  });

  it('数量名词不同不兼容（12 家分行 ≠ 12 名员工）', () => {
    const a = factsOf('覆盖十二家分行。');
    const b = factsOf('现有十二名员工。');
    const pairs = matchFacts(a, b);
    expect(pairs.every(([x, y]) => !(x && y))).toBe(true);
  });
});

describe('候选数值格式化', () => {
  it('按原文单位与数字风格改写', () => {
    const total = factsOf('费用合计 120 万元。')[0];
    expect(formatValueForRaw(total, 900000)).toBe('90 万元');
    const days = factsOf('退款期限 30 天。')[0];
    expect(formatValueForRaw(days, 45)).toBe('45 天');
    const cn = factsOf('退款期限 三十 天。')[0];
    expect(formatValueForRaw(cn, 45)).toBe('四十五 天');
    const months = factsOf('账期 1 个月。')[0];
    expect(formatValueForRaw(months, 45)).toBe('1.5 个月');
  });
});

describe('法务锁定段落', () => {
  it('声明/免责/法规引用判定为锁定', () => {
    expect(isLegalLocked('前瞻性声明：本新闻稿包含的前瞻性陈述存在不确定性。')).toBe(true);
    expect(isLegalLocked('本平台符合《中华人民共和国数据安全法》的相关要求。')).toBe(true);
    expect(isLegalLocked('具体以监管要求为准。')).toBe(true);
    expect(isLegalLocked('注1：退款期限 30 天，以合同约定为准。')).toBe(false);
    expect(isLegalLocked('项目预算：设计费 50 万元。')).toBe(false);
  });
});
