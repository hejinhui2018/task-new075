import { useCallback, useEffect, useMemo, useState } from 'react';
import { diffParagraphs } from './lib/diff';
import { canRedo, canUndo, commit, initHistory, redo, undo, type History } from './lib/history';
import {
  finalText,
  mergeDocuments,
  sanitizeResolutions,
  summarize,
  type Resolution,
} from './lib/merge';
import { SAMPLE_DOCS } from './lib/sample';
import { loadState, saveState } from './lib/storage';
import { splitParagraphs } from './lib/text';
import { buildBaseView, buildSideView } from './lib/viewmodel';
import { MergedPane } from './components/MergedPane';
import { SourcePane } from './components/SourcePane';

interface Docs {
  base: string;
  brand: string;
  legal: string;
}

interface WorkState {
  docs: Docs;
  resolutions: Record<string, Resolution>;
}

function initialState(): WorkState {
  const persisted = loadState();
  if (persisted) return { docs: persisted.docs, resolutions: persisted.resolutions };
  return { docs: SAMPLE_DOCS, resolutions: {} };
}

export default function App() {
  const [history, setHistory] = useState<History<WorkState>>(() => initHistory(initialState()));
  const state = history.present;

  // 本地持久化
  useEffect(() => {
    saveState(state);
  }, [state]);

  const commitState = useCallback((next: WorkState) => {
    setHistory((h) => commit(h, next));
  }, []);

  // —— 派生数据：分段 → diff → 三方合并 ——
  const paras = useMemo(
    () => ({
      base: splitParagraphs(state.docs.base),
      brand: splitParagraphs(state.docs.brand),
      legal: splitParagraphs(state.docs.legal),
    }),
    [state.docs],
  );
  const diffB = useMemo(() => diffParagraphs(paras.base, paras.brand), [paras]);
  const diffL = useMemo(() => diffParagraphs(paras.base, paras.legal), [paras]);
  const entries = useMemo(
    () => mergeDocuments(paras.base, paras.brand, paras.legal, state.resolutions),
    [paras, state.resolutions],
  );
  const summary = useMemo(() => summarize(entries), [entries]);

  const baseView = useMemo(() => buildBaseView(paras.base, diffB, diffL), [paras, diffB, diffL]);
  const brandView = useMemo(() => buildSideView(paras.brand, diffB, 'brand'), [paras, diffB]);
  const legalView = useMemo(() => buildSideView(paras.legal, diffL, 'legal'), [paras, diffL]);

  // —— 冲突导航（含已解决，便于复查） ——
  const navTargets = useMemo(
    () =>
      entries
        .filter((e) => e.kind === 'conflict' || (e.kind === 'item' && e.resolution) || (e.kind === 'deleted' && e.resolution))
        .map((e) => e.id),
    [entries],
  );
  const conflictOrder = useMemo(() => new Map(navTargets.map((id, i) => [id, i + 1])), [navTargets]);
  const [activeConflictId, setActiveConflictId] = useState<string | null>(null);

  const scrollToEntry = useCallback((id: string) => {
    document.getElementById(`entry-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const jumpConflict = useCallback(
    (direction: 1 | -1) => {
      if (navTargets.length === 0) return;
      const cur = activeConflictId ? navTargets.indexOf(activeConflictId) : -1;
      const next =
        cur === -1
          ? direction === 1
            ? 0
            : navTargets.length - 1
          : (cur + direction + navTargets.length) % navTargets.length;
      const id = navTargets[next];
      setActiveConflictId(id);
      scrollToEntry(id);
    },
    [navTargets, activeConflictId, scrollToEntry],
  );

  // —— 条目与来源段落的联动选中 ——
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );

  useEffect(() => {
    if (!selectedEntry) return;
    const refs = selectedEntry.refs;
    for (const [tone, idx] of [
      ['base', refs.base],
      ['brand', refs.brand],
      ['legal', refs.legal],
    ] as const) {
      if (idx === undefined) continue;
      document.getElementById(`src-${tone}-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedEntry]);

  // 来源段落 → 合并条目 的反向索引
  const refToEntry = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      if (e.refs.base !== undefined) map.set(`base:${e.refs.base}`, e.id);
      if (e.refs.brand !== undefined) map.set(`brand:${e.refs.brand}`, e.id);
      if (e.refs.legal !== undefined) map.set(`legal:${e.refs.legal}`, e.id);
    }
    return map;
  }, [entries]);

  const selectSourcePara = useCallback(
    (tone: 'base' | 'brand' | 'legal', index: number) => {
      const entryId = refToEntry.get(`${tone}:${index}`);
      if (entryId) {
        setSelectedEntryId(entryId);
        scrollToEntry(entryId);
      }
    },
    [refToEntry, scrollToEntry],
  );

  // —— 操作 ——
  const resolve = useCallback(
    (conflictId: string, resolution: Resolution) => {
      commitState({
        docs: state.docs,
        resolutions: { ...state.resolutions, [conflictId]: resolution },
      });
    },
    [commitState, state],
  );

  const unresolve = useCallback(
    (conflictId: string) => {
      const next = { ...state.resolutions };
      delete next[conflictId];
      commitState({ docs: state.docs, resolutions: next });
    },
    [commitState, state],
  );

  const saveDoc = useCallback(
    (which: keyof Docs, text: string) => {
      const docs = { ...state.docs, [which]: text };
      // 文档变化后，清理已不存在的冲突的解决记录
      const fresh = mergeDocuments(
        splitParagraphs(docs.base),
        splitParagraphs(docs.brand),
        splitParagraphs(docs.legal),
        {},
      );
      commitState({ docs, resolutions: sanitizeResolutions(fresh, state.resolutions) });
    },
    [commitState, state],
  );

  const resetSample = useCallback(() => {
    if (window.confirm('恢复内置示例？当前的文档修改与冲突解决记录将被清除。')) {
      commitState({ docs: SAMPLE_DOCS, resolutions: {} });
      setActiveConflictId(null);
      setSelectedEntryId(null);
    }
  }, [commitState]);

  const doUndo = useCallback(() => setHistory((h) => undo(h)), []);
  const doRedo = useCallback(() => setHistory((h) => redo(h)), []);

  // 快捷键：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z / Ctrl+Y 重做
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && e.shiftKey) {
        e.preventDefault();
        doRedo();
      } else if (key === 'z') {
        e.preventDefault();
        doUndo();
      } else if (key === 'y') {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [doUndo, doRedo]);

  // 复制最终稿
  const [copied, setCopied] = useState(false);
  const [showDeleted, setShowDeleted] = useState(true);
  const copyResult = useCallback(async () => {
    const text = finalText(entries);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [entries]);

  const activeIndex = activeConflictId ? navTargets.indexOf(activeConflictId) : -1;
  const progress = navTargets.length === 0 ? 1 : summary.resolved / navTargets.length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <h1>联合改稿工作台</h1>
          <span className="subtitle">底稿 · 品牌版 · 法务版 三方段落合并（本地自动保存）</span>
        </div>
        <div className="toolbar">
          <div className="conflict-nav" role="group" aria-label="冲突导航">
            <button type="button" className="btn btn-ghost" onClick={() => jumpConflict(-1)} disabled={navTargets.length === 0}>
              ← 上一处
            </button>
            <span className="conflict-counter" aria-live="polite">
              {navTargets.length === 0
                ? '无冲突'
                : `冲突 ${activeIndex >= 0 ? activeIndex + 1 : '–'} / ${navTargets.length}`}
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => jumpConflict(1)} disabled={navTargets.length === 0}>
              下一处 →
            </button>
          </div>

          <div className="progress-block" title={`已解决 ${summary.resolved} 处，待处理 ${summary.unresolved} 处`}>
            <span className={`status-pill ${summary.unresolved > 0 ? 'status-pending' : 'status-resolved'}`}>
              {summary.unresolved > 0 ? `待处理 ${summary.unresolved}` : '全部解决'}
            </span>
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>

          <div className="toolbar-group">
            <button type="button" className="btn btn-ghost" onClick={doUndo} disabled={!canUndo(history)} title="撤销 (Ctrl+Z)">
              ↩ 撤销
            </button>
            <button type="button" className="btn btn-ghost" onClick={doRedo} disabled={!canRedo(history)} title="重做 (Ctrl+Shift+Z)">
              ↪ 重做
            </button>
          </div>

          <div className="toolbar-group">
            <button type="button" className="btn btn-ghost" onClick={resetSample}>
              恢复示例
            </button>
            <button type="button" className="btn btn-primary" onClick={copyResult}>
              {copied ? '✓ 已复制' : '复制合并稿'}
            </button>
          </div>
        </div>
      </header>

      <div className="legend" aria-label="图例">
        <span className="legend-item"><span className="badge tone-brand"><span className="badge-icon">✎</span>品牌</span></span>
        <span className="legend-item"><span className="badge tone-legal"><span className="badge-icon">✎</span>法务</span></span>
        <span className="legend-item"><span className="badge tone-muted"><span className="badge-icon">＝</span>底稿原文</span></span>
        <span className="legend-item"><span className="badge tone-muted"><span className="badge-icon">＋</span>新增</span></span>
        <span className="legend-item"><span className="badge tone-muted"><span className="badge-icon">✕</span>删除</span></span>
        <span className="legend-item"><span className="badge tone-muted"><span className="badge-icon">⇄</span>移动</span></span>
        <span className="legend-item"><span className="badge tone-warn"><span className="badge-icon">⚠︎</span>待处理冲突</span></span>
        <span className="legend-item"><span className="badge tone-ok"><span className="badge-icon">✓</span>已解决</span></span>
        <span className="legend-item legend-diff"><del>删除内容</del> / <ins>新增内容</ins>（相对底稿）</span>
        <label className="legend-item legend-toggle">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
          />
          显示已删除段落（{summary.deleted}）
        </label>
      </div>

      <main className="board">
        <SourcePane
          title="共同底稿"
          tone="base"
          paragraphs={baseView}
          rawText={state.docs.base}
          selectedIndex={selectedEntry?.refs.base ?? null}
          onSelect={(i) => selectSourcePara('base', i)}
          onSave={(text) => saveDoc('base', text)}
        />
        <SourcePane
          title="品牌版"
          tone="brand"
          paragraphs={brandView}
          rawText={state.docs.brand}
          selectedIndex={selectedEntry?.refs.brand ?? null}
          onSelect={(i) => selectSourcePara('brand', i)}
          onSave={(text) => saveDoc('brand', text)}
        />
        <SourcePane
          title="法务版"
          tone="legal"
          paragraphs={legalView}
          rawText={state.docs.legal}
          selectedIndex={selectedEntry?.refs.legal ?? null}
          onSelect={(i) => selectSourcePara('legal', i)}
          onSave={(text) => saveDoc('legal', text)}
        />
        <MergedPane
          entries={entries}
          conflictOrder={conflictOrder}
          activeConflictId={activeConflictId}
          selectedEntryId={selectedEntryId}
          showDeleted={showDeleted}
          baseLength={paras.base.length}
          onSelect={setSelectedEntryId}
          onResolve={resolve}
          onUnresolve={unresolve}
        />
      </main>
    </div>
  );
}
