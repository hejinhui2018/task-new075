/**
 * 浏览器本地持久化（localStorage）。
 *
 * v2 在 v1（文档 + 文本冲突解决记录）之上增加：
 * - 事实决议（事实完整性冲突的确认记录）；
 * - 比较基线（事实值快照，用于「较基线已变更」提示）；
 * - 撤销 / 重做历史（past / future 各保留最近 20 步）。
 *
 * 旧版 v1 数据自动迁移；数据损坏时静默放弃，不影响使用。
 */

import type { Resolution } from './merge';

const STORAGE_KEY = 'pr-merge-workbench:v2';
const LEGACY_STORAGE_KEY = 'pr-merge-workbench:v1';

/** 历史栈持久化上限（past / future 各自）。 */
export const PERSISTED_HISTORY_LIMIT = 20;

export interface Docs {
  base: string;
  brand: string;
  legal: string;
}

/** 事实决议：用户确认某条事实完整性冲突已知悉。 */
export interface FactResolution {
  choice: 'acknowledged';
}

/** 比较基线中的一条事实快照。 */
export interface BaselineEntry {
  /** 事实身份 id。 */
  id: string;
  slot: string;
  kind: string;
  raw: string;
  valueKey: string;
}

export interface FactBaseline {
  savedAt: string;
  entries: BaselineEntry[];
}

/** 一次可撤销的工作快照。 */
export interface WorkSnapshot {
  docs: Docs;
  resolutions: Record<string, Resolution>;
  factResolutions: Record<string, FactResolution>;
  baseline: FactBaseline | null;
}

export interface PersistedState extends WorkSnapshot {
  version: 2;
  history: {
    past: WorkSnapshot[];
    future: WorkSnapshot[];
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function validSnapshot(v: unknown): v is WorkSnapshot {
  if (!isRecord(v)) return false;
  const docs = v.docs;
  return (
    isRecord(docs) &&
    typeof docs.base === 'string' &&
    typeof docs.brand === 'string' &&
    typeof docs.legal === 'string' &&
    isRecord(v.resolutions) &&
    isRecord(v.factResolutions)
  );
}

function parseV2(parsed: unknown): PersistedState | null {
  if (!isRecord(parsed) || parsed.version !== 2) return null;
  if (!validSnapshot(parsed)) return null;
  const history = isRecord(parsed.history) ? parsed.history : {};
  const past = Array.isArray(history.past) ? history.past.filter(validSnapshot) : [];
  const future = Array.isArray(history.future) ? history.future.filter(validSnapshot) : [];
  return {
    version: 2,
    docs: parsed.docs as Docs,
    resolutions: parsed.resolutions as Record<string, Resolution>,
    factResolutions: parsed.factResolutions as Record<string, FactResolution>,
    baseline: (parsed.baseline ?? null) as FactBaseline | null,
    history: { past, future },
  };
}

/** v1 → v2 迁移：补充事实决议 / 基线 / 历史的默认值。 */
function migrateV1(parsed: unknown): PersistedState | null {
  if (!isRecord(parsed)) return null;
  const docs = parsed.docs;
  if (
    !isRecord(docs) ||
    typeof docs.base !== 'string' ||
    typeof docs.brand !== 'string' ||
    typeof docs.legal !== 'string' ||
    !isRecord(parsed.resolutions)
  ) {
    return null;
  }
  return {
    version: 2,
    docs: { base: docs.base, brand: docs.brand, legal: docs.legal } as Docs,
    resolutions: parsed.resolutions as Record<string, Resolution>,
    factResolutions: {},
    baseline: null,
    history: { past: [], future: [] },
  };
}

export function loadState(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v2 = parseV2(JSON.parse(raw));
      if (v2) return v2;
    }
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) return migrateV1(JSON.parse(legacy));
    return null;
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
