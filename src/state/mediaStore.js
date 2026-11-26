/**
 * IndexedDB + BroadcastChannel Media Store for Custom CRT TV Uploads
 * Persists uploaded videos, animated GIFs, and images locally and synchronizes
 * them across Control View and Presentation View tabs/windows.
 */

const DB_NAME = 'pingpong-crt-media-db';
const STORE_NAME = 'media';
const MEDIA_KEY = 'active-tv-media';
const MEDIA_CHANNEL = 'pingpong-crt-media-sync';
const SYNC_SERVER_URL_KEY = 'pingpong-sync-server-url-v1';

function getSyncBaseUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const custom = String(localStorage.getItem(SYNC_SERVER_URL_KEY) || '').trim();
    if (custom) return custom.replace(/\/+$/, '');
  } catch {
    // Ignore
  }
  return window.location.origin.replace(/\/+$/, '');
}

function openMediaDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeLocalMediaRecord(persistedRecord) {
  try {
    const db = await openMediaDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      if (persistedRecord) {
        tx.objectStore(STORE_NAME).put(persistedRecord, MEDIA_KEY);
      } else {
        tx.objectStore(STORE_NAME).delete(MEDIA_KEY);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Proceed even if IndexedDB quota or private browsing blocks storage
  }
}

export async function saveTvMediaBlob(file, { senderId = '' } = {}) {
  const lowerName = String(file.name || '').toLowerCase();
  const inferredType =
    file.type ||
    (lowerName.endsWith('.gif')
      ? 'image/gif'
      : lowerName.endsWith('.webp')
      ? 'image/webp'
      : lowerName.endsWith('.mp4')
      ? 'video/mp4'
      : lowerName.endsWith('.webm')
      ? 'video/webm'
      : 'image/png');
  const kind = inferredType.startsWith('video/') ? 'video' : 'image';
  let dataBuffer = null;
  try {
    dataBuffer = await file.arrayBuffer();
  } catch {
    dataBuffer = null;
  }

  let updatedAt = Date.now();
  const persistedRecord = {
    data: dataBuffer,
    blob: dataBuffer ? null : file,
    name: file.name,
    type: inferredType,
    kind,
    updatedAt,
  };

  await writeLocalMediaRecord(persistedRecord);

  // Upload to LAN Sync Server FIRST (awaited) so remote phones/TVs/laptops never fetch before upload finishes
  let syncedRemote = false;
  let remoteError = null;
  if (typeof fetch !== 'undefined' && dataBuffer) {
    const baseUrl = getSyncBaseUrl();
    if (baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/__sync/media`, {
          method: 'POST',
          headers: {
            'Content-Type': inferredType,
            'X-Media-Name': encodeURIComponent(file.name || 'tv-media'),
            'X-Media-Type': inferredType,
            'X-Media-Kind': kind,
            ...(senderId ? { 'X-Sync-Sender': senderId } : {}),
          },
          body: dataBuffer,
        });
        if (res.ok) {
          syncedRemote = true;
          try {
            const payload = await res.json();
            if (payload?.updatedAt) updatedAt = Number(payload.updatedAt) || updatedAt;
          } catch {
            // Ignore JSON parse errors
          }
        } else {
          let errMsg = `Upload failed (${res.status})`;
          try {
            const payload = await res.json();
            if (payload?.error) errMsg = payload.error;
          } catch {
            // Ignore
          }
          remoteError = errMsg;
        }
      } catch (err) {
        remoteError = err?.message || 'Could not reach LAN sync server';
      }
    }
  }

  const liveRecord = {
    blob: dataBuffer ? new Blob([dataBuffer], { type: inferredType }) : file,
    name: file.name,
    type: inferredType,
    kind,
    updatedAt,
    syncedRemote,
    remoteError,
  };

  broadcastMediaUpdate({ action: 'set', record: liveRecord });
  return liveRecord;
}

export function buildRemoteMediaUrl(updatedAt = Date.now(), mediaId = '') {
  const baseUrl = getSyncBaseUrl();
  if (!baseUrl) return '';
  const idPart = mediaId ? `id=${encodeURIComponent(String(mediaId))}&` : '';
  return `${baseUrl}/__sync/media?${idPart}t=${encodeURIComponent(String(updatedAt || Date.now()))}`;
}

async function writeLocalMediaRecordByKey(key, persistedRecord) {
  try {
    const db = await openMediaDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      if (persistedRecord) {
        tx.objectStore(STORE_NAME).put(persistedRecord, key);
      } else {
        tx.objectStore(STORE_NAME).delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage errors
  }
}

async function readLocalMediaRecordByKey(key) {
  try {
    const db = await openMediaDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record;
  } catch {
    return null;
  }
}

/**
 * Parses a GIF87a/GIF89a ArrayBuffer and calculates its exact single-loop duration in seconds
 * by walking all blocks and summing Graphic Control Extension frame delays (matching browser
 * clamping of <20ms delays to 100ms). Returns `null` for non-GIFs or single-frame GIFs.
 */
export function parseGifDurationSec(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 14) return null;
  const bytes = new Uint8Array(arrayBuffer);
  // Check "GIF87a" or "GIF89a"
  if (
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x38 ||
    (bytes[4] !== 0x37 && bytes[4] !== 0x39) ||
    bytes[5] !== 0x61
  ) {
    return null;
  }

  let pos = 13; // 6-byte header + 7-byte Logical Screen Descriptor
  const gctPacked = bytes[10];
  if (gctPacked & 0x80) {
    pos += 3 * (1 << ((gctPacked & 0x07) + 1));
  }

  const len = bytes.length;
  let totalMs = 0;
  let frameCount = 0;

  while (pos < len) {
    const block = bytes[pos++];
    if (block === 0x3b) break; // GIF Trailer

    if (block === 0x21) {
      // Extension block
      if (pos >= len) break;
      const label = bytes[pos++];
      if (label === 0xf9 && pos + 5 < len && bytes[pos] === 0x04) {
        const delayCs = bytes[pos + 2] | (bytes[pos + 3] << 8);
        totalMs += (delayCs < 2 ? 10 : delayCs) * 10;
        frameCount += 1;
      }
      // Skip extension sub-blocks
      while (pos < len) {
        const subSize = bytes[pos++];
        if (!subSize) break;
        pos += subSize;
      }
    } else if (block === 0x2c) {
      // Image Descriptor (9 bytes)
      if (pos + 9 > len) break;
      const lctPacked = bytes[pos + 8];
      pos += 9;
      if (lctPacked & 0x80) {
        pos += 3 * (1 << ((lctPacked & 0x07) + 1));
      }
      if (pos >= len) break;
      pos += 1; // LZW Minimum Code Size
      // Skip image data sub-blocks
      while (pos < len) {
        const subSize = bytes[pos++];
        if (!subSize) break;
        pos += subSize;
      }
    } else {
      break;
    }
  }

  if (frameCount <= 1 || totalMs <= 0) return null;
  return Math.max(1, Math.min(300, Math.round(totalMs / 1000)));
}

export async function saveTvPlaylistItemBlob(file, { mediaId = '', senderId = '' } = {}) {
  const id = mediaId || `tvm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const lowerName = String(file.name || '').toLowerCase();
  const inferredType =
    file.type ||
    (lowerName.endsWith('.gif')
      ? 'image/gif'
      : lowerName.endsWith('.webp')
      ? 'image/webp'
      : lowerName.endsWith('.mp4')
      ? 'video/mp4'
      : lowerName.endsWith('.webm')
      ? 'video/webm'
      : lowerName.endsWith('.mov')
      ? 'video/quicktime'
      : 'image/png');
  const kind = inferredType.startsWith('video/') ? 'video' : 'image';
  let dataBuffer = null;
  try {
    dataBuffer = await file.arrayBuffer();
  } catch {
    dataBuffer = null;
  }
  const detectedDurationSec =
    inferredType === 'image/gif' && dataBuffer ? parseGifDurationSec(dataBuffer) : null;
  let updatedAt = Date.now();
  const persistedRecord = {
    id,
    data: dataBuffer,
    blob: dataBuffer ? null : file,
    name: file.name || 'TV Media',
    type: inferredType,
    kind,
    updatedAt,
  };
  await writeLocalMediaRecordByKey(`playlist:${id}`, persistedRecord);

  let syncedRemote = false;
  let remoteError = null;
  if (typeof fetch !== 'undefined' && dataBuffer) {
    const baseUrl = getSyncBaseUrl();
    if (baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/__sync/media?id=${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: {
            'Content-Type': inferredType,
            'X-Media-Id': id,
            'X-Media-Name': encodeURIComponent(file.name || 'tv-media'),
            'X-Media-Type': inferredType,
            'X-Media-Kind': kind,
            ...(senderId ? { 'X-Sync-Sender': senderId } : {}),
          },
          body: dataBuffer,
        });
        if (res.ok) {
          syncedRemote = true;
          const payload = await res.json().catch(() => null);
          if (payload?.updatedAt) updatedAt = Number(payload.updatedAt) || updatedAt;
        } else {
          const payload = await res.json().catch(() => null);
          remoteError = payload?.error || `Upload failed (${res.status})`;
        }
      } catch (err) {
        remoteError = err?.message || 'Could not reach LAN sync server';
      }
    }
  }

  return {
    id,
    name: file.name || 'TV Media',
    type: inferredType,
    kind,
    detectedDurationSec,
    updatedAt,
    syncedRemote,
    remoteError,
  };
}

export async function deleteTvPlaylistItemBlob(mediaId, { senderId = '' } = {}) {
  if (!mediaId) return;
  await writeLocalMediaRecordByKey(`playlist:${mediaId}`, null);
  if (typeof fetch !== 'undefined') {
    const baseUrl = getSyncBaseUrl();
    if (baseUrl) {
      try {
        await fetch(`${baseUrl}/__sync/media?id=${encodeURIComponent(mediaId)}`, {
          method: 'DELETE',
          headers: senderId ? { 'X-Sync-Sender': senderId } : undefined,
        });
      } catch {
        // Ignore offline errors
      }
    }
  }
}

export async function loadTvPlaylistItemSource(item) {
  if (!item || item.kind === 'sitcom') return null;
  if (item.kind === 'url' && item.url) {
    const lower = String(item.url).toLowerCase().split('?')[0];
    const isVideo = /\.(mp4|webm|mov|m4v|ogv)$/.test(lower);
    return {
      hasMedia: true,
      url: item.url,
      name: item.name || item.url,
      type: isVideo ? 'video/mp4' : 'image/*',
      kind: isVideo ? 'video' : 'image',
      updatedAt: item.updatedAt || Date.now(),
      isObjectUrl: false,
    };
  }
  const mediaId = item.id;
  if (!mediaId) return null;

  // Prefer remote streaming URL so videos get HTTP 206 range support & remote clients sync seamlessly
  if (typeof fetch !== 'undefined') {
    const baseUrl = getSyncBaseUrl();
    if (baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/__sync/media?meta=1&id=${encodeURIComponent(mediaId)}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const meta = await res.json();
          if (meta?.hasMedia) {
            return {
              hasMedia: true,
              url: buildRemoteMediaUrl(meta.updatedAt || item.updatedAt, mediaId),
              name: meta.name || item.name || 'tv-media',
              type: meta.type || item.type || 'application/octet-stream',
              kind: meta.kind || item.kind || 'image',
              updatedAt: meta.updatedAt || item.updatedAt || Date.now(),
              isObjectUrl: false,
            };
          }
        }
      } catch {
        // Fall through to local IndexedDB
      }
    }
  }

  const localRec = await readLocalMediaRecordByKey(`playlist:${mediaId}`);
  if (!localRec) return null;
  const blob = localRec.data
    ? new Blob([localRec.data], { type: localRec.type || 'application/octet-stream' })
    : localRec.blob;
  if (!blob) return null;
  return {
    hasMedia: true,
    url: URL.createObjectURL(blob),
    name: localRec.name || item.name || 'tv-media',
    type: localRec.type || blob.type || 'application/octet-stream',
    kind: localRec.kind || item.kind || 'image',
    updatedAt: localRec.updatedAt || item.updatedAt || Date.now(),
    isObjectUrl: true,
  };
}

