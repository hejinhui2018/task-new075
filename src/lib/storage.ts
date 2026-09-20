/**
 * 浏览器本地持久化（localStorage）。
 *
 * v2 保存：文档（含比较基线——共同底稿）、冲突解决记录（决议）、
 * 事实问题确认记录（acks）与撤销/重做历史（past/future，各限 30 步）。
 * 事实身份由文档与决议确定性推导，随上述状态一并恢复。
 * v1 存档（仅 docs + resolutions）加载时自动迁移。
 */

import type { Resolution } from './merge';

const STORAGE_KEY = 'pr-merge-workbench:v1';

/** 撤销/重做历史的持久化上限。 */
export const PERSIST_HISTORY_LIMIT = 30;

export interface DocsState {
  base: string;
  brand: string;
  legal: string;
}

/** 一次可撤销操作所对应的完整工作状态。 */
export interface WorkSnapshot {
  docs: DocsState;
  resolutions: Record<string, Resolution>;
  /** 事实问题确认记录：ackKey → 内容指纹。 */
  acks: Record<string, string>;
}

export interface PersistedState extends WorkSnapshot {
  past: WorkSnapshot[];
  future: WorkSnapshot[];
}

function isResolution(v: unknown): v is Resolution {
  if (!v || typeof v !== 'object') return false;
  const c = (v as Resolution).choice;
  return c === 'brand' || c === 'legal' || c === 'base' || c === 'custom';
}

function isDocs(v: unknown): v is DocsState {
  if (!v || typeof v !== 'object') return false;
  const d = v as DocsState;
  return typeof d.base === 'string' && typeof d.brand === 'string' && typeof d.legal === 'string';
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

function isSnapshot(v: unknown): v is WorkSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as WorkSnapshot;
  return (
    isDocs(s.docs) &&
    !!s.resolutions &&
    typeof s.resolutions === 'object' &&
    Object.values(s.resolutions).every(isResolution) &&
    isStringRecord(s.acks)
  );
}

function sanitizeSnapshot(v: unknown): WorkSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<WorkSnapshot>;
  if (!isDocs(s.docs)) return null;
  if (!s.resolutions || typeof s.resolutions !== 'object') return null;
  if (!Object.values(s.resolutions).every(isResolution)) return null;
  return {
    docs: s.docs,
    resolutions: s.resolutions as Record<string, Resolution>,
    acks: isStringRecord(s.acks) ? s.acks : {},
  };
}

export function loadState(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    const present = sanitizeSnapshot(parsed);
    if (!present) return null;

    // v2：带撤销/重做历史；v1：无 past/future 字段，按空历史迁移
    const past = Array.isArray(parsed.past) ? parsed.past.map(sanitizeSnapshot).filter(isSnapshot) : [];
    const future = Array.isArray(parsed.future) ? parsed.future.map(sanitizeSnapshot).filter(isSnapshot) : [];
    return { ...present, past, future };
  } catch {
    return null;
  }
}

export function saveState(state: PersistedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（隐私模式等）时静默失败，不影响使用。
  }
}
