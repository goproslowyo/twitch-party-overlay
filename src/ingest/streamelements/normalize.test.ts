import { test, expect } from "bun:test";
import { normalizeSeTip, normalizeSeRestTip, type SeSocketEvent, type SeRestTipDoc } from "./normalize.ts";

/** Realtime envelope per StreamElements' official Websockets.md schema; `amount` can be decimal despite the schema's integer. */
function socketTip(overrides: Partial<SeSocketEvent["data"]> = {}, type = "tip"): SeSocketEvent {
  return {
    _id: "68c4a1b2c3d4e5f6a7b8c9d0",
    channel: "5e9e1f2a3b4c5d6e7f8a9b0c",
    type,
    provider: "twitch",
    data: {
      tipId: "68c4a1b2c3d4e5f6a7b8c9d1",
      username: "cool_user",
      displayName: "Cool_User",
      amount: 12.5,
      currency: "USD",
      message: "great set",
      avatar: "https://cdn.streamelements.com/static/default-avatar.png",
      ...overrides,
    },
    createdAt: "2026-09-12T20:31:12.000Z",
    updatedAt: "2026-09-12T20:31:12.000Z",
  };
}

test("normalizeSeTip: socket tip amount 12.5 → 1250 cents, sourceId se:<tipId>, username as the name", () => {
  expect(normalizeSeTip(socketTip())).toEqual({
    source: "streamelements",
    sourceId: "se:68c4a1b2c3d4e5f6a7b8c9d1",
    face: { kind: "tip", cents: 1250 },
    displayName: "cool_user",
    anonymous: false,
    loginHint: "cool_user",
    message: "great set",
    occurredAt: "2026-09-12T20:31:12.000Z",
    currency: "USD",
  });
});

test("normalizeSeTip: integer and float-noisy amounts round to whole cents", () => {
  expect(normalizeSeTip(socketTip({ amount: 100 }))!.face).toEqual({ kind: "tip", cents: 10000 });
  expect(normalizeSeTip(socketTip({ amount: 4.35 }))!.face).toEqual({ kind: "tip", cents: 435 });
  expect(normalizeSeTip(socketTip({ amount: 0.29 }))!.face).toEqual({ kind: "tip", cents: 29 });
});

test("normalizeSeTip: dedupe key is the tip id (data.tipId); the envelope _id is the fallback only when tipId is absent", () => {
  expect(normalizeSeTip(socketTip())!.sourceId).toBe("se:68c4a1b2c3d4e5f6a7b8c9d1");
  expect(normalizeSeTip(socketTip({ tipId: undefined }))!.sourceId).toBe("se:68c4a1b2c3d4e5f6a7b8c9d0");
});

test("normalizeSeTip: null unless type === 'tip'; optional fields stay absent", () => {
  expect(normalizeSeTip(socketTip({}, "follow"))).toBeNull();
  expect(normalizeSeTip(socketTip({}, "cheer"))).toBeNull();
  const bare = normalizeSeTip(socketTip({ message: undefined, currency: undefined, displayName: undefined }))!;
  expect("message" in bare).toBe(false);
  expect("currency" in bare).toBe(false);
});

/** REST `/kappa/v2/tips/{channelId}` doc per StreamElements' api.yaml; the payment rail only shows up here as `provider`. */
function restDoc(overrides: Partial<SeRestTipDoc> = {}): SeRestTipDoc {
  return {
    _id: "68c4a1b2c3d4e5f6a7b8c9d1",
    channel: "5e9e1f2a3b4c5d6e7f8a9b0c",
    provider: "paypal",
    status: "success",
    approved: "allowed",
    deleted: false,
    transactionId: "PAYID-000",
    donation: { user: { username: "cool_user", email: "cool@example.com" }, message: "great set", amount: 12.5, currency: "USD" },
    createdAt: "2026-09-12T20:31:12.000Z",
    updatedAt: "2026-09-12T20:31:12.000Z",
    ...overrides,
  };
}

