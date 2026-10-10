import { describe, expect, it } from "vitest";
import { rawUrlEncode, signatureBaseString, signRequest, toQueryString } from "./oauth1.js";

describe("rawUrlEncode (PHP rawurlencode semantics)", () => {
  it("leaves unreserved characters alone", () => {
    expect(rawUrlEncode("AZaz09-_.~")).toBe("AZaz09-_.~");
  });

  it("encodes spaces as %20 (not +) and the characters encodeURIComponent misses", () => {
    expect(rawUrlEncode("a b")).toBe("a%20b");
    expect(rawUrlEncode("!'()*")).toBe("%21%27%28%29%2A");
    expect(rawUrlEncode("&=/:?")).toBe("%26%3D%2F%3A%3F");
  });
});

describe("signatureBaseString (WooCommerce variant)", () => {
  it("sorts keys and encodes values once, joined by %3D / %26", () => {
    const base = signatureBaseString("get", "http://store.local.test/wp-json/wc/v3/products", {
      search: "mug & tee",
      per_page: "20",
      oauth_nonce: "n",
    });
    expect(base).toBe(
      "GET&http%3A%2F%2Fstore.local.test%2Fwp-json%2Fwc%2Fv3%2Fproducts&" +
        "oauth_nonce%3Dn%26per_page%3D20%26search%3Dmug%20%26%20tee",
    );
  });
});

describe("signRequest", () => {
  // Reference signature computed independently:
  //   printf '%s' '<base string>' | openssl dgst -sha256 -hmac 'cs_test&' -binary | base64
  it("matches a fixed HMAC-SHA256 vector", () => {
    const signed = signRequest({
      method: "GET",
      signingUrl: "http://store.local.test/wp-json/wc/v3/products",
      params: { search: "mug & tee", per_page: "20" },
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      nonce: "abc123",
      timestamp: 1700000000,
    });
    expect(signed).toMatchObject({
      search: "mug & tee",
      per_page: "20",
      oauth_consumer_key: "ck_test",
      oauth_nonce: "abc123",
      oauth_signature_method: "HMAC-SHA256",
      oauth_timestamp: "1700000000",
      oauth_signature: "ZkelBMOYTUeDR/7iGtwHYXrk9JoThNBRlPPQaXJsv0U=",
    });
  });

  it("uses a fresh nonce and the current time by default", () => {
    const opts = {
      method: "GET",
      signingUrl: "http://x/wp-json/wc/v3/orders",
      params: {},
      consumerKey: "ck_a",
      consumerSecret: "cs_a",
    };
    const a = signRequest(opts);
    const b = signRequest(opts);
    expect(a.oauth_nonce).not.toBe(b.oauth_nonce);
    expect(Math.abs(Number(a.oauth_timestamp) - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe("toQueryString", () => {
  it("encodes the signature's base64 characters", () => {
    expect(toQueryString({ oauth_signature: "a+b/c=" })).toBe("oauth_signature=a%2Bb%2Fc%3D");
  });
});
