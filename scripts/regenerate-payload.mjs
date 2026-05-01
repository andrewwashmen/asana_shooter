#!/usr/bin/env node
/* eslint-disable no-console */
// Regenerate the exact outbound payload the worker would POST to Lovable for a
// given Asana task. Mirrors src/transform.ts + src/rehost.ts URL synthesis.
//
// Usage:
//   ASANA_PAT=... node scripts/regenerate-payload.mjs <order-alpha-id|task-gid>
//
// If the argument is purely numeric it's treated as a task gid; otherwise it's
// matched against the order alpha ID parsed from the task name.

import { argv, env, exit } from 'node:process';

const ASANA_PAT = env.ASANA_PAT;
const PROJECT_GID = env.ASANA_PROJECT_GID ?? '1202289964354061';
const R2_PUBLIC_BASE_URL =
  env.R2_PUBLIC_BASE_URL ?? 'https://pub-e253fc5bb5ec4740bf58f9cc062ed9b3.r2.dev';
const TRIGGER_FIELD_NAME = env.TRIGGER_FIELD_NAME ?? 'Assessment System';
const TRIGGER_FIELD_VALUE = env.TRIGGER_FIELD_VALUE ?? 'New';
const ASANA_BASE = 'https://app.asana.com/api/1.0';

if (!ASANA_PAT) {
  console.error('Missing ASANA_PAT env var.');
  console.error('Usage: ASANA_PAT=... node scripts/regenerate-payload.mjs <order-id|task-gid>');
  exit(1);
}

const arg = argv[2];
if (!arg) {
  console.error('Provide an order alpha ID (e.g. CVB678) or task gid as the first argument.');
  exit(1);
}

const TASK_OPT_FIELDS = [
  'name',
  'notes',
  'permalink_url',
  'custom_fields.name',
  'custom_fields.enum_value.name',
].join(',');

const ATTACHMENT_OPT_FIELDS = [
  'name',
  'host',
  'size',
  'created_at',
  'download_url',
  'view_url',
  'permanent_url',
].join(',');

