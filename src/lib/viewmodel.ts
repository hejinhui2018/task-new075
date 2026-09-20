/**
 * 视图模型：把 diff / merge 结果翻译成界面要展示的徽标与来源信息。
 */

import type { ParaDiff } from './diff';
import type { Origin, Side } from './merge';
import type { IssueKind, Severity } from './verify';

export type Tone = 'base' | 'brand' | 'legal' | 'warn' | 'ok' | 'muted';

export interface ParaBadge {
  icon: string;
  label: string;
  tone: Tone;
}

export interface SourcePara {
  /** 该版本内的段落下标（0 起）。 */
  index: number;
  text: string;
  badges: ParaBadge[];
  /** 对应的底稿段落下标（新增段落没有）。 */
  baseIndex?: number;
}

export const SIDE_LABEL: Record<Side, string> = { brand: '品牌', legal: '法务' };

export function anchorLabel(anchor: number, baseLength: number): string {
  return anchor >= baseLength ? '文末' : `第 ${anchor + 1} 段前`;
}

/** 底稿面板：展示每一方对该段做了什么。 */
export function buildBaseView(base: string[], diffB: ParaDiff, diffL: ParaDiff): SourcePara[] {
  return base.map((text, i) => {
    const badges: ParaBadge[] = [];
    const sides: Array<[Side, ParaDiff]> = [
      ['brand', diffB],
      ['legal', diffL],
    ];
    for (const [side, diff] of sides) {
      const op = diff.ops[i];
      const label = SIDE_LABEL[side];
      if (op.type === 'modify') {
        badges.push({ icon: '✎', label: `${label}修改`, tone: side });
      } else if (op.type === 'delete') {
        badges.push({ icon: '✕', label: `${label}删除`, tone: side });
      } else if (op.type === 'move') {
        badges.push({ icon: '⇄', label: `${label}移至${anchorLabel(op.anchor, base.length)}`, tone: side });
      }
    }
    return { index: i, text, badges, baseIndex: i };
  });
}

/** 品牌版 / 法务版面板：展示该段相对底稿的状态。 */
export function buildSideView(
  modified: string[],
  diff: ParaDiff,
  side: Side,
): SourcePara[] {
  const view: SourcePara[] = modified.map((text, j) => ({
    index: j,
    text,
    badges: [],
    baseIndex: undefined,
  }));
  diff.ops.forEach((op, i) => {
    if (op.type === 'modify') {
      view[op.modIndex].badges.push({ icon: '✎', label: `修改 · 对应底稿第 ${i + 1} 段`, tone: side });
      view[op.modIndex].baseIndex = i;
    } else if (op.type === 'move') {
      view[op.modIndex].badges.push({
        icon: '⇄',
        label: `自底稿第 ${i + 1} 段移来`,
        tone: side,
      });
      view[op.modIndex].baseIndex = i;
    } else if (op.type === 'keep') {
      view[op.modIndex].baseIndex = i;
    }
  });
  for (const slot of diff.inserts) {
    for (const ins of slot) {
      view[ins.modIndex].badges.push({ icon: '＋', label: '新增段落', tone: side });
    }
  }
  return view;
}

/** 合并结果的来源徽标。 */
export function originBadges(origin: Origin): ParaBadge[] {
  switch (origin.kind) {
    case 'base':
      return [{ icon: '＝', label: '底稿原文', tone: 'muted' }];
    case 'edit':
      return origin.by === 'both'
        ? [{ icon: '✎', label: '双方一致修改', tone: 'ok' }]
        : [{ icon: '✎', label: `${SIDE_LABEL[origin.by]}修改`, tone: origin.by }];
    case 'insert':
      return origin.by === 'both'
        ? [{ icon: '＋', label: '双方新增', tone: 'ok' }]
        : [{ icon: '＋', label: `${SIDE_LABEL[origin.by]}新增`, tone: origin.by }];
    case 'move':
      return origin.by === 'both'
        ? [{ icon: '⇄', label: '双方移动', tone: 'ok' }]
        : [{ icon: '⇄', label: `${SIDE_LABEL[origin.by]}移动`, tone: origin.by }];
    case 'move-edit':
      return [
        { icon: '⇄', label: `${SIDE_LABEL[origin.movedBy]}移动`, tone: origin.movedBy },
        { icon: '✎', label: `${SIDE_LABEL[origin.editedBy]}修改`, tone: origin.editedBy },
      ];
    case 'resolved':
      return [];
  }
}

export function conflictTypeLabel(type: 'edit-edit' | 'delete-edit' | 'edit-delete' | 'move-move'): string {
  switch (type) {
    case 'edit-edit':
      return '双方修改了同一段落';
    case 'delete-edit':
      return '品牌删除 · 法务修改';
    case 'edit-delete':
      return '品牌修改 · 法务删除';
    case 'move-move':
      return '双方移动到不同位置';
  }
}

export function resolutionLabel(choice: 'brand' | 'legal' | 'base' | 'custom'): string {
  switch (choice) {
    case 'brand':
      return '采用品牌版';
    case 'legal':
      return '采用法务版';
    case 'base':
      return '采用底稿原文';
    case 'custom':
      return '手动填写';
  }
}

// —— 事实完整性校核 ——

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  'value-mismatch': '口径不一致',
  'sum-mismatch': '合计不符',
  'date-order': '日期顺序矛盾',
  'ratio-range': '比例越界',
  'ref-stale': '引用目标漂移',
  'ref-broken': '引用目标已删除',
  'ref-unresolved': '引用无法解析',
  'footnote-dangling': '脚注缺失',
  'footnote-orphan': '脚注未被引用',
};

export const ISSUE_KIND_ICON: Record<IssueKind, string> = {
  'value-mismatch': '⚖',
  'sum-mismatch': '🧮',
  'date-order': '📅',
  'ratio-range': '📊',
  'ref-stale': '🔗',
  'ref-broken': '🔗',
  'ref-unresolved': '🔗',
  'footnote-dangling': '※',
  'footnote-orphan': '※',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: '需处理',
  warn: '警告',
  info: '提示',
};

/** 合并条目的来源引用文字，如「底稿 §3 · 品牌 §3 · 法务 §4」。 */
export function refsLabel(refs: { base?: number; brand?: number; legal?: number }): string {
  const parts: string[] = [];
  if (refs.base !== undefined) parts.push(`底稿 §${refs.base + 1}`);
  if (refs.brand !== undefined) parts.push(`品牌 §${refs.brand + 1}`);
  if (refs.legal !== undefined) parts.push(`法务 §${refs.legal + 1}`);
  return parts.join(' · ');
}
