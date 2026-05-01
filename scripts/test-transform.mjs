#!/usr/bin/env node
/* eslint-disable no-console */
// Standalone smoke test for the transform logic. Mirrors src/transform.ts so
// we can validate against sample-payload.json without spinning up wrangler.
import { readFile } from 'node:fs/promises';

const TRAY_RE = /^\s*Tray:\s*(\d+)/i;
const GEOFENCE_RE = /\[([^\]]+)\]/;
const AFTER_GEOFENCE_RE = /\]\s*(.+)$/;
const SIZE_RE = /^Size:\s*(.+)$/i;
const NONE_VALUES = new Set(['', 'none', 'n/a', 'null', '-']);

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
  const m = notes.match(re);
  return clean(m?.[1]);
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
  const sizeMatch = parts[5]?.match(SIZE_RE);
  const size = clean(sizeMatch?.[1]);
  return { trayNumber, geofence, orderId, brand, fullName, color, size };
}

function splitAttachments(attachments) {
  const sorted = [...attachments].sort((a, b) =>
    (a.created_at ?? '').localeCompare(b.created_at ?? ''),
  );
  const beforeImages = sorted
    .filter((a) => a.name?.startsWith('BEFORE-'))
    .map((a) => a.permanent_url ?? a.download_url)
    .filter(Boolean);
  const otherImages = sorted
    .filter((a) => !a.name?.startsWith('BEFORE-'))
    .map((a) => a.permanent_url ?? a.download_url)
    .filter(Boolean);
  return { beforeImages, otherImages };
}

const raw = await readFile(new URL('../sample-payload.json', import.meta.url), 'utf8');
const sample = JSON.parse(raw);
const task = sample.task;
const attachments = sample.attachments;
const parsed = parseTaskName(task.name);

function extractDashItem(block, label) {
  const re = new RegExp(`-\\s*${escapeRegExp(label)}:\\s*([^\\n]+)`, 'i');
  return clean(block.match(re)?.[1]);
}

function extractCustomerInstructions(notes) {
  const empty = { notes: null, callback_status: null, images: null };
  if (!notes) return empty;
  const blockRe = /Customer Instructions:\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*[A-Z][\w ]+:\s*\n|$)/i;
  const block = notes.match(blockRe)?.[1];
  if (!block) return empty;
  return {
    notes: extractDashItem(block, 'Notes'),
    callback_status: extractDashItem(block, 'Callback Status'),
    images: extractDashItem(block, 'Images'),
  };
}

const orderId = parsed.orderId ?? extractLabelled(task.notes, 'Order Alpha ID');
const itemCode = extractLabelled(task.notes, 'Item Code');

const result = {
  source: 'asana',
  task_gid: task.gid,
  permalink: task.permalink_url ?? null,
  fired_at: new Date().toISOString(),
  trigger: { field: 'Assessment System', value: 'New' },
  order_id: orderId,
  customer_alpha_id: extractLabelled(task.notes, 'Customer Alpha ID'),
  item_type: extractLabelled(task.notes, 'Item Type'),
  originapp: extractLabelled(task.notes, 'Origin App'),
  servicelinevalue: extractLabelled(task.notes, 'Service Line Value'),
  geofence: parsed.geofence,
  pickup_date: extractLabelled(task.notes, 'Pickup Date'),
  brand: parsed.brand,
  color: parsed.color,
  full_name: parsed.fullName,
  shoe_size: parsed.size,
  notes: task.notes ?? null,
  stain_details: extractLabelled(task.notes, 'Stain Details'),
  damage_details: extractLabelled(task.notes, 'Damage Details'),
  customer_instructions: extractCustomerInstructions(task.notes),
  email: extractLabelled(task.notes, 'Customer Email'),
  tel: extractLabelled(task.notes, 'Customer Phone'),
  tray_number: parsed.trayNumber ?? extractLabelled(task.notes, 'Tray Number'),
  item_code: itemCode,
  ...(() => {
    const { beforeImages, otherImages } = splitAttachments(attachments);
    return { before_images_links: beforeImages, other_images_links: otherImages };
  })(),
};

console.log(JSON.stringify(result, null, 2));
