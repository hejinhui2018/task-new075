import type { ParaBadge } from '../lib/viewmodel';

/** 状态徽标：图标 + 文字，不依赖颜色也能读懂。 */
export function Badge({ badge }: { badge: ParaBadge }) {
  return (
    <span className={`badge tone-${badge.tone}`}>
      <span className="badge-icon" aria-hidden="true">{badge.icon}</span>
      <span>{badge.label}</span>
    </span>
  );
}

export function BadgeRow({ badges }: { badges: ParaBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <div className="badge-row">
      {badges.map((b, i) => (
        <Badge key={`${b.label}-${i}`} badge={b} />
      ))}
    </div>
  );
}