/**
 * Lightweight remote media metadata probe (`GET /__sync/media?meta=1`) so
 * `<video>` and `<img>` elements can stream directly over HTTP (with 206 byte-range
 * support for videos and native browser animation for GIFs/WebP on non-HTTPS LAN).
 */
export async function loadRemoteTvMediaMeta() {
  if (typeof fetch === 'undefined') return null;
  const baseUrl = getSyncBaseUrl();
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/__sync/media?meta=1&t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.hasMedia) return { hasMedia: false };
    const updatedAt = Number(data.updatedAt) || Date.now();
    const type = String(data.type || 'application/octet-stream');
    const kind = String(data.kind || (type.startsWith('video/') ? 'video' : 'image'));
    return {
      hasMedia: true,
      url: `${baseUrl}/__sync/media?t=${updatedAt}`,
      name: String(data.name || 'tv-media'),
      type,
      kind,
      bytes: Number(data.bytes) || 0,
      updatedAt,
      isObjectUrl: false,
    };
  } catch {
    return null;
  }
}

export async function loadTvMediaSource({ preferRemote = true } = {}) {
  if (preferRemote) {
    const meta = await loadRemoteTvMediaMeta();
    if (meta?.hasMedia && meta.url) {
      return meta;
    }
    if (meta && meta.hasMedia === false) {
      // Server explicitly has no custom media (e.g. Reset Sitcom)
      return null;
    }
  }
  // Offline fallback: read from local IndexedDB
  const localRecord = await loadTvMediaBlob({ preferRemote: false });
  if (localRecord?.blob) {
    return {
      hasMedia: true,
      url: URL.createObjectURL(localRecord.blob),
      name: localRecord.name || 'tv-media',
      type: localRecord.type || localRecord.blob.type || 'application/octet-stream',
      kind:
        localRecord.kind ||
        ((localRecord.type || localRecord.blob.type || '').startsWith('video/')
          ? 'video'
          : 'image'),
      updatedAt: localRecord.updatedAt || Date.now(),
      isObjectUrl: true,
    };
  }
  return null;
}

