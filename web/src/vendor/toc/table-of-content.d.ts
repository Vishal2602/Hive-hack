// Local typings for the vendored <table-of-content> element (adapted from upstream index.d.ts, MIT).
// Side-effect module: registers the custom element and sets globalThis.TableOfContent.
export interface TableOfContentItem { id: string; title: string; description: string }
export interface TableOfContentItemInput { id?: string; title?: string; description?: string }
export interface TableOfContentSelectOptions { open?: boolean; emit?: boolean }
export interface TableOfContentChangeDetail { index: number; item: TableOfContentItem }
export interface TableOfContentIndexDetail { index: number }

export interface TableOfContentElement extends HTMLElement {
  get items(): TableOfContentItem[];
  set items(value: readonly TableOfContentItemInput[]);
  value: number;
  open: boolean;
  label: string;
  select(index: number, options?: TableOfContentSelectOptions): void;
  close(): void;
}

declare global {
  interface HTMLElementTagNameMap { 'table-of-content': TableOfContentElement }
  interface HTMLElementEventMap {
    'toc-change': CustomEvent<TableOfContentChangeDetail>;
    'toc-open': CustomEvent<TableOfContentIndexDetail>;
    'toc-close': CustomEvent<TableOfContentIndexDetail>;
  }
}
