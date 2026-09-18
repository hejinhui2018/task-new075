import { describe, expect, it } from 'vitest';
import { similarity, tokenDiff, tokenize } from '../tokenize';

describe('tokenize 分词', () => {
  it('中文按单字切分', () => {
    expect(tokenize('数据安全')).toEqual(['数', '据', '安', '全']);
  });

  it('英文与数字按单词切分', () => {
    expect(tokenize('2026年Q4发布v2.0')).toEqual(['2026', '年', 'Q4', '发', '布', 'v2', '.', '0']);
  });

  it('标点与空白各自成 token', () => {
    const tokens = tokenize('你好， 世界');
    expect(tokens).toContain('，');
    expect(tokens).toContain(' ');
  });
});

describe('similarity 相似度', () => {
  it('完全相同为 1', () => {
    expect(similarity('星澜科技', '星澜科技')).toBe(1);
  });

  it('完全不同为 0', () => {
    expect(similarity('星澜科技', '北辰银行')).toBe(0);
  });

  it('部分重叠介于 0 和 1 之间', () => {
    const s = similarity('星澜科技发布新平台', '星澜科技发布新产品的平台');
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
});

describe('tokenDiff 词级差异', () => {
  it('纯插入', () => {
    const parts = tokenDiff('平台开放公测', '平台开放小范围公测');
    expect(parts).toEqual([
      { type: 'same', text: '平台开放' },
      { type: 'ins', text: '小范围' },
      { type: 'same', text: '公测' },
    ]);
  });

  it('纯删除', () => {
    const parts = tokenDiff('平台正式开放公测', '平台开放公测');
    expect(parts).toEqual([
      { type: 'same', text: '平台' },
      { type: 'del', text: '正式' },
      { type: 'same', text: '开放公测' },
    ]);
  });

  it('替换', () => {
    const parts = tokenDiff('每年投入三千万元', '每年投入五千万元');
    expect(parts).toEqual([
      { type: 'same', text: '每年投入' },
      { type: 'del', text: '三' },
      { type: 'ins', text: '五' },
      { type: 'same', text: '千万元' },
    ]);
  });

  it('拼接后还原新文本', () => {
    const oldText = '双方计划设立联合实验室，持续投入数据安全研究。';
    const newText = '双方计划设立联合实验室，未来三年每年投入不少于五千万元，用于数据安全研究。';
    const parts = tokenDiff(oldText, newText);
    const reconstructed = parts
      .filter((p) => p.type !== 'del')
      .map((p) => p.text)
      .join('');
    expect(reconstructed).toBe(newText);
    const reconstructedOld = parts
      .filter((p) => p.type !== 'ins')
      .map((p) => p.text)
      .join('');
    expect(reconstructedOld).toBe(oldText);
  });

  it('长段落也能逐字定位差异', () => {
    const oldText = '关于星澜科技：星澜科技成立于2018年，专注数据加密与隐私计算，已服务超过两百家企业客户。';
    const newText = '关于星澜科技：星澜科技成立于2018年，专注数据加密与隐私计算，已服务超过两百家企业客户（数据来源：公司2025年年度报告）。';
    const parts = tokenDiff(oldText, newText);
    const ins = parts.filter((p) => p.type === 'ins').map((p) => p.text).join('');
    expect(ins).toBe('（数据来源：公司2025年年度报告）');
  });
});
