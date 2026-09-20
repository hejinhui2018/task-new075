import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadState,
  saveState,
  PERSISTED_HISTORY_LIMIT,
  type PersistedState,
  type WorkSnapshot,
} from '../storage';

/** 内存版 localStorage。 */
function mockLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    _map: map,
  };
}

const snapshot: WorkSnapshot = {
  docs: { base: '底稿。', brand: '品牌版。', legal: '法务版。' },
  resolutions: { b3: { choice: 'legal' } },
  factResolutions: { 'sum:9:合计:amount': { choice: 'acknowledged' } },
  baseline: {
    savedAt: '2026-09-20T08:00:00.000Z',
    entries: [{ id: 'b0::窗口:duration', slot: '窗口:duration', kind: 'duration', raw: '30天', valueKey: 'duration:30' }],
  },
};

function persistedOf(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 2,
    ...snapshot,
    history: { past: [], future: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: mockLocalStorage() });
});

describe('本地持久化 v2', () => {
  it('保存 / 恢复完整往返：文档、决议、事实决议、比较基线', () => {
    saveState(persistedOf());
    const loaded = loadState();
    expect(loaded).not.toBeNull();
    expect(loaded!.docs).toEqual(snapshot.docs);
    expect(loaded!.resolutions).toEqual(snapshot.resolutions);
    expect(loaded!.factResolutions).toEqual(snapshot.factResolutions);
    expect(loaded!.baseline).toEqual(snapshot.baseline);
  });

  it('撤销 / 重做历史随状态一起恢复', () => {
    const older: WorkSnapshot = { ...snapshot, docs: { ...snapshot.docs, brand: '更早的品牌版。' } };
    const newer: WorkSnapshot = { ...snapshot, docs: { ...snapshot.docs, brand: '较新的品牌版。' } };
    saveState(persistedOf({ history: { past: [older], future: [newer] } }));
    const loaded = loadState()!;
    expect(loaded.history.past).toHaveLength(1);
    expect(loaded.history.past[0].docs.brand).toBe('更早的品牌版。');
    expect(loaded.history.future[0].docs.brand).toBe('较新的品牌版。');
  });

  it('v1 旧数据自动迁移：补默认事实决议 / 基线 / 历史', () => {
    const v1 = {
      docs: snapshot.docs,
      resolutions: { b1: { choice: 'brand' } },
    };
    window.localStorage.setItem('pr-merge-workbench:v1', JSON.stringify(v1));
    const loaded = loadState()!;
    expect(loaded.version).toBe(2);
    expect(loaded.resolutions).toEqual(v1.resolutions);
    expect(loaded.factResolutions).toEqual({});
    expect(loaded.baseline).toBeNull();
    expect(loaded.history).toEqual({ past: [], future: [] });
  });

  it('v2 数据优先于 v1', () => {
    window.localStorage.setItem('pr-merge-workbench:v1', JSON.stringify({ docs: { base: '旧', brand: '旧', legal: '旧' }, resolutions: {} }));
    saveState(persistedOf());
    const loaded = loadState()!;
    expect(loaded.docs.brand).toBe('品牌版。');
  });

  it('数据损坏 / 结构不符 → 返回 null（静默恢复）', () => {
    window.localStorage.setItem('pr-merge-workbench:v2', 'not-json{{{');
    expect(loadState()).toBeNull();
    window.localStorage.setItem('pr-merge-workbench:v2', JSON.stringify({ version: 2, docs: { base: 1 } }));
    expect(loadState()).toBeNull();
    window.localStorage.setItem('pr-merge-workbench:v2', JSON.stringify({ version: 3, docs: snapshot.docs }));
    expect(loadState()).toBeNull();
  });

  it('历史中的坏快照被过滤，好快照保留', () => {
    const good: WorkSnapshot = { ...snapshot };
    saveState(
      persistedOf({
        history: { past: [good, { docs: { base: 1 } } as unknown as WorkSnapshot], future: [] },
      }),
    );
    const loaded = loadState()!;
    expect(loaded.history.past).toHaveLength(1);
  });

  it('存储不可用（抛异常）时静默失败', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    });
    expect(() => saveState(persistedOf())).not.toThrow();
    expect(loadState()).toBeNull();
  });

  it('历史持久化上限常量存在且为正', () => {
    expect(PERSISTED_HISTORY_LIMIT).toBeGreaterThan(0);
  });
});
