import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadState, saveState, type PersistedState } from '../storage';

/** 模拟 localStorage 的内存实现。 */
function stubLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe('本地持久化与恢复', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('保存后完整恢复：文档、决议、确认与撤销/重做历史', () => {
    vi.stubGlobal('window', { localStorage: stubLocalStorage() });
    const state: PersistedState = {
      docs: { base: '底稿一。', brand: '品牌一。', legal: '法务一。' },
      resolutions: { b1: { choice: 'legal' }, b3: { choice: 'custom', text: '手工文本。' } },
      acks: { 'value-mismatch|退款期限': 'sig-1' },
      past: [
        {
          docs: { base: '底稿零。', brand: '品牌零。', legal: '法务零。' },
          resolutions: {},
          acks: {},
        },
      ],
      future: [
        {
          docs: { base: '底稿二。', brand: '品牌二。', legal: '法务二。' },
          resolutions: { b1: { choice: 'brand' } },
          acks: {},
        },
      ],
    };
    saveState(state);
    const restored = loadState();
    expect(restored).toEqual(state);
    // 恢复后撤销/重做可用
    expect(restored!.past).toHaveLength(1);
    expect(restored!.future).toHaveLength(1);
  });

  it('v1 存档（无确认与历史字段）自动迁移', () => {
    vi.stubGlobal('window', { localStorage: stubLocalStorage() });
    window.localStorage.setItem(
      'pr-merge-workbench:v1',
      JSON.stringify({
        docs: { base: '底稿。', brand: '品牌。', legal: '法务。' },
        resolutions: { b2: { choice: 'base' } },
      }),
    );
    const restored = loadState();
    expect(restored).toEqual({
      docs: { base: '底稿。', brand: '品牌。', legal: '法务。' },
      resolutions: { b2: { choice: 'base' } },
      acks: {},
      past: [],
      future: [],
    });
  });

  it('损坏的存档返回 null，不抛异常', () => {
    vi.stubGlobal('window', { localStorage: stubLocalStorage() });
    window.localStorage.setItem('pr-merge-workbench:v1', '{not json');
    expect(loadState()).toBeNull();
    window.localStorage.setItem(
      'pr-merge-workbench:v1',
      JSON.stringify({ docs: { base: 1 }, resolutions: {} }),
    );
    expect(loadState()).toBeNull();
  });

  it('历史中的非法快照被过滤，合法快照保留', () => {
    vi.stubGlobal('window', { localStorage: stubLocalStorage() });
    window.localStorage.setItem(
      'pr-merge-workbench:v1',
      JSON.stringify({
        docs: { base: '底稿。', brand: '品牌。', legal: '法务。' },
        resolutions: {},
        acks: {},
        past: [
          { docs: { base: 'x', brand: 'y', legal: 'z' }, resolutions: {}, acks: {} },
          { docs: 'broken' },
        ],
        future: [],
      }),
    );
    const restored = loadState();
    expect(restored!.past).toHaveLength(1);
    expect(restored!.past[0].docs.base).toBe('x');
  });
});
