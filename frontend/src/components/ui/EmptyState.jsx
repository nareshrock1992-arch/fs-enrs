/**
 * EmptyState — Professional no-data placeholder.
 */
export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="empty-state">
      {Icon && (
        <div className="empty-state-icon">
          <Icon size={24} strokeWidth={1.5} />
        </div>
      )}
      <div>
        <p className="empty-state-title">{title}</p>
        {description && <p className="empty-state-desc">{description}</p>}
      </div>
      {action}
    </div>
  );
}
