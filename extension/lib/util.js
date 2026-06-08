// Pure helpers shared by the service worker and extension pages (ES module).
// (The Ally content script is self-contained and does NOT import this.)

// "−$250.00" (Unicode minus U+2212) -> "250.00"
export function parseAmount(text) {
  return String(text == null ? '' : text).replace(/[^0-9.]/g, '');
}

// "Jun 2, 2026 11:12 pm ET" -> "2026-06-02"
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
export function parseDate(text) {
  const m = String(text == null ? '' : text).match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return 'unknown-date';
  const mm = MONTHS[m[1].slice(0, 3).toLowerCase()] || '00';
  return `${m[3]}-${mm}-${String(m[2]).padStart(2, '0')}`;
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLen = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLen)));
}

// OAuth 2.1 PKCE (S256): returns { verifier, challenge }.
export async function pkceChallenge() {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

// Blob -> standard base64 (for JSON/messaging and the Anthropic image block).
export async function b64FromBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64ToBlob(b64, type = 'image/png') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
