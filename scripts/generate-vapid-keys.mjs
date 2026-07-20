// Generate a VAPID keypair for Web Push (§11).
// Usage: node scripts/generate-vapid-keys.mjs
// Then:  wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('VAPID_PUBLIC_KEY=', b64url(pub));
console.log('VAPID_PRIVATE_KEY=', jwk.d);
console.log('VAPID_SUBJECT=', 'mailto:you@example.com');
