export interface Product {
  sku: string;
  name: string;
  /** Unit price. Today this is US dollars as a decimal (19.99). */
  price: number;
}
export interface LineItem {
  product: Product;
  quantity: number;
}
export interface Invoice {
  id: string;
  lines: LineItem[];
  /** Human-readable total, e.g. "$19.99". */
  total: string;
}
