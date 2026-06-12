/**
 * Web Push helper for Cloudflare Workers.
 *
 * Implements RFC 8292 (VAPID, ES256 over P-256) and RFC 8291 / RFC 8188
 * (aes128gcm payload encryption) on top of SubtleCrypto — no Node deps.
 *
 *   const result = await sendPush(subscription, { title, body, url }, vapid);
 *   // result.status === 201 on success; 410/404 → prune from DB.
 */

export interface VapidKeys {
  /** base64url-encoded uncompressed P-256 public key (65 bytes, 0x04-prefixed). */
  publicKey: string;
  /** base64url-encoded raw P-256 private scalar (32 bytes). */
  privateKey: string;
  /** Contact for the push service — `mailto:you@example.com` or `https://…`. */
  subject: string;
}

export interface PushSubscriptionLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SendPushOptions {
  /** Seconds the push service should retain the message. Default: 24h. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Replaces any prior message with the same topic for this endpoint. */
  topic?: string;
}

export interface SendPushResult {
  status: number;
  ok: boolean;
  body?: string;
  /** True for permanent-gone responses (410/404) — caller should delete the subscription. */
  gone: boolean;
}

type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

function bytes(n: number): Bytes {
  return new Uint8Array(new ArrayBuffer(n)) as Bytes;
}

function fromArrayBuffer(ab: ArrayBuffer): Bytes {
  return new Uint8Array(ab) as Bytes;
}

function b64uDecode(s: string): Bytes {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = bytes(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function b64uEncode(buf: Uint8Array | ArrayBuffer): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = bytes(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function slice(src: Uint8Array, start: number, end: number): Bytes {
  const out = bytes(end - start);
  out.set(src.subarray(start, end));
  return out;
}

async function hmacKey(key: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** HKDF-Extract per RFC 5869 §2.2 — HMAC-SHA-256(salt, ikm), 32 bytes out. */
async function hkdfExtract(salt: Bytes, ikm: Bytes): Promise<Bytes> {
  const k = await hmacKey(salt);
  return fromArrayBuffer(await crypto.subtle.sign("HMAC", k, ikm));
}

/** HKDF-Expand per RFC 5869 §2.3, truncated to `length` bytes. */
async function hkdfExpand(prk: Bytes, info: Uint8Array, length: number): Promise<Bytes> {
  const k = await hmacKey(prk);
  const out = bytes(length);
  let t: Bytes = bytes(0);
  let off = 0;
  let counter = 1;
  while (off < length) {
    const block = fromArrayBuffer(await crypto.subtle.sign("HMAC", k, concat(t, info, Uint8Array.from([counter]))));
    const take = Math.min(block.length, length - off);
    out.set(block.subarray(0, take), off);
    off += take;
    t = block;
    counter++;
  }
  return out;
}

async function importUaPublic(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("user-agent public key must be 65-byte uncompressed P-256 (0x04-prefixed)");
  }
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

async function importVapidPrivate(vapid: VapidKeys): Promise<CryptoKey> {
  const pub = b64uDecode(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID publicKey must be 65-byte uncompressed P-256 (0x04-prefixed)");
  }
  const d = b64uDecode(vapid.privateKey);
  if (d.length !== 32) throw new Error("VAPID privateKey must be 32 raw bytes (base64url-encoded)");

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64uEncode(slice(pub, 1, 33)),
    y: b64uEncode(slice(pub, 33, 65)),
    d: b64uEncode(d),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function signVapidJwt(audience: string, vapid: VapidKeys): Promise<string> {
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64uEncode(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const priv = await importVapidPrivate(vapid);
  const sig = fromArrayBuffer(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(signingInput)),
  );
  return `${signingInput}.${b64uEncode(sig)}`;
}

async function encryptAes128gcm(plaintext: Bytes, sub: PushSubscriptionLike): Promise<Bytes> {
  const uaPublic = b64uDecode(sub.keys.p256dh);
  const authSecret = b64uDecode(sub.keys.auth);

  const uaKey = await importUaPublic(uaPublic);
  const asKeyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = fromArrayBuffer((await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer);

  // Cloudflare's worker types name the ECDH peer key `$public`; DOM uses
  // `public`. Both runtimes accept either field at runtime, so we cast
  // through a structural type that admits both names.
  const ecdhAlgo = { name: "ECDH", public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdh = fromArrayBuffer(await crypto.subtle.deriveBits(ecdhAlgo, asKeyPair.privateKey, 256));

  // RFC 8291 §3.4 — derive IKM.
  const prkKey = await hkdfExtract(authSecret, ecdh);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188 §2.2 — content-encryption keys.
  const salt = crypto.getRandomValues(bytes(16));
  const prk = await hkdfExtract(salt, ikm);
  const cekBytes = await hkdfExpand(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, enc.encode("Content-Encoding: nonce\0"), 12);

  // Single-record plaintext: payload || 0x02 (last-record delimiter).
  const record = concat(plaintext, Uint8Array.from([0x02]));
  const cek = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = fromArrayBuffer(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cek, record));

  // RFC 8188 §2.1 header: salt(16) | rs(4 BE) | idlen(1) | keyid(idlen).
  const rs = bytes(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = concat(salt, rs, Uint8Array.from([asPublic.length]), asPublic);

  return concat(header, ciphertext);
}

export async function sendPush(
  sub: PushSubscriptionLike,
  payload: string | object | Uint8Array,
  vapid: VapidKeys,
  options: SendPushOptions = {},
): Promise<SendPushResult> {
  const audience = new URL(sub.endpoint).origin;
  const jwt = await signVapidJwt(audience, vapid);

  const plaintextRaw =
    payload instanceof Uint8Array
      ? payload
      : enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload));
  const plaintext = bytes(plaintextRaw.length);
  plaintext.set(plaintextRaw);

  const body = await encryptAes128gcm(plaintext, sub);

  const headers: Record<string, string> = {
    Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(options.ttl ?? 60 * 60 * 24),
  };
  if (options.urgency) headers.Urgency = options.urgency;
  if (options.topic) headers.Topic = options.topic;

  const res = await fetch(sub.endpoint, { method: "POST", headers, body });
  const text = await res.text().catch(() => undefined);
  return {
    status: res.status,
    ok: res.ok,
    body: text,
    gone: res.status === 404 || res.status === 410,
  };
}

/**
 * Generate a fresh VAPID keypair. Run this once and store the strings in
 * Worker secrets (e.g. `wrangler secret put VAPID_PUBLIC_KEY`).
 */
export async function generateVapidKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const pub = fromArrayBuffer((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error("missing d in exported JWK");
  return {
    publicKey: b64uEncode(pub),
    privateKey: jwk.d.replace(/=+$/, ""),
  };
}
