// Standard screen layout: heading, optional description and actions, connection notice, content.
import { useEffect, type ReactNode } from 'react';
import { ConnectionNotice } from './StateNotices';
import styles from './Page.module.css';

export interface PageProps {
  /** Screen heading (h1). Also sets the document title. Sentence case. */
  title: string;
  /** One sentence under the heading. */
  description?: ReactNode;
  /** Buttons aligned to the heading. One primary action at most. */
  actions?: ReactNode;
  /** Content between the heading and the body, such as a back link or breadcrumb. */
  before?: ReactNode;
  /** Show the offline or stale notice. Default true. */
  notices?: boolean;
  /** "default" caps content at 72rem; "narrow" at 44rem for forms and sign-in style flows. */
  width?: 'default' | 'narrow';
  children?: ReactNode;
}

export function Page({ title, description, actions, before, notices = true, width = 'default', children }: PageProps) {
  useEffect(() => {
    document.title = `${title} · Hive`;
  }, [title]);

  return (
    <div className={[styles.page, width === 'narrow' ? styles.narrow : ''].join(' ')}>
      {before && <div className={styles.before}>{before}</div>}
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      {notices && (
        <div className={styles.notices}>
          <ConnectionNotice />
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </div>
  );
}
