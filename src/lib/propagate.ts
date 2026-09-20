/**
 * 同步更新候选与法务锁定。
 *
 * 用户解决上游事实（如正文冲突采用「45 天」）后，派生值与引用可能过期。
 * 本模块从 FactIssue 生成「同步更新候选」：建议把某个来源文档中的旧表述替换为新表述。
 *
 * 约束：
 * - 候选只**提出**，由用户逐项采用；采用后修改来源文档，全部关系自动重新验证；
 * - 法务锁定段落（前瞻性声明、免责声明、风险提示等）不生成可一键采用的候选，
 *   只给出提示，绝不自动改写。
 */

import type { FactIssue, FactModel } from './checks';
import type { Fact } from './facts';
import { splitParagraphs, joinParagraphs, normalizeText } from './text';

export interface Replacement {
  oldFragment: string;
  newFragment: string;
}

export interface SyncCandidate {
  id: string;
  issueId: string;
  /** 要修改的来源文档。 */
  doc: 'brand' | 'legal';
  /** 文档内段落下标。 */
  paraIndex: number;
  reason: string;
  replacements: Replacement[];
  /** 法务锁定段落：仅提示，不可一键采用。 */
  locked: boolean;
}

/** 法务锁定关键词：命中即视为锁定段落。 */
export const LOCK_KEYWORDS = ['前瞻性声明', '免责声明', '风险提示'];

export function isLockedParagraph(text: string): boolean {
  return LOCK_KEYWORDS.some((w) => text.includes(w));
}

// ———————————————————— 数值格式化 ————————————————————

/** 0~9999 整数转中文数词（计数语境：独立的 2 作「两」，数位上作「二」）。 */
export function toChineseNumber(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
  const digits = '零一二三四五六七八九';
  if (n === 0) return '零';
  if (n === 2) return '两';
  if (n >= 10 && n <= 19) {
    return n === 10 ? '十' : `十${digits[n % 10]}`;
  }
  const units = ['', '十', '百', '千'];
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const pos = s.length - 1 - i;
    if (d === 0) {
      if (out && !out.endsWith('零')) out += '零';
      continue;
    }
    out += digits[d] + units[pos];
  }
  return out.replace(/零+$/, '');
}

/** 按模板原文的单位与数制，把归一化金额（元）格式化回去。 */
export function formatAmountLike(yuan: number, templateRaw: string): string {
  const unitMatch = /(千万|百万|亿|万)/.exec(templateRaw);
  const scale = unitMatch ? { 亿: 1e8, 千万: 1e7, 百万: 1e6, 万: 1e4 }[unitMatch[1] as '亿' | '千万' | '百万' | '万'] : 1;
  const value = yuan / scale;
  const hasYuan = templateRaw.includes('元');
  const templateIsChinese = !/\d/.test(templateRaw);
  const rounded = Math.round(value * 100) / 100;
  if (templateIsChinese && Number.isInteger(rounded)) {
    const cn = toChineseNumber(rounded);
    if (cn) return `${cn}${unitMatch?.[1] ?? ''}${hasYuan ? '元' : ''}`;
  }
  return `${rounded}${unitMatch?.[1] ?? ''}${hasYuan ? '元' : ''}`;
}

// ———————————————————— 候选生成 ————————————————————

interface SourceRef {
  doc: 'brand' | 'legal';
  paraIndex: number;
  text: string;
}

/** 找到合并稿段落在品牌/法务版中的对应段落。
 *  要求来源段落文本与合并稿一致（规范化后）——
 *  合并稿文本来自哪一方，候选就投向哪一方；另一方的同名表述可能语境不同，不能误改。 */
function sourceRefsFor(model: FactModel, mergedParaIndex: number, fragment: string, docs: { brand: string[]; legal: string[] }): SourceRef[] {
  const item = model.mergedItems[mergedParaIndex];
  if (!item) return [];
  const mergedNorm = normalizeText(item.text);
  const out: SourceRef[] = [];
  for (const doc of ['brand', 'legal'] as const) {
    const idx = item.refs[doc];
    if (idx === undefined) continue;
    const text = docs[doc][idx];
    if (text !== undefined && normalizeText(text) === mergedNorm && text.includes(fragment)) {
      out.push({ doc, paraIndex: idx, text });
    }
  }
  return out;
}

function factAt(model: FactModel, paraIndex: number, raw: string): Fact | undefined {
  return model.mergedFacts.find((f) => f.paraIndex === paraIndex && f.raw === raw);
}

