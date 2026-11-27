/**
 * Zero-Dependency Google Cloud Storage (GCS) V4 Signed URL Generator
 *
 * Enables direct browser-to-GCS uploads (PUT), streaming downloads (GET),
 * and object cleanup (DELETE) without buffering large media files in Render RAM.
 *
 * Required environment variables to activate:
 * - GCS_BUCKET: Name of your GCS bucket (e.g. "jitter-tv-media")
 * - GCS_SERVICE_ACCOUNT_JSON: Full JSON string of a Service Account key with
 *   Storage Object Admin on that bucket (or GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY).
 *
 * Optional environment variables:
 * - GCS_PREFIX: Object key prefix (default: "jitter-tv/")
 * - GCS_PUBLIC_READ: Set "true" if the bucket has public allUsers read access
 */

import crypto from 'node:crypto';

function encodeRfc3986(str) {
  return encodeURIComponent(String(str)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeObjectPath(objectName) {
  return String(objectName || '')
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeRfc3986(seg))
    .join('/');
}

function formatGcsTimestamps(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return {
    datestamp: `${y}${m}${d}`,
    requestTimestamp: `${y}${m}${d}T${hh}${mm}${ss}Z`,
  };
}

export function getGcsConfig(env = process.env) {
  const bucket = String(env?.GCS_BUCKET || '')
    .trim()
    .replace(/^gs:\/\//i, '')
    .replace(/\/+$/, '');
  if (!bucket) return null;

  let clientEmail = String(env?.GCS_CLIENT_EMAIL || '').trim();
  let privateKey = String(env?.GCS_PRIVATE_KEY || '').trim();

  const rawJson = String(env?.GCS_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson && (!clientEmail || !privateKey)) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      // Fallback: if an env var UI turned escaped \n inside private_key into literal newlines,
      // or if the user provided base64-encoded JSON, try recovering cleanly.
      try {
        const decoded = Buffer.from(rawJson, 'base64').toString('utf8');
        if (decoded.trim().startsWith('{')) {
          parsed = JSON.parse(decoded);
        }
      } catch {
        // Ignore
      }
      if (!parsed) {
        const emailMatch = rawJson.match(/"client_email"\s*:\s*"([^"]+)"/);
        const keyMatch = rawJson.match(/"private_key"\s*:\s*"([\s\S]*?-----END PRIVATE KEY-----(?:\\n|\r?\n)?)"/);
        if (emailMatch && keyMatch) {
          parsed = { client_email: emailMatch[1], private_key: keyMatch[1] };
        }
      }
    }
    if (parsed) {
      if (!clientEmail && parsed.client_email) clientEmail = String(parsed.client_email).trim();
      if (!privateKey && parsed.private_key) privateKey = String(parsed.private_key).trim();
    }
  }

  if (!clientEmail || !privateKey) return null;
  // Normalize literal "\n" sequences from single-line env vars
  privateKey = privateKey.replace(/\\n/g, '\n');

  const rawPrefix = String(env?.GCS_PREFIX || 'jitter-tv/').trim().replace(/^\/+/, '');
  const prefix = rawPrefix ? (rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`) : '';
  const publicRead = String(env?.GCS_PUBLIC_READ || '').trim().toLowerCase() === 'true';

  return {
    bucket,
    clientEmail,
    privateKey,
    prefix,
    publicRead,
  };
}

export function buildGcsObjectName(prefix, mediaId, fileName = 'media') {
  const safeBase = String(fileName || 'media')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'media';
  const safeId = String(mediaId || `tvm-${Date.now()}`).replace(/[^a-zA-Z0-9_-]+/g, '');
  return `${prefix}${safeId}-${safeBase}`;
}

/**
 * Generates a Google Cloud Storage V4 Signed URL using pure Node crypto.
 */
export function signGcsV4Url({
  bucket,
  objectName,
  clientEmail,
  privateKey,
  method = 'GET',
  contentType = '',
  expiresSec = 900,
  now = new Date(),
}) {
  const upperMethod = String(method || 'GET').toUpperCase();
  const clampedExpires = Math.max(60, Math.min(604800, Math.floor(Number(expiresSec) || 900)));
  const { datestamp, requestTimestamp } = formatGcsTimestamps(now);
  const host = 'storage.googleapis.com';
  const canonicalUri = `/${encodeRfc3986(bucket)}/${encodeObjectPath(objectName)}`;
  const credentialScope = `${datestamp}/auto/storage/goog4_request`;
  const credential = `${clientEmail}/${credentialScope}`;

  const headerEntries = [['host', host]];
  if (upperMethod === 'PUT' && contentType) {
    headerEntries.push(['content-type', String(contentType).trim()]);
  }
  headerEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const signedHeaders = headerEntries.map(([k]) => k).join(';');
  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join('');

  const queryParams = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', credential],
    ['X-Goog-Date', requestTimestamp],
    ['X-Goog-Expires', String(clampedExpires)],
    ['X-Goog-SignedHeaders', signedHeaders],
  ];
  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalRequest = [
    upperMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const hashedCanonicalRequest = crypto
    .createHash('sha256')
    .update(canonicalRequest, 'utf8')
    .digest('hex');

  const stringToSign = [
    'GOOG4-RSA-SHA256',
    requestTimestamp,
    credentialScope,
    hashedCanonicalRequest,
  ].join('\n');

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(stringToSign, 'utf8')
    .sign(privateKey, 'hex');

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Goog-Signature=${signature}`;
}

