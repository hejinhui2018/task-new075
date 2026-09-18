import { useState } from 'react';
import type { SourcePara, Tone } from '../lib/viewmodel';
import { BadgeRow } from './Badge';

interface SourcePaneProps {
  title: string;
  tone: Tone;
  paragraphs: SourcePara[];
  /** 当前联动选中的段落下标（无则为 null）。 */
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** 保存编辑后的全文；不传则只读。 */
  onSave?: (text: string) => void;
  rawText: string;
}

/** 三个来源栏（底稿 / 品牌版 / 法务版）。 */
export function SourcePane({ title, tone, paragraphs, selectedIndex, onSelect, onSave, rawText }: SourcePaneProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEdit = () => {
    setDraft(rawText);
    setEditing(true);
  };
  const cancelEdit = () => setEditing(false);
  const saveEdit = () => {
    onSave?.(draft);
    setEditing(false);
  };

  return (
    <section className={`pane pane-${tone}`} aria-label={title}>
      <header className="pane-header">
        <div className="pane-title">
          <span className={`pane-dot tone-bg-${tone}`} aria-hidden="true" />
          <h2>{title}</h2>
          <span className="pane-count">{paragraphs.length} 段</span>
        </div>
        {onSave && !editing && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={startEdit}>
            编辑
          </button>
        )}
        {editing && (
          <div className="pane-header-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={saveEdit}>
              保存
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelEdit}>
              取消
            </button>
          </div>
        )}
      </header>

      {editing ? (
        <div className="pane-edit">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`${title}全文编辑`}
            spellCheck={false}
          />
          <p className="pane-edit-hint">用空行分隔段落；保存后自动重新合并。</p>
        </div>
      ) : (
        <ol className="para-list">
          {paragraphs.map((p) => (
            <li key={p.index}>
              <button
                type="button"
                id={`src-${tone}-${p.index}`}
                className={`para-card${selectedIndex === p.index ? ' selected' : ''}`}
                onClick={() => onSelect(p.index)}
              >
                <div className="para-card-head">
                  <span className="para-no">§{p.index + 1}</span>
                  <BadgeRow badges={p.badges} />
                </div>
                <p className="para-text">{p.text}</p>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