async function asanaGet(path) {
  const res = await fetch(`${ASANA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${ASANA_PAT}` },
  });
  if (!res.ok) {
    throw new Error(`Asana ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function findTaskGid(orderOrGid) {
  if (/^\d+$/.test(orderOrGid)) return orderOrGid;
  // Search the project for tasks whose name contains the order alpha ID.
  // Asana doesn't expose `tasks?text=` on a project, so paginate the project
  // task list and grep the names. The project is small enough for this.
  let offset = null;
  do {
    const params = new URLSearchParams({ opt_fields: 'name', limit: '100' });
    if (offset) params.set('offset', offset);
    const data = await asanaGet(`/projects/${PROJECT_GID}/tasks?${params}`);
    for (const t of data.data ?? []) {
      if ((t.name ?? '').includes(orderOrGid)) return t.gid;
    }
    offset = data.next_page?.offset ?? null;
  } while (offset);
  throw new Error(`No task in project ${PROJECT_GID} matched "${orderOrGid}"`);
}

async function listAttachments(taskGid) {
  const all = [];
  let offset = null;
  do {
    const params = new URLSearchParams({
      parent: taskGid,
      opt_fields: ATTACHMENT_OPT_FIELDS,
      limit: '100',
    });
    if (offset) params.set('offset', offset);
    const data = await asanaGet(`/attachments?${params}`);
    all.push(...(data.data ?? []));
    offset = data.next_page?.offset ?? null;
  } while (offset);
  return all;
}

// ----- Mirror of src/transform.ts -----

const NONE_VALUES = new Set(['', 'none', 'n/a', 'null', 'undefined', '-']);
const TRAY_RE = /^\s*Tray:\s*(\d+)/i;
const GEOFENCE_RE = /\[([^\]]+)\]/;
const AFTER_GEOFENCE_RE = /\]\s*(.+)$/;
const SIZE_RE = /^Size:\s*(.+)$/i;

function clean(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (NONE_VALUES.has(t.toLowerCase())) return null;
  return t;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLabelled(notes, label) {
  if (!notes) return null;
  const re = new RegExp(`${escapeRegExp(label)}:\\s*\\n\\s*([^\\n]+)`, 'i');
  return clean(notes.match(re)?.[1]);
}

function extractSizeFromNotes(notes) {
  const raw = extractLabelled(notes, 'Size');
  if (!raw) return null;
  const m = raw.match(SIZE_RE);
  return clean(m ? m[1] : raw);
}

function extractDashItem(block, label) {
  const re = new RegExp(`-\\s*${escapeRegExp(label)}:\\s*([^\\n]+)`, 'i');
  return clean(block.match(re)?.[1]);
}

function extractCustomerInstructions(notes) {
  const empty = { notes: null, callback_status: null, images: null };
  if (!notes) return empty;
  const blockRe =
    /Customer Instructions:\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*[A-Z][\w ]+:\s*\n|$)/i;
  const block = notes.match(blockRe)?.[1];
  if (!block) return empty;
  return {
    notes: extractDashItem(block, 'Notes'),
    callback_status: extractDashItem(block, 'Callback Status'),
    images: extractDashItem(block, 'Images'),
  };
}

function parseTaskName(name) {
  const trayNumber = name.match(TRAY_RE)?.[1] ?? null;
  const geofence = name.match(GEOFENCE_RE)?.[1]?.trim() ?? null;
  const after = name.match(AFTER_GEOFENCE_RE)?.[1] ?? '';
  const parts = after.split(/\s+-\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const orderId = clean(parts[0]);
  const brand = clean(parts[1]);
  const fullName = clean(parts[3]);
  const color = clean(parts[4]);
  const sizeRaw = parts[5];
  const sizeMatch = sizeRaw?.match(SIZE_RE);
  const size = clean(sizeMatch ? sizeMatch[1] : sizeRaw);
  return { trayNumber, geofence, orderId, brand, fullName, color, size };
}

// ----- Mirror of src/rehost.ts URL derivation -----
// Only Asana-hosted attachments are rehosted. URL is deterministic:
// `<R2_PUBLIC_BASE_URL>/tasks/<task_gid>/<att_gid>/<sanitized_name>`.

function rehostedUrlFor(att, taskGid) {
  if (att.host && att.host !== 'asana') return null; // non-Asana hosts are skipped
  if (!att.download_url && !att.view_url) return null;
  const safeName = (att.name ?? 'file')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_');
  const base = R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${base}/tasks/${taskGid}/${att.gid}/${safeName}`;
}

function splitAttachments(attachments, taskGid) {
  const successful = attachments
    .map((a) => ({ ...a, rehosted_url: rehostedUrlFor(a, taskGid) }))
    .filter((a) => typeof a.rehosted_url === 'string');
  const beforeImages = successful
    .filter((a) => a.name?.startsWith('BEFORE-'))
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    .map((a) => a.rehosted_url);
  const otherImages = successful
    .filter((a) => !a.name?.startsWith('BEFORE-'))
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    .map((a) => a.rehosted_url);
  return { beforeImages, otherImages };
}

// ----- Build payload -----

const taskGid = await findTaskGid(arg);
const taskRes = await asanaGet(
  `/tasks/${encodeURIComponent(taskGid)}?opt_fields=${TASK_OPT_FIELDS}`,
);
const task = taskRes.data;
const attachments = await listAttachments(taskGid);

const parsed = parseTaskName(task.name ?? '');
const notes = task.notes ?? '';

const orderId = parsed.orderId ?? extractLabelled(notes, 'Order Alpha ID');
const itemCode = extractLabelled(notes, 'Item Code');
const { beforeImages, otherImages } = splitAttachments(attachments, taskGid);

const fields = {
  geofence: parsed.geofence,
  order_id: orderId,
  customer_alpha_id: extractLabelled(notes, 'Customer Alpha ID'),
  item_type: extractLabelled(notes, 'Item Type'),
  originapp: extractLabelled(notes, 'Origin App'),
  servicelinevalue: extractLabelled(notes, 'Service Line Value'),
  pickup_date: extractLabelled(notes, 'Pickup Date'),
  brand: parsed.brand,
  color: parsed.color,
  full_name: parsed.fullName,
  shoe_size: parsed.size ?? extractSizeFromNotes(notes),
  notes: notes.length > 0 ? notes : null,
  stain_details: extractLabelled(notes, 'Stain Details'),
  damage_details: extractLabelled(notes, 'Damage Details'),
  customer_instructions: extractCustomerInstructions(notes),
  email: extractLabelled(notes, 'Customer Email'),
  tel: extractLabelled(notes, 'Customer Phone'),
  tray_number: parsed.trayNumber ?? extractLabelled(notes, 'Tray Number'),
  item_code: itemCode,
  before_images_links: beforeImages,
  other_images_links: otherImages,
};

const outbound = {
  source: 'asana',
  task_gid: taskGid,
  ASANA: task.permalink_url ?? null,
  permalink: task.permalink_url ?? null,
  fired_at: new Date().toISOString(),
  trigger: { field: TRIGGER_FIELD_NAME, value: TRIGGER_FIELD_VALUE },
  ...fields,
};

console.log(JSON.stringify(outbound, null, 2));
