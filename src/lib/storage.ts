/**
 * 浏览器本地持久化（localStorage）。
 * 只保存文档与解决记录，历史栈不持久化。
 */

const STORAGE_KEY = 'pr-merge-workbench:v1';

export interface PersistedState {
  docs: { base: string; brand: string; legal: string };
  resolutions: Record<string, { choice: 'brand' | 'legal' | 'base' | 'custom'; text?: string }>;
}

export function loadState(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.docs?.base !== 'string' ||
      typeof parsed.docs?.brand !== 'string' ||
      typeof parsed.docs?.legal !== 'string' ||
      typeof parsed.resolutions !== 'object'
    ) {
      return null;
    }
    return parsed;
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
