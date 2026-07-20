/**
 * PageHeader — Standard enterprise page header.
 *
 * Usage:
 *   <PageHeader
 *     title="ERS Reports"
 *     description="Emergency Response System incident history"
 *     badge={{ label: '42 incidents', variant: 'info' }}
 *   >
 *     <button className="btn-primary">Export</button>
 *   </PageHeader>
 */

import Badge from './Badge.jsx';

export default function PageHeader({ title, description, badge, icon: Icon, children }) {
  return (
    <div className="page-header">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          {Icon && (
            <div className="w-8 h-8 rounded-lg bg-brand/10 border border-brand/20
                            flex items-center justify-center text-brand shrink-0">
              <Icon size={16} />
            </div>
          )}
          <h1 className="page-title">{title}</h1>
          {badge && (
            <Badge variant={badge.variant || 'default'}>{badge.label}</Badge>
          )}
        </div>
        {description && (
          <p className="page-description">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-2 flex-wrap shrink-0 mt-1 sm:mt-0">
          {children}
        </div>
      )}
    </div>
  );
}
