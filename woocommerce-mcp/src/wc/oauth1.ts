import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a "one-legged" request signing, exactly as WooCommerce verifies it.
 *
 * Why this exists: WooCommerce only accepts consumer key/secret as plain
 * Basic auth over HTTPS. Our MCP server talks to WordPress over plain HTTP
 * inside the cluster, where WooCommerce requires an OAuth 1.0a signature.
 *
 * WooCommerce's verifier (WC_REST_Authentication::check_oauth_signature)
 * differs from RFC 5849 in one way that matters: parameter keys and values
 * are percent-encoded once and joined with already-encoded "%3D"/"%26",
 * instead of the RFC's encode-then-encode-the-whole-string. We mirror the
 * WooCommerce version, since that's what has to match.
 */

/** PHP's rawurlencode: RFC 3986, everything but A-Z a-z 0-9 - _ . ~ encoded. */
export function rawUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignInput {
  method: string;
  /** Path + public home URL as WooCommerce sees it, e.g. http://store.local.test/wp-json/wc/v3/orders */
  signingUrl: string;
  /** Query params that will be sent (not including oauth_*). */
  params: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  /** Injectable for deterministic tests. */
  nonce?: string;
  timestamp?: number;
}

export function signatureBaseString(
  method: string,
  signingUrl: string,
  params: Record<string, string>,
): string {
  // uksort($params, 'strcmp') - byte-wise sort on the raw keys.
  const keys = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const query = keys.map((k) => `${rawUrlEncode(k)}%3D${rawUrlEncode(params[k]!)}`).join("%26");
  return `${method.toUpperCase()}&${rawUrlEncode(signingUrl)}&${query}`;
}

/** Returns the full set of query params to send: the caller's params plus oauth_*. */
export function signRequest(input: SignInput): Record<string, string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  const all = { ...input.params, ...oauth };
  const base = signatureBaseString(input.method, input.signingUrl, all);
  const signature = createHmac("sha256", `${input.consumerSecret}&`).update(base).digest("base64");
  return { ...all, oauth_signature: signature };
}

/** Serialises params into a query string with the same encoding the signature used. */
export function toQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${rawUrlEncode(k)}=${rawUrlEncode(v)}`)
    .join("&");
}
