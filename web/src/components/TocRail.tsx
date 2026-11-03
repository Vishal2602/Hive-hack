// React wrapper for the vendored <table-of-content> web component (src/vendor/toc, MIT).
// The element selects on hover and keyboard (toc-change). This wrapper adds a separate
// "commit" for click, tap, Enter and Space, so hovering never navigates on its own.
import '@/vendor/toc/table-of-content-model.js';
import '@/vendor/toc/table-of-content.js';
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type DetailedHTMLProps, type HTMLAttributes } from 'react';
import type { TableOfContentElement, TableOfContentItem } from '@/vendor/toc/table-of-content.js';
import styles from './TocRail.module.css';

export type TocItem = TableOfContentItem;

// `value` is deliberately not a JSX prop: React 19 would set the property, which emits toc-change.
type TocElementProps = DetailedHTMLProps<HTMLAttributes<TableOfContentElement>, TableOfContentElement> & {
  label?: string;
  open?: boolean;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'table-of-content': TocElementProps;
    }
  }
}

export interface TocRailProps {
  /** 1 to 200 items. Titles and descriptions are rendered as text by the element. */
  items: TocItem[];
  /** Selected index (controlled). */
  value: number;
  /** Accessible name of the slider. */
  label: string;
  /** Fires while scrubbing with pointer or arrow keys. Use for previews, not navigation. */
  onChange?: (index: number, item: TocItem) => void;
  /** Fires on click, tap, Enter or Space. Use for navigation. */
  onCommit?: (index: number, item: TocItem) => void;
  /** Preview card opened or closed. */
  onOpenChange?: (open: boolean, index: number) => void;
  /** Pin the preview card open. */
  open?: boolean;
  /** Rail and card area. Defaults to 20rem wide; the element is always 35.5rem tall. */
  style?: CSSProperties;
  className?: string;
}

/**
 * The element is 35.5rem tall with a 4.25rem rail on its inline start; the preview card floats
 * to the right of the rail. Only the rail takes pointer events, so content under the card stays usable.
 */
export function TocRail({ items, value, label, onChange, onCommit, onOpenChange, open = false, style, className }: TocRailProps) {
  const ref = useRef<TableOfContentElement>(null);
  const latest = useRef({ items, value, onChange, onCommit, onOpenChange });
  useLayoutEffect(() => { latest.current = { items, value, onChange, onCommit, onOpenChange }; });

  // Items: assign as a property (the element copies them as text).
  useEffect(() => {
    const el = ref.current;
    if (el && items.length) el.items = items;
  }, [items]);

  // Controlled value: the attribute path selects without emitting toc-change.
  useEffect(() => {
    const el = ref.current;
    if (el && el.value !== value) el.setAttribute('value', String(value));
  }, [value, items]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const itemAt = (index: number) => latest.current.items[index];
    const change = (event: CustomEvent<{ index: number }>) => {
      const item = itemAt(event.detail.index);
      if (item) latest.current.onChange?.(event.detail.index, item);
    };
    const openEvt = (event: CustomEvent<{ index: number }>) => latest.current.onOpenChange?.(true, event.detail.index);
    const closeEvt = (event: CustomEvent<{ index: number }>) => {
      latest.current.onOpenChange?.(false, event.detail.index);
      // Scrubbing without committing returns the rail to the controlled value.
      if (el.value !== latest.current.value) el.setAttribute('value', String(latest.current.value));
    };
    const commit = () => {
      const index = el.value;
      const item = itemAt(index);
      if (item) latest.current.onCommit?.(index, item);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        commit();
      }
    };
    el.addEventListener('toc-change', change);
    el.addEventListener('toc-open', openEvt);
    el.addEventListener('toc-close', closeEvt);
    el.addEventListener('click', commit);
    el.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('toc-change', change);
      el.removeEventListener('toc-open', openEvt);
      el.removeEventListener('toc-close', closeEvt);
      el.removeEventListener('click', commit);
      el.removeEventListener('keydown', key);
    };
  }, []);

  return (
    <table-of-content
      ref={ref}
      label={label}
      open={open || undefined}
      className={[styles.rail, className].filter(Boolean).join(' ')}
      style={style}
    />
  );
}

export default TocRail;
