/**
 * Photo extraction from the Service Wizard "Final approved scope" page.
 *
 * Renders the page in Cloudflare Browser Rendering, extracts:
 *   - Photos under each approved service (one per service if present)
 *   - Photos in the "Stains & damages" section
 *
 * Uses headings as section anchors (h1-h6 with text matching). Within the
 * approved-scope section, each photo is associated with the service name
 * found in its row/card container. Robust to minor DOM variations.
 *
 * IMPORTANT: this module is invoked from `/lovable-callback` inside
 * ctx.waitUntil(), AFTER the response has been sent to Lovable. Failures
 * here are logged and do NOT affect the primary appendApprovalLink flow.
 */

import puppeteer from '@cloudflare/puppeteer';
import { uploadAttachment } from './asana';
import type { Env } from './types';

export interface ServicePhoto {
  serviceName: string;
  imageUrl: string;
}

export interface ApprovalPhotos {
  servicePhotos: ServicePhoto[];
  stainsPhotos: string[];
}

const NAV_TIMEOUT_MS = 12_000;
const PER_PHOTO_FETCH_TIMEOUT_MS = 8_000;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024; // 25MB hard cap per file

/**
 * Render the approval page and extract photo URLs grouped by section.
 */
export async function extractApprovalPhotos(url: string, env: Env): Promise<ApprovalPhotos> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    // 'domcontentloaded' returns once the main HTML has parsed; much faster
    // than 'networkidle0' which can hang on long-tail XHR or analytics calls.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // The callback runs in the browser context, where document/Element/etc.
    // exist. The Worker's tsconfig doesn't include the DOM lib (and adding it
    // globally conflicts with @jsquash's typings), so we use `any` inside this
    // closure and cast the result back to our typed interface.
    const data = (await page.evaluate(() => {
      const doc: any = (globalThis as any).document;

      const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
      const isHttp = (s: string) => /^https?:\/\//.test(s) && !s.startsWith('data:');
      const txt = (el: any): string =>
        ((el && el.textContent) || '').trim().replace(/\s+/g, ' ');

      const allElements: any[] = Array.from(doc.querySelectorAll('*'));

      // Map each img to the nearest preceding heading (DOM order).
      function nearestHeadingFor(target: any): string | null {
        const idx = allElements.indexOf(target);
        if (idx < 0) return null;
        for (let i = idx - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el && HEADING_TAGS.has(el.tagName)) {
            return txt(el).toLowerCase();
          }
        }
        return null;
      }

      // For an img inside the approved-scope section, find the service name
      // from its row/card container (a strong/heading element near the start).
      function serviceNameFor(img: any): string {
        const row = img.closest(
          'tr, [role="row"], [class*="row"], [class*="card"], [class*="service"], [class*="item"], li, div',
        );
        if (!row) return '';

        const candidates: any[] = Array.from(
          row.querySelectorAll('strong, b, h1, h2, h3, h4, h5, h6'),
        );
        for (const c of candidates) {
          const t = txt(c);
          if (
            t &&
            t.length <= 60 &&
            !/AED/i.test(t) &&
            !/^\d+\s*d$/i.test(t) &&
            !/^total$/i.test(t)
          ) {
            return t;
          }
        }
        return '';
      }

      const result = {
        servicePhotos: [] as { serviceName: string; imageUrl: string }[],
        stainsPhotos: [] as string[],
      };

      const seen = new Set<string>();
      const imgs: any[] = Array.from(doc.querySelectorAll('img'));

      for (const img of imgs) {
        const src: string = img.src || '';
        if (!src || !isHttp(src)) continue;
        if (seen.has(src)) continue;

        const heading = nearestHeadingFor(img);
        if (!heading) continue;

        if (heading.includes('final approved scope')) {
          const name = serviceNameFor(img);
          if (name) {
            seen.add(src);
            result.servicePhotos.push({ serviceName: name, imageUrl: src });
          }
        } else if (heading.includes('stains') || heading.includes('damage')) {
          seen.add(src);
          result.stainsPhotos.push(src);
        }
      }

      return result;
    })) as ApprovalPhotos;

    return data;
  } finally {
    await browser.close();
  }
}

/**
 * Sanitize a string for use as a filename (Asana attachment).
 */
function safeFilename(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 _\-&]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Fetch a photo URL with size + timeout caps.
 */
async function fetchPhoto(url: string): Promise<{ blob: Blob; contentType: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(PER_PHOTO_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`fetch ${res.status}`);
  }

  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const n = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(n) && n > MAX_PHOTO_BYTES) {
      throw new Error(`size ${n} exceeds cap ${MAX_PHOTO_BYTES}`);
    }
  }

  const blob = await res.blob();
  if (blob.size > MAX_PHOTO_BYTES) {
    throw new Error(`size ${blob.size} exceeds cap ${MAX_PHOTO_BYTES}`);
  }

  const contentType = res.headers.get('content-type') ?? blob.type ?? 'image/jpeg';
  return { blob, contentType };
}

/**
 * Render the page, fetch each photo, and upload to the Asana task as
 * attachments with descriptive filenames.
 *
 * Naming convention:
 *   - Per-service photos: "<Service Name>.<ext>"  (e.g., "Premium Cleaning.jpg")
 *   - Stains photos:      "Stain-<n>.<ext>"
 *
 * Throws if the entire flow fails. Caller (index.ts) wraps in try/catch so
 * a failure here never affects appendApprovalLink.
 */
export async function attachPhotosToTask(
  taskGid: string,
  approvalUrl: string,
  env: Env,
): Promise<{ uploaded: number; failed: number }> {
  const photos = await extractApprovalPhotos(approvalUrl, env);

  // Build all upload jobs upfront, then run in parallel. This keeps wall time
  // bounded by the slowest single fetch+upload rather than the sum.
  type Job = { kind: 'service' | 'stain'; filename: string; url: string };
  const jobs: Job[] = [];

  for (const { serviceName, imageUrl } of photos.servicePhotos) {
    jobs.push({
      kind: 'service',
      filename: `${safeFilename(serviceName, 'service')}.tmp`,
      url: imageUrl,
    });
  }
  let stainIdx = 1;
  for (const imageUrl of photos.stainsPhotos) {
    jobs.push({ kind: 'stain', filename: `Stain-${stainIdx}.tmp`, url: imageUrl });
    stainIdx++;
  }

  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const { blob, contentType } = await fetchPhoto(job.url);
      const ext = guessExtension(contentType, job.url);
      // Replace the .tmp placeholder with the real extension now that we have it
      const finalName = job.filename.replace(/\.tmp$/, ext);
      const typed = new Blob([await blob.arrayBuffer()], { type: contentType });
      await uploadAttachment(taskGid, finalName, typed, env);
    }),
  );

  let uploaded = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const job = jobs[i]!;
    if (r.status === 'fulfilled') {
      uploaded++;
    } else {
      failed++;
      console.warn('photo upload failed', {
        taskGid,
        kind: job.kind,
        filename: job.filename,
        url: job.url,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  return { uploaded, failed };
}

function guessExtension(contentType: string, url: string): string {
  if (/jpeg|jpg/i.test(contentType)) return '.jpg';
  if (/png/i.test(contentType)) return '.png';
  if (/webp/i.test(contentType)) return '.webp';
  if (/gif/i.test(contentType)) return '.gif';
  // Fallback to URL extension
  const m = url.match(/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i);
  return m && m[1] ? `.${m[1].toLowerCase()}` : '.jpg';
}
