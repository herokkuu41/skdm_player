import crypto from 'node:crypto';

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function parseDriveFileId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Google Drive link is required.');

  if (FILE_ID_RE.test(raw) && !raw.includes('.')) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a valid Google Drive share link or file ID.');
  }

  const host = url.hostname.toLowerCase();
  if (!(
    host === 'drive.google.com' ||
    host === 'docs.google.com' ||
    host === 'drive.usercontent.google.com'
  )) {
    throw new Error('Only Google Drive links are accepted.');
  }

  const pathMatch = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/);
  const id = pathMatch?.[1] || url.searchParams.get('id');
  if (!id || !FILE_ID_RE.test(id)) {
    throw new Error('Could not find a Google Drive file ID in that link.');
  }
  return id;
}

export function normalizeTitle(input) {
  return String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Private video';
}

function keyFromSecret(secret) {
  const value = String(secret ?? '');
  if (value.length < 32) {
    throw new Error('SIGNING_SECRET must be at least 32 characters long.');
  }
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export function sealVideoConfig(config, secret, nowMs = Date.now()) {
  const payload = {
    v: 1,
    f: config.fileId,
    t: normalizeTitle(config.title),
    iat: Math.floor(nowMs / 1000),
    exp: config.expiresAt ? Math.floor(config.expiresAt / 1000) : 0
  };

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [iv, ciphertext, tag].map((part) => part.toString('base64url')).join('.');
}

export function openVideoConfig(token, secret, nowMs = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new Error('Invalid watch link.');

  try {
    const [ivPart, ciphertextPart, tagPart] = parts;
    const iv = Buffer.from(ivPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');

    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > 4096) {
      throw new Error('Invalid token data.');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');

    const payload = JSON.parse(plaintext);
    if (payload.v !== 1 || !FILE_ID_RE.test(payload.f) || typeof payload.t !== 'string') {
      throw new Error('Invalid token payload.');
    }
    if (payload.exp && Math.floor(nowMs / 1000) > payload.exp) {
      const err = new Error('This watch link has expired.');
      err.code = 'EXPIRED';
      throw err;
    }
    return {
      fileId: payload.f,
      title: normalizeTitle(payload.t),
      issuedAt: payload.iat,
      expiresAt: payload.exp || 0
    };
  } catch (err) {
    if (err?.code === 'EXPIRED') throw err;
    throw new Error('Invalid or modified watch link.');
  }
}

export function safeSecretEqual(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function makePreviewUrl(fileId) {
  if (!FILE_ID_RE.test(String(fileId))) throw new Error('Invalid file ID.');
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
}
