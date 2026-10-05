import { test, expect } from "bun:test";
import { normalizeKofi, parseKofiBody, type KofiPayload } from "./normalize.ts";

/** The official example payload from the Ko-fi help article, verbatim. */
const donation: KofiPayload = {
  verification_token: "e58df006-d830-4114-96e9-6bbbfcb2b776",
  message_id: "2defe7b3-a0a9-4495-991c-ad08cd0dc51d",
  timestamp: "2024-01-25T15:22:49Z",
  type: "Donation",
  is_public: true,
  from_name: "Jo Example",
  message: "Good luck with the integration!",
  amount: "3.00",
  url: "https://ko-fi.com/Home/CoffeeShop?txid=00000000-1111-2222-3333-444444444444",
  email: "jo.example@example.com",
  currency: "USD",
  is_subscription_payment: false,
  is_first_subscription_payment: false,
  kofi_transaction_id: "00000000-1111-2222-3333-444444444444",
  shop_items: null,
  tier_name: null,
  shipping: null,
};

test("normalizeKofi: Donation 3.00 is_public → tip 300 from Jo Example, sourceId kofi:<message_id>", () => {
  expect(normalizeKofi(donation)).toEqual({
    source: "kofi",
    sourceId: "kofi:2defe7b3-a0a9-4495-991c-ad08cd0dc51d",
    face: { kind: "tip", cents: 300 },
    displayName: "Jo Example",
    anonymous: false,
    message: "Good luck with the integration!",
    occurredAt: "2024-01-25T15:22:49Z",
    currency: "USD",
  });
});

test("normalizeKofi: is_public false → displayName null, anonymous true", () => {
  const got = normalizeKofi({ ...donation, is_public: false, message: null })!;
  expect(got.displayName).toBeNull();
  expect(got.anonymous).toBe(true);
  expect("message" in got).toBe(false);
  expect(JSON.stringify(got)).not.toContain("jo.example@example.com"); // the email never reaches the Ledger
});

test("normalizeKofi: Subscription payments credit as tips; amounts are exact cents, never floats", () => {
  const sub = normalizeKofi({ ...donation, type: "Subscription", is_subscription_payment: true, is_first_subscription_payment: true, tier_name: "Gold", amount: "4.35", currency: "EUR" })!;
  expect(sub.face).toEqual({ kind: "tip", cents: 435 });
  expect(sub.currency).toBe("EUR");
  expect(normalizeKofi({ ...donation, amount: "10" })!.face).toEqual({ kind: "tip", cents: 1000 });
});

test("normalizeKofi: Shop Order and Commission → null (stored raw, never credited)", () => {
  expect(normalizeKofi({ ...donation, type: "Shop Order", shop_items: [{ direct_link_code: "abc", variation_name: "L", quantity: 1 }], shipping: null })).toBeNull();
  expect(normalizeKofi({ ...donation, type: "Commission" })).toBeNull();
});

test("parseKofiBody: form-encoded data=<json> parses; a real payload round-trips", () => {
  expect(parseKofiBody("data=%7B%22amount%22%3A%223.00%22%7D")).toEqual({ data: { amount: "3.00" } as KofiPayload }); // a fragment, typed as the payload it is a slice of
  const body = new URLSearchParams({ data: JSON.stringify(donation) }).toString();
  expect(parseKofiBody(body)).toEqual({ data: donation });
});

test("parseKofiBody: a body without a data field throws", () => {
  expect(() => parseKofiBody("foo=bar")).toThrow(/data/);
});

test("Avatar Picture source: Ko-fi never carries a Twitch id or a login hint — the payload has no identity beyond the free-text name", () => {
  const got = normalizeKofi({ ...donation, from_name: "cool_user" })!; // even a login-shaped name is not a Twitch login on Ko-fi
  expect("twitchUserId" in got).toBe(false);
  expect("loginHint" in got).toBe(false);
});
