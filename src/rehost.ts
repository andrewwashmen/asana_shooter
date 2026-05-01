import { compressJpeg, isJpegMagic } from './compress';
import type { AsanaAttachment, Env, RehostedAttachment } from './types';

// Only rehost from these hosts. Asana attachments with `host !== 'asana'`
// (Dropbox, Drive, Box, etc.) are URL pointers we don't control — skip them
// to avoid SSRF and to avoid storing third-party content we have no rights to.
const ALLOWED_HOSTS: readonly string[] = ['asanausercontent.com'];
const MAX_REHOST_BYTES = 100 * 1024 * 1024; // 100 MB
// Files larger than this stream-pass-through unchanged. Buffering big files
// for compression risks OOM (decoded RGBA can be 5-10× the JPEG size).
const MAX_COMPRESS_BYTES = 20 * 1024 * 1024; // 20 MB
const DOWNLOAD_TIMEOUT_MS = 30_000;
// Lowered from 6 because the compression path buffers per-image. A 12 MP
// phone photo decodes to ~49 MB of RGBA pixels; two parallel decodes plus
// resize/encode scratch can spike past the 128 MB Worker memory ceiling.
// Serializing rehosts trades a few seconds of latency (the work runs in
// ctx.waitUntil so it doesn't affect webhook ack) for safe memory bounds.
const REHOST_CONCURRENCY = 1;

export async function rehostAttachments(
  attachments: AsanaAttachment[],
  taskGid: string,
  env: Env,
): Promise<RehostedAttachment[]> {
  return runWithConcurrency(attachments, REHOST_CONCURRENCY, (att) =>
    rehostOne(att, taskGid, env),
  );
}

async function rehostOne(
  att: AsanaAttachment,
  taskGid: string,
  env: Env,
): Promise<RehostedAttachment> {
  if (att.host && att.host !== 'asana') {
    return fail(att, `unsupported host: ${att.host}`);
  }

  const sourceUrl = att.download_url ?? att.view_url;
  if (!sourceUrl) return fail(att, 'no download_url');

  if (!isAllowedUrl(sourceUrl)) {
    return fail(att, 'source URL host not in allowlist');
  }

  if (typeof att.size === 'number' && att.size > MAX_REHOST_BYTES) {
    return fail(att, `attachment size ${att.size} exceeds cap ${MAX_REHOST_BYTES}`);
  }

  let res: Response;
  try {
    res = await fetch(sourceUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return fail(att, `fetch failed: ${String(err)}`);
  }

  if (!res.ok || !res.body) {
    return fail(att, `download status ${res.status}`);
  }

  const lengthHeader = res.headers.get('content-length');
  if (lengthHeader) {
    const len = Number.parseInt(lengthHeader, 10);
    if (Number.isFinite(len) && len > MAX_REHOST_BYTES) {
      return fail(att, `content-length ${len} exceeds cap ${MAX_REHOST_BYTES}`);
    }
  }

  const safeName = (att.name ?? 'file')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_');
  const key = `tasks/${taskGid}/${att.gid}/${safeName}`;

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';

  // Compression path: only for content-typed-as-JPEG inputs under the buffer
  // cap. Anything else streams through unchanged (current behavior).
  const sizeKnown = typeof att.size === 'number' ? att.size : null;
  const eligibleForCompression =
    contentType.toLowerCase().startsWith('image/jpeg') &&
    (sizeKnown === null || sizeKnown <= MAX_COMPRESS_BYTES);

  let body: ReadableStream | Uint8Array = res.body;

  if (eligibleForCompression) {
    try {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > MAX_REHOST_BYTES) {
        return fail(att, `buffered body ${ab.byteLength} exceeds cap ${MAX_REHOST_BYTES}`);
      }
      if (ab.byteLength > MAX_COMPRESS_BYTES) {
        // size header was missing or lied — already paid for the buffer, so
        // upload raw rather than re-fetching as a stream.
        body = new Uint8Array(ab);
        logSkip(taskGid, att.gid, att.name ?? null, 'skipped_oversize', ab.byteLength);
      } else {
        const buffered = new Uint8Array(ab);
        if (!isJpegMagic(buffered)) {
          // content-type said JPEG but magic bytes disagree (e.g. PNG with
          // wrong header). Pass through the bytes as-is.
          body = buffered;
          logSkip(taskGid, att.gid, att.name ?? null, 'skipped_bad_magic', buffered.byteLength);
        } else {
          const result = await compressJpeg(buffered);
          logCompression(taskGid, att.gid, att.name ?? null, result.meta);
          body = result.bytes;
        }
      }
    } catch (err) {
      return fail(att, `buffer/compress failed: ${String(err)}`);
    }
  }

  try {
    await env.PHOTOS.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: {
        asana_attachment_gid: att.gid,
        asana_task_gid: taskGid,
        original_name: att.name ?? '',
      },
    });
  } catch (err) {
    return fail(att, `r2 put failed: ${String(err)}`);
  }

  return {
    ...att,
    rehosted_url: `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
    rehost_error: null,
    r2_key: key,
  };
}

function logCompression(
  taskGid: string,
  attGid: string,
  name: string | null,
  meta: import('./compress').CompressMeta,
): void {
  console.log(
    JSON.stringify({
      msg: 'rehost.compress',
      task_gid: taskGid,
      attachment_gid: attGid,
      name,
      ...meta,
      ratio: meta.orig_bytes > 0 ? meta.final_bytes / meta.orig_bytes : null,
    }),
  );
}

function logSkip(
  taskGid: string,
  attGid: string,
  name: string | null,
  path: 'skipped_oversize' | 'skipped_bad_magic',
  bytes: number,
): void {
  console.log(
    JSON.stringify({
      msg: 'rehost.compress',
      task_gid: taskGid,
      attachment_gid: attGid,
      name,
      path,
      orig_bytes: bytes,
      final_bytes: bytes,
    }),
  );
}

function fail(att: AsanaAttachment, reason: string): RehostedAttachment {
  return { ...att, rehosted_url: null, rehost_error: reason, r2_key: null };
}

function isAllowedUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.some(
    (allowed) => url.hostname === allowed || url.hostname.endsWith(`.${allowed}`),
  );
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
