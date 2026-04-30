import type { AsanaAttachment, Env, RehostedAttachment } from './types';

// Only rehost from these hosts. Asana attachments with `host !== 'asana'`
// (Dropbox, Drive, Box, etc.) are URL pointers we don't control — skip them
// to avoid SSRF and to avoid storing third-party content we have no rights to.
const ALLOWED_HOSTS: readonly string[] = ['asanausercontent.com'];
const MAX_REHOST_BYTES = 100 * 1024 * 1024; // 100 MB
const DOWNLOAD_TIMEOUT_MS = 30_000;
const REHOST_CONCURRENCY = 6;

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

  try {
    await env.PHOTOS.put(key, res.body, {
      httpMetadata: {
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      },
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