/** 从验证问题生成同步更新候选。 */
export function buildSyncCandidates(
  issues: FactIssue[],
  model: FactModel,
  docs: { brand: string[]; legal: string[] },
): SyncCandidate[] {
  const candidates: SyncCandidate[] = [];

  for (const issue of issues) {
    if (issue.type === 'sum-mismatch') {
      // 合计 → 改为分项之和；「N项」→ 改为实际分项数。
      const totalNode = issue.chain.find((n) => n.role === 'derived');
      if (!totalNode) continue;
      const parts = issue.chain.filter((n) => n.role === 'def');
      const sum = parts.reduce((acc, p) => {
        const f = factAt(model, p.paraIndex, p.raw);
        return acc + (f && f.value.kind === 'amount' ? f.value.yuan : 0);
      }, 0);
      const totalFact = factAt(model, totalNode.paraIndex, totalNode.raw);
      if (!totalFact) continue;
      const replacements: Replacement[] = [
        { oldFragment: totalNode.raw, newFragment: formatAmountLike(sum, totalNode.raw) },
      ];
      const declared = model.mergedFacts.find(
        (f) => f.kind === 'count' && f.paraIndex === totalNode.paraIndex && f.value.kind === 'count' && f.value.unit === '项',
      );
      if (declared && declared.value.kind === 'count' && declared.value.value !== parts.length) {
        const cn = toChineseNumber(parts.length);
        if (cn) replacements.push({ oldFragment: declared.raw, newFragment: `${cn}项` });
      }
      for (const src of sourceRefsFor(model, totalNode.paraIndex, totalNode.raw, docs)) {
        candidates.push({
          id: `${issue.id}:${src.doc}`,
          issueId: issue.id,
          doc: src.doc,
          paraIndex: src.paraIndex,
          reason: `分项合计为 ${formatAmountLike(sum, totalNode.raw)}，同步更新「${totalNode.raw}」`,
          replacements,
          locked: isLockedParagraph(src.text),
        });
      }
    } else if (issue.type === 'value-inconsistent') {
      const def = issue.chain.find((n) => n.role === 'def');
      const staleNodes = issue.chain.filter((n) => n.stale);
      if (!def) continue;
      for (const stale of staleNodes) {
        for (const src of sourceRefsFor(model, stale.paraIndex, stale.raw, docs)) {
          candidates.push({
            id: `${issue.id}:${src.doc}:${src.paraIndex}`,
            issueId: issue.id,
            doc: src.doc,
            paraIndex: src.paraIndex,
            reason: `正文已更新为「${def.raw}」，同步派生表述「${stale.raw}」`,
            replacements: [{ oldFragment: stale.raw, newFragment: def.raw }],
            locked: isLockedParagraph(src.text),
          });
        }
      }
    } else if (issue.type === 'ref-stale') {
      const refNode = issue.chain.find((n) => n.role === 'ref');
      const migrateTo = refNode?.migrateTo;
      if (!refNode || !migrateTo) continue;
      for (const src of sourceRefsFor(model, refNode.paraIndex, refNode.raw, docs)) {
        candidates.push({
          id: `${issue.id}:${src.doc}`,
          issueId: issue.id,
          doc: src.doc,
          paraIndex: src.paraIndex,
          reason: `条款已更名，引用「${refNode.raw}」迁移为「${migrateTo}」`,
          replacements: [{ oldFragment: refNode.raw, newFragment: migrateTo }],
          locked: isLockedParagraph(src.text),
        });
      }
    }
    // date-order / percent-range / ref-unresolved / ref-ambiguous：需人工判断，不生成候选。
  }
  return candidates;
}

/** 应用候选：在指定文档的指定段落中执行替换，返回新的文档全文。 */
export function applyCandidate(docText: string, candidate: SyncCandidate): string {
  if (candidate.locked) return docText; // 法务锁定段落：拒绝自动改写
  const paras = splitParagraphs(docText);
  const target = paras[candidate.paraIndex];
  if (target === undefined) return docText;
  let next = target;
  for (const { oldFragment, newFragment } of candidate.replacements) {
    if (!next.includes(oldFragment)) return docText; // 片段已不存在：放弃，避免误改
    next = next.replace(oldFragment, newFragment);
  }
  paras[candidate.paraIndex] = next;
  return joinParagraphs(paras);
}
