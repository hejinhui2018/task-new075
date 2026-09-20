import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import App from '../../App';
import { FactPanel } from '../../components/FactPanel';
import { mergeDocuments } from '../merge';
import { SAMPLE_FACTS_BASE, SAMPLE_FACTS_BRAND, SAMPLE_FACTS_LEGAL } from '../sample';
import { splitParagraphs } from '../text';
import { verifyFacts } from '../verify';

const noop = () => {};

describe('界面渲染冒烟', () => {
  it('App 默认示例渲染：无事实冲突', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('联合改稿工作台');
    expect(html).toContain('事实校核通过');
    expect(html).toContain('事实校核示例');
  });

  it('FactPanel 渲染事实校核示例的 5 项问题与锁定候选', () => {
    const paras = {
      base: splitParagraphs(SAMPLE_FACTS_BASE),
      brand: splitParagraphs(SAMPLE_FACTS_BRAND),
      legal: splitParagraphs(SAMPLE_FACTS_LEGAL),
    };
    const entries = mergeDocuments(paras.base, paras.brand, paras.legal, {});
    const report = verifyFacts(paras, entries);
    expect(report.issues).toHaveLength(5);

    const html = renderToStaticMarkup(
      createElement(FactPanel, {
        report,
        pending: report.issues,
        acked: [],
        activeIssueId: null,
        entryLabel: (id: string) => id,
        onSelectIssue: noop,
        onLocateEntry: noop,
        onApplyCandidate: noop,
        onAck: noop,
        onUnack: noop,
      }),
    );
    expect(html).toContain('事实冲突 5');
    expect(html).toContain('口径不一致');
    expect(html).toContain('合计不符');
    expect(html).toContain('日期顺序矛盾');
    expect(html).toContain('引用目标漂移');
    // 锁定候选只提示不自动改写
    expect(html).toContain('法务锁定');
    // 依赖链与来源/当前值
    expect(html).toContain('依赖链');
    expect(html).toContain('合并当前值');
  });
});
