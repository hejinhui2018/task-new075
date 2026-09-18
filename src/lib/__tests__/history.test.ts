import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, initHistory, redo, undo } from '../history';

interface Doc {
  text: string;
  resolved: string[];
}

const s0: Doc = { text: '底稿', resolved: [] };

describe('撤销 / 重做', () => {
  it('初始状态不能撤销也不能重做', () => {
    const h = initHistory(s0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('commit 后可以撤销，撤销后回到之前的状态', () => {
    let h = initHistory(s0);
    const s1: Doc = { text: '底稿', resolved: ['b3'] };
    h = commit(h, s1);
    expect(h.present).toBe(s1);
    expect(canUndo(h)).toBe(true);

    h = undo(h);
    expect(h.present).toBe(s0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);
  });

  it('重做恢复被撤销的状态', () => {
    let h = initHistory(s0);
    const s1: Doc = { text: '底稿', resolved: ['b3'] };
    h = commit(h, s1);
    h = undo(h);
    h = redo(h);
    expect(h.present).toBe(s1);
    expect(canRedo(h)).toBe(false);
  });

  it('连续多步撤销 / 重做', () => {
    let h = initHistory(s0);
    const states: Doc[] = [
      { text: '底稿', resolved: ['b3'] },
      { text: '底稿', resolved: ['b3', 'b5'] },
      { text: '底稿改', resolved: ['b3', 'b5'] },
    ];
    for (const s of states) h = commit(h, s);
    expect(h.present).toBe(states[2]);

    h = undo(h);
    expect(h.present).toBe(states[1]);
    h = undo(h);
    expect(h.present).toBe(states[0]);
    h = undo(h);
    expect(h.present).toBe(s0);
    h = undo(h); // 到底后无操作
    expect(h.present).toBe(s0);

    h = redo(h);
    h = redo(h);
    expect(h.present).toBe(states[1]);
    h = redo(h);
    expect(h.present).toBe(states[2]);
    h = redo(h); // 到顶后无操作
    expect(h.present).toBe(states[2]);
  });

  it('撤销后再提交新状态 → 清空重做栈', () => {
    let h = initHistory(s0);
    h = commit(h, { text: '底稿', resolved: ['b3'] });
    h = undo(h);
    h = commit(h, { text: '底稿', resolved: ['b5'] });
    expect(canRedo(h)).toBe(false);
    expect(h.present.resolved).toEqual(['b5']);
  });

  it('提交相同状态（引用相等）→ 不产生历史', () => {
    let h = initHistory(s0);
    h = commit(h, s0);
    expect(canUndo(h)).toBe(false);
  });

  it('历史长度有上限', () => {
    let h = initHistory(s0);
    for (let i = 1; i <= 10; i++) {
      h = commit(h, { text: `v${i}`, resolved: [] }, 5);
    }
    expect(h.past.length).toBe(5);
    // 只能撤销 5 步
    for (let i = 0; i < 5; i++) h = undo(h);
    expect(canUndo(h)).toBe(false);
    expect(h.present.text).toBe('v5');
  });
});
