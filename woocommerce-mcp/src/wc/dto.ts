/**
 * WooCommerce returns very large objects (dozens of fields, links, meta).
 * Tools return these compact shapes instead: everything an LLM or a person
 * needs to answer questions about products and orders, at a fraction of the
 * tokens.
 */

export interface WcProduct {
  id: number;
  name: string;
  sku: string;
  status: string;
  price: string;
  regular_price: string;
  stock_status: string;
  stock_quantity: number | null;
  permalink: string;
  date_created: string;
}

export interface WcOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  payment_method_title: string;
  date_created: string;
  billing: { first_name: string; last_name: string; email: string };
  line_items: { product_id: number; name: string; quantity: number; total: string }[];
  customer_note: string;
}

export function toProduct(p: WcProduct) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku || null,
    status: p.status,
    price: p.price,
    regular_price: p.regular_price,
    stock_status: p.stock_status,
    stock_quantity: p.stock_quantity,
    url: p.permalink,
    created_at: p.date_created,
  };
}

export function toOrder(o: WcOrder) {
  const name = `${o.billing.first_name} ${o.billing.last_name}`.trim();
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    total: o.total,
    currency: o.currency,
    payment_method: o.payment_method_title,
    created_at: o.date_created,
    customer: { name: name || null, email: o.billing.email || null },
    items: o.line_items.map((li) => ({
      product_id: li.product_id,
      name: li.name,
      quantity: li.quantity,
      total: li.total,
    })),
    note: o.customer_note || null,
  };
}
