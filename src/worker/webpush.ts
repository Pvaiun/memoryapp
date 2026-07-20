// Minimal Web Push sender for Cloudflare Workers: VAPID (RFC 8292) +
// aes128gcm payload encryption (RFC 8291), built on WebCrypto only.

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string; // base64url, 16-byte auth secret
}

export interface VapidKeys {
  publicKey: string; // base64url uncompressed point
  privateKey: string; // base64url 32-byte scalar
  subject: string; // mailto: or https: contact
}

export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: string,
  vapid: VapidKeys,
  ttlSeconds = 3600,
): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const endpoint = new URL(sub.endpoint);
  const jwt = await vapidJwt(endpoint.origin, vapid);
  const body = await encryptPayload(payload, sub);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttlSeconds),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Urgency: 'high',
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });
  // 404/410 mean the subscription is dead and should be pruned.
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

// ---------- VAPID ----------

async function vapidJwt(audience: string, vapid: VapidKeys): Promise<string> {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: vapid.subject,
    }),
  );
  const signingInput = `${header}.${claims}`;

  const pub = b64urlDecode(vapid.publicKey);
  const d = vapid.privateKey;
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64urlFromBytes(pub.slice(1, 33)),
      y: b64urlFromBytes(pub.slice(33, 65)),
      d,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // WebCrypto ECDSA emits raw r||s — exactly the JWS ES256 format.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

// ---------- RFC 8291 aes128gcm ----------

async function encryptPayload(payload: string, sub: PushSubscriptionRecord): Promise<ArrayBuffer> {
  const uaPublicBytes = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);

  const uaPublic = await crypto.subtle.importKey(
    'raw',
    toAB(uaPublicBytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublic }, asKeys.privateKey, 256),
  );

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info"||0x00||ua_pub||as_pub, 32)
  const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), uaPublicBytes, asPublicBytes);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', toAB(cek), 'AES-GCM', false, ['encrypt']);
  // 0x02 = padding delimiter for the final record.
  const plaintext = concat(new TextEncoder().encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toAB(nonce) }, aesKey, toAB(plaintext)),
  );

  // Header: salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const out = concat(salt, rs, new Uint8Array([asPublicBytes.length]), asPublicBytes, ciphertext);
  return toAB(out);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toAB(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: toAB(salt), info: toAB(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---------- Key generation (used by scripts/generate-vapid-keys.mjs) ----------

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64urlFromBytes(pub), privateKey: jwk.d! };
}

// ---------- bytes helpers ----------

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function b64url(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
