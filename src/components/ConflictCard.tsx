import { useState } from 'react';
import type { ConflictItem, Resolution } from '../lib/merge';
import { conflictTypeLabel } from '../lib/viewmodel';
import { DiffText } from './DiffText';

interface ConflictCardProps {
  conflict: ConflictItem;
  /** 冲突在全部冲突中的序号（1 起）。 */
  order: number;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  onResolve: (resolution: Resolution) => void;
}

/** 待处理冲突卡片：并列展示各方版本，提供四种解决方式。 */
export function ConflictCard({ conflict, order, active, selected, onSelect, onResolve }: ConflictCardProps) {
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState('');

  const openManual = () => {
    setDraft(conflict.brandText ?? conflict.legalText ?? conflict.baseText);
    setManual(true);
  };

  const classes = [
    'entry-card',
    'conflict-card',
    active ? 'nav-active' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={classes}
      id={`entry-${conflict.id}`}
      onClick={onSelect}
      aria-label={`冲突 ${order}`}
    >
      <header className="entry-head">
        <span className="conflict-flag" role="img" aria-label="待处理冲突">
          ⚠︎
        </span>
        <strong>冲突 #{order} · {conflictTypeLabel(conflict.type)}</strong>
        <span className="status-pill status-pending">待处理</span>
        {conflict.move && (
          <span className="move-note">
            ⇄ 涉及段落移动（底稿第 {conflict.move.fromBase + 1} 段）
          </span>
        )}
      </header>

      <div className="candidate candidate-base">
        <div className="candidate-label">底稿原文 §{conflict.baseIndex + 1}</div>
        <p className="para-text muted-text">{conflict.baseText}</p>
      </div>

      {conflict.brandText !== undefined ? (
        <div className="candidate">
          <div className="candidate-label">
            <span className="pane-dot tone-bg-brand" aria-hidden="true" />
            品牌版 §{(conflict.refs.brand ?? 0) + 1}（相对底稿的改动如下）
          </div>
          <DiffText oldText={conflict.baseText} newText={conflict.brandText} />
        </div>
      ) : (
        <div className="candidate candidate-deleted">
          <div className="candidate-label">
            <span className="pane-dot tone-bg-brand" aria-hidden="true" />
            品牌版：✕ 删除了这一段
          </div>
        </div>
      )}

      {conflict.legalText !== undefined ? (
        <div className="candidate">
          <div className="candidate-label">
            <span className="pane-dot tone-bg-legal" aria-hidden="true" />
            法务版 §{(conflict.refs.legal ?? 0) + 1}（相对底稿的改动如下）
          </div>
          <DiffText oldText={conflict.baseText} newText={conflict.legalText} />
        </div>
      ) : (
        <div className="candidate candidate-deleted">
          <div className="candidate-label">
            <span className="pane-dot tone-bg-legal" aria-hidden="true" />
            法务版：✕ 删除了这一段
          </div>
        </div>
      )}

      <div className="resolve-actions" onClick={(e) => e.stopPropagation()}>
        {conflict.brandText !== undefined && (
          <button type="button" className="btn btn-brand" onClick={() => onResolve({ choice: 'brand' })}>
            采用品牌版
          </button>
        )}
        {conflict.brandText === undefined && (
          <button type="button" className="btn btn-brand" onClick={() => onResolve({ choice: 'brand' })}>
            采用品牌版（删除此段）
          </button>
        )}
        {conflict.legalText !== undefined && (
          <button type="button" className="btn btn-legal" onClick={() => onResolve({ choice: 'legal' })}>
            采用法务版
          </button>
        )}
        {conflict.legalText === undefined && (
          <button type="button" className="btn btn-legal" onClick={() => onResolve({ choice: 'legal' })}>
            采用法务版（删除此段）
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => onResolve({ choice: 'base' })}>
          采用底稿原文
        </button>
        <button type="button" className="btn btn-ghost" onClick={openManual}>
          手动填写…
        </button>
      </div>

      {manual && (
        <div className="manual-editor" onClick={(e) => e.stopPropagation()}>
          <label htmlFor={`manual-${conflict.id}`}>手动填写最终文本：</label>
          <textarea
            id={`manual-${conflict.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            spellCheck={false}
          />
          <div className="resolve-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={draft.trim().length === 0}
              onClick={() => onResolve({ choice: 'custom', text: draft.trim() })}
            >
              保存为最终结果
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setManual(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