export function buildGcsPublicUrl(bucket, objectName) {
  return `https://storage.googleapis.com/${encodeRfc3986(bucket)}/${encodeObjectPath(objectName)}`;
}

/**
 * Generates a V4 Signed URL for listing objects in a GCS bucket (XML API ListObjectsV2).
 */
export function signGcsListV4Url({
  bucket,
  prefix = '',
  maxKeys = 100,
  clientEmail,
  privateKey,
  expiresSec = 300,
  now = new Date(),
}) {
  const clampedExpires = Math.max(60, Math.min(3600, Math.floor(Number(expiresSec) || 300)));
  const { datestamp, requestTimestamp } = formatGcsTimestamps(now);
  const host = 'storage.googleapis.com';
  const canonicalUri = `/${encodeRfc3986(bucket)}`;
  const credentialScope = `${datestamp}/auto/storage/goog4_request`;
  const credential = `${clientEmail}/${credentialScope}`;
  const signedHeaders = 'host';
  const canonicalHeaders = `host:${host}\n`;

  const queryParams = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', credential],
    ['X-Goog-Date', requestTimestamp],
    ['X-Goog-Expires', String(clampedExpires)],
    ['X-Goog-SignedHeaders', signedHeaders],
    ['list-type', '2'],
    ['max-keys', String(Math.max(1, Math.min(1000, Number(maxKeys) || 100)))],
  ];
  if (prefix) {
    queryParams.push(['prefix', String(prefix)]);
  }
  queryParams.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const hashedCanonicalRequest = crypto
    .createHash('sha256')
    .update(canonicalRequest, 'utf8')
    .digest('hex');

  const stringToSign = [
    'GOOG4-RSA-SHA256',
    requestTimestamp,
    credentialScope,
    hashedCanonicalRequest,
  ].join('\n');

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(stringToSign, 'utf8')
    .sign(privateKey, 'hex');

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Goog-Signature=${signature}`;
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Parses a GCS XML ListObjectsV2 response into normalized media library entries.
 */
export function parseGcsListXml(xmlText, prefix = '') {
  const xml = String(xmlText || '');
  const items = [];
  const blockRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = blockRegex.exec(xml)) !== null) {
    const block = match[1];
    const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
    if (!keyMatch) continue;
    const gcsObject = decodeXmlEntities(keyMatch[1]).trim();
    if (!gcsObject || gcsObject.endsWith('/')) continue;

    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
    const modMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
    const size = sizeMatch ? Number(sizeMatch[1]) || 0 : 0;
    const updatedAt = modMatch ? Date.parse(modMatch[1].trim()) || 0 : 0;

    const stripped =
      prefix && gcsObject.startsWith(prefix) ? gcsObject.slice(prefix.length) : gcsObject;
    const baseSegment = stripped.split('/').pop() || stripped;
    // Match `tvm-<ts>-<rand>-<filename>` generated by buildGcsObjectName
    const idNameMatch = baseSegment.match(/^(tvm-[a-zA-Z0-9]+-[a-zA-Z0-9]+)-(.+)$/);
    const id = idNameMatch ? idNameMatch[1] : `gcs-${baseSegment}`;
    const name = idNameMatch ? idNameMatch[2] : baseSegment;
    const lower = name.toLowerCase();
    const isVideo = /\.(mp4|webm|mov|m4v|ogv)$/.test(lower);
    const type = lower.endsWith('.mp4')
      ? 'video/mp4'
      : lower.endsWith('.webm')
      ? 'video/webm'
      : lower.endsWith('.gif')
      ? 'image/gif'
      : lower.endsWith('.webp')
      ? 'image/webp'
      : lower.endsWith('.png')
      ? 'image/png'
      : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
      ? 'image/jpeg'
      : isVideo
      ? 'video/mp4'
      : 'image/*';

    items.push({
      id,
      name,
      kind: isVideo ? 'video' : 'image',
      type,
      size,
      gcsObject,
      storage: 'gcs',
      updatedAt,
    });
  }
  return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
