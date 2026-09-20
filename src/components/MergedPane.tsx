import type { DeletedItem, MergeEntry, MergedItem, Resolution } from '../lib/merge';
import { anchorLabel, originBadges, refsLabel, resolutionLabel } from '../lib/viewmodel';
import { BadgeRow } from './Badge';
import { ConflictCard } from './ConflictCard';
import { DiffText } from './DiffText';

interface MergedPaneProps {
  entries: MergeEntry[];
  /** 冲突 id → 序号（1 起），含已解决的。 */
  conflictOrder: Map<string, number>;
  activeConflictId: string | null;
  selectedEntryId: string | null;
  showDeleted: boolean;
  baseLength: number;
  /** 当前选中事实问题涉及的条目（四栏联动高亮）。 */
  factLinkedIds?: Set<string>;
  /** 条目 id → 待处理事实问题数。 */
  entryIssueCount?: Map<string, number>;
  onSelect: (entryId: string) => void;
  onResolve: (conflictId: string, resolution: Resolution) => void;
  onUnresolve: (conflictId: string) => void;
}

/** 合并结果栏。 */
export function MergedPane(props: MergedPaneProps) {
  const { entries, showDeleted } = props;
  return (
    <section className="pane pane-merged" aria-label="合并结果">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-dot tone-bg-merged" aria-hidden="true" />
          <h2>合并结果</h2>
          <span className="pane-count">{entries.length} 条</span>
        </div>
      </header>
      <div className="entry-list">
        {entries.map((entry) => {
          if (entry.kind === 'deleted' && !showDeleted) return null;
          return <EntryCard key={entry.id} entry={entry} {...props} />;
        })}
      </div>
    </section>
  );
}

function EntryCard(props: MergedPaneProps & { entry: MergeEntry }) {
  const { entry, conflictOrder, activeConflictId, selectedEntryId, onSelect, onResolve, onUnresolve, baseLength, factLinkedIds, entryIssueCount } = props;
  const selected = selectedEntryId === entry.id;
  const factLinked = factLinkedIds?.has(entry.id) ?? false;
  const issueCount = entryIssueCount?.get(entry.id) ?? 0;
  const factNote = issueCount > 0 ? `⚖ 事实冲突 ${issueCount}` : undefined;

  if (entry.kind === 'conflict') {
    return (
      <ConflictCard
        conflict={entry}
        order={conflictOrder.get(entry.id) ?? 0}
        active={activeConflictId === entry.id}
        selected={selected}
        factLinked={factLinked}
        factNote={factNote}
        onSelect={() => onSelect(entry.id)}
        onResolve={(res) => onResolve(entry.id, res)}
      />
    );
  }

  if (entry.kind === 'deleted') {
    return <DeletedCard entry={entry} selected={selected} factLinked={factLinked} factNote={factNote} onSelect={() => onSelect(entry.id)} onUnresolve={onUnresolve} />;
  }

  return (
    <ItemCard
      item={entry}
      order={entry.resolution ? conflictOrder.get(entry.id) : undefined}
      active={activeConflictId === entry.id}
      selected={selected}
      factLinked={factLinked}
      factNote={factNote}
      baseLength={baseLength}
      onSelect={() => onSelect(entry.id)}
      onUnresolve={onUnresolve}
    />
  );
}

function ItemCard({
  item,
  order,
  active,
  selected,
  factLinked,
  factNote,
  baseLength,
  onSelect,
  onUnresolve,
}: {
  item: MergedItem;
  order?: number;
  active: boolean;
  selected: boolean;
  factLinked: boolean;
  factNote?: string;
  baseLength: number;
  onSelect: () => void;
  onUnresolve: (id: string) => void;
}) {
  const resolved = item.origin.kind === 'resolved';
  const classes = [
    'entry-card',
    resolved ? 'resolved-card' : '',
    active ? 'nav-active' : '',
    selected ? 'selected' : '',
    factLinked ? 'fact-linked' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const showDiff = item.baseText !== undefined && item.baseText !== item.text;

  return (
    <article className={classes} id={`entry-${item.id}`} onClick={onSelect}>
      <header className="entry-head">
        {resolved ? (
          <>
            <span className="resolve-flag" aria-label="已解决">✓</span>
            <strong>
              已解决{order !== undefined ? ` · 冲突 #${order}` : ''} · {resolutionLabel(item.origin.kind === 'resolved' ? item.origin.choice : 'base')}
            </strong>
            <span className="status-pill status-resolved">已解决</span>
          </>
        ) : (
          <BadgeRow badges={originBadges(item.origin)} />
        )}
        {item.move && (
          <span className="move-note">
            ⇄ 自底稿第 {item.move.fromBase + 1} 段移至{anchorLabel(item.move.anchor, baseLength)}
          </span>
        )}
        {factNote && <span className="fact-note">{factNote}</span>}
        {resolved && (
          <button
            type="button"
            className="btn btn-ghost btn-sm head-action"
            onClick={(e) => {
              e.stopPropagation();
              onUnresolve(item.id);
            }}
          >
            重新处理
          </button>
        )}
      </header>
      {showDiff && item.baseText !== undefined ? (
        <DiffText oldText={item.baseText} newText={item.text} />
      ) : (
        <p className="para-text">{item.text}</p>
      )}
      <footer className="entry-refs">{refsLabel(item.refs)}</footer>
    </article>
  );
}

function DeletedCard({
  entry,
  selected,
  factLinked,
  factNote,
  onSelect,
  onUnresolve,
}: {
  entry: DeletedItem;
  selected: boolean;
  factLinked: boolean;
  factNote?: string;
  onSelect: () => void;
  onUnresolve: (id: string) => void;
}) {
  const byLabel = entry.by === 'both' ? '双方' : entry.by === 'brand' ? '品牌' : '法务';
  return (
    <article
      className={`entry-card deleted-card${selected ? ' selected' : ''}${factLinked ? ' fact-linked' : ''}`}
      id={`entry-${entry.id}`}
      onClick={onSelect}
    >
      <header className="entry-head">
        <span className="delete-flag" aria-label="已删除">✕</span>
        <strong>{byLabel}删除{entry.resolution ? '（经人工确认）' : ''}</strong>
        {factNote && <span className="fact-note">{factNote}</span>}
        {entry.resolution && (
          <button
            type="button"
            className="btn btn-ghost btn-sm head-action"
            onClick={(e) => {
              e.stopPropagation();
              onUnresolve(entry.id);
            }}
          >
            重新处理
          </button>
        )}
      </header>
      <p className="para-text deleted-text">{entry.text}</p>
      <footer className="entry-refs">{refsLabel(entry.refs)}</footer>
    </article>
  );
}