test("normalizeSeRestTip: approved 'allowed' → contribution, denied false; the email never leaks", () => {
  const { contribution, denied } = normalizeSeRestTip(restDoc());
  expect(denied).toBe(false);
  expect(contribution).toEqual({
    source: "streamelements",
    sourceId: "se:68c4a1b2c3d4e5f6a7b8c9d1",
    face: { kind: "tip", cents: 1250 },
    displayName: "cool_user",
    anonymous: false,
    loginHint: "cool_user",
    message: "great set",
    occurredAt: "2026-09-12T20:31:12.000Z",
    currency: "USD",
  });
  expect(JSON.stringify(contribution)).not.toContain("cool@example.com");
});

test("socket credit and REST backfill of the same tip share one sourceId, so the ledger dedupes them against each other", () => {
  expect(normalizeSeTip(socketTip())!.sourceId).toBe(normalizeSeRestTip(restDoc()).contribution.sourceId);
});

test("normalizeSeRestTip: approved 'denied' or deleted true → denied true", () => {
  expect(normalizeSeRestTip(restDoc({ approved: "denied" })).denied).toBe(true);
  expect(normalizeSeRestTip(restDoc({ deleted: true })).denied).toBe(true);
  expect(normalizeSeRestTip(restDoc({ approved: "pending" })).denied).toBe(false);
});

test("Avatar Picture source: providerId is the Twitch id; without it a login-shaped username is a login hint; a free-text name gives neither", () => {
  const withId = normalizeSeTip(socketTip({ providerId: "42", username: "Styler" } as Partial<SeSocketEvent["data"]>))!;
  expect(withId.twitchUserId).toBe("42");
  expect("loginHint" in withId).toBe(false);

  const styler = normalizeSeTip(socketTip({ username: "Styler" }))!;
  expect("twitchUserId" in styler).toBe(false);
  expect(styler.loginHint).toBe("styler"); // Helix logins are lower-case
  expect(styler.displayName).toBe("Styler"); // the name on screen keeps its case

  const emma = normalizeSeTip(socketTip({ username: "Emma O'Connell PhD" }))!;
  expect("twitchUserId" in emma).toBe(false);
  expect("loginHint" in emma).toBe(false);
  expect(emma.displayName).toBe("Emma O'Connell PhD");

  for (const bad of ["abc", "1abc", "_abc", "a".repeat(17), "cool-user", "cool.user", ""]) expect("loginHint" in normalizeSeTip(socketTip({ username: bad }))!).toBe(false);
  expect(normalizeSeTip(socketTip({ username: "a".repeat(16) }))!.loginHint).toBe("a".repeat(16)); // 4–16 characters: SE's own username pattern

  const rest = normalizeSeRestTip(restDoc({ donation: { user: { username: "Emma O'Connell PhD" }, amount: 1 } }));
  expect("loginHint" in rest.contribution).toBe(false);
  expect(normalizeSeRestTip(restDoc()).contribution.loginHint).toBe("cool_user");
});

test("providerId is a Twitch id only when the socket envelope says provider twitch (or says nothing): a youtube envelope's providerId is not one, and the login-shaped username still hints", () => {
  const yt = { ...socketTip({ providerId: "UCabc123", username: "cool_user" } as Partial<SeSocketEvent["data"]>), provider: "youtube" };
  const c = normalizeSeTip(yt)!;
  expect("twitchUserId" in c).toBe(false);
  expect(c.loginHint).toBe("cool_user");
  const { provider: _dropped, ...noProvider } = socketTip({ providerId: "42" } as Partial<SeSocketEvent["data"]>);
  expect(normalizeSeTip(noProvider)!.twitchUserId).toBe("42"); // no provider field: keep the id (older envelopes)
  expect(normalizeSeTip({ ...socketTip({ providerId: "42" } as Partial<SeSocketEvent["data"]>), provider: "twitch" })!.twitchUserId).toBe("42");
});