export async function loadRemoteTvMediaBlob() {
  if (typeof fetch === 'undefined') return null;
  const baseUrl = getSyncBaseUrl();
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/__sync/media?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status !== 200) return null;
    const buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) return null;
    const type = res.headers.get('Content-Type') || 'application/octet-stream';
    const name = decodeURIComponent(res.headers.get('X-Media-Name') || 'tv-media');
    const kind = res.headers.get('X-Media-Kind') || (type.startsWith('video/') ? 'video' : 'image');
    const updatedAt = Number(res.headers.get('X-Media-Updated')) || Date.now();
    // Cache latest remote media into IndexedDB so reloads stay fast and never show stale local media
    writeLocalMediaRecord({ data: buffer, blob: null, name, type, kind, updatedAt });
    return {
      blob: new Blob([buffer], { type }),
      name,
      type,
      kind,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export async function loadTvMediaBlob({ preferRemote = true } = {}) {
  if (preferRemote) {
    const remote = await loadRemoteTvMediaBlob();
    if (remote) return remote;
  }
  try {
    const db = await openMediaDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(MEDIA_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (record) {
      if (record.data instanceof ArrayBuffer) {
        return {
          ...record,
          blob: new Blob([record.data], { type: record.type || 'application/octet-stream' }),
        };
      }
      if (record.blob) return record;
    }
  } catch {
    // Fall through to remote check
  }
  return preferRemote ? null : loadRemoteTvMediaBlob();
}

export async function clearTvMediaBlob({ senderId = '' } = {}) {
  await writeLocalMediaRecord(null);
  broadcastMediaUpdate({ action: 'clear' });
  if (typeof fetch !== 'undefined') {
    const baseUrl = getSyncBaseUrl();
    if (baseUrl) {
      try {
        await fetch(`${baseUrl}/__sync/media`, {
          method: 'DELETE',
          headers: senderId ? { 'X-Sync-Sender': senderId } : undefined,
        });
      } catch {
        // Ignore offline delete failures
      }
    }
  }
}

function broadcastMediaUpdate(payload) {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(MEDIA_CHANNEL);
    ch.postMessage(payload);
    ch.close();
  } catch {
    // Ignore clone/channel errors
  }
}

export function subscribeTvMediaSync(onUpdate) {
  let ch = null;
  if (typeof BroadcastChannel !== 'undefined') {
    ch = new BroadcastChannel(MEDIA_CHANNEL);
    ch.onmessage = (event) => {
      if (event.data) {
        onUpdate(event.data);
      }
    };
  }

  const onRemoteMedia = async (ev) => {
    const detail = ev.detail || {};
    if (detail.action === 'clear') {
      await writeLocalMediaRecord(null);
      onUpdate({ action: 'clear' });
    } else if (detail.action === 'set') {
      const updatedAt = Number(detail.updatedAt) || Date.now();
      const type = String(detail.type || 'application/octet-stream');
      const kind = String(detail.kind || (type.startsWith('video/') ? 'video' : 'image'));
      const url = buildRemoteMediaUrl(updatedAt);
      if (url) {
        onUpdate({
          action: 'set',
          source: {
            hasMedia: true,
            url,
            name: String(detail.name || 'tv-media'),
            type,
            kind,
            updatedAt,
            isObjectUrl: false,
          },
        });
      }
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pingpong-remote-media-update', onRemoteMedia);
  }

  return () => {
    if (ch) ch.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pingpong-remote-media-update', onRemoteMedia);
    }
  };
}
