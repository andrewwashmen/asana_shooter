import type {
  AsanaTask,
  CustomerInstructions,
  OutboundFields,
  RehostedAttachment,
} from './types';

// Task name template (Washmen Bot):
//   "Tray: 3088 || [JLT + Gardens] CVZ439 - Louis Vuitton - 1/1 - Malicah Eissa - Beige/Light Purple/White - Size: Check Attachments  - Bag Number: 1/1 [STORE]"
//
// Segments after the "[geofence] " prefix, split on " - ":
//   [0] order id, [1] brand, [2] bag number (e.g. "1/1"), [3] full name,
//   [4] color, [5] "Size: <value>", [6] "Bag Number: ... [STORE]"
const TRAY_RE = /^\s*Tray:\s*(\d+)/i;
const GEOFENCE_RE = /\[([^\]]+)\]/;
const AFTER_GEOFENCE_RE = /\]\s*(.+)$/;
const SIZE_RE = /^Size:\s*(.+)$/i;

const NONE_VALUES = new Set(['', 'none', 'n/a', 'null', 'undefined', '-']);

export function buildOutboundFields(
  task: AsanaTask,
  rehostedAttachments: RehostedAttachment[],
): OutboundFields {
  const name = task.name ?? '';
  const notes = task.notes ?? '';
  const parsedName = parseTaskName(name);
  const { beforeImages, otherImages } = splitAttachments(rehostedAttachments);

  return {
    geofence: parsedName.geofence,
    order_id: parsedName.orderId ?? extractLabelled(notes, 'Order Alpha ID'),
    customer_alpha_id: extractLabelled(notes, 'Customer Alpha ID'),
    item_type: extractLabelled(notes, 'Item Type'),
    originapp: extractLabelled(notes, 'Origin App'),
    servicelinevalue: extractLabelled(notes, 'Service Line Value'),
    pickup_date: extractLabelled(notes, 'Pickup Date'),
    brand: parsedName.brand,
    color: parsedName.color,
    full_name: parsedName.fullName,
    shoe_size: parsedName.size ?? extractSizeFromNotes(notes),
    notes: notes.length > 0 ? notes : null,
    stain_details: extractLabelled(notes, 'Stain Details'),
    damage_details: extractLabelled(notes, 'Damage Details'),
    customer_instructions: extractCustomerInstructions(notes),
    email: extractLabelled(notes, 'Customer Email'),
    tel: extractLabelled(notes, 'Customer Phone'),
    tray_number: parsedName.trayNumber ?? extractLabelled(notes, 'Tray Number'),
    item_code: extractLabelled(notes, 'Item Code'),
    before_images_links: beforeImages,
    other_images_links: otherImages,
  };
}

function extractCustomerInstructions(notes: string): CustomerInstructions {
  const empty: CustomerInstructions = { notes: null, callback_status: null, images: null };
  if (!notes) return empty;

  // Capture the "Customer Instructions:" block — runs until the next blank
  // line or the next "Label:" header.
  const blockRe = /Customer Instructions:\s*\n([\s\S]*?)(?=\n\s*\n|\n\s*[A-Z][\w ]+:\s*\n|$)/i;
  const block = notes.match(blockRe)?.[1];
  if (!block) return empty;

  return {
    notes: extractDashItem(block, 'Notes'),
    callback_status: extractDashItem(block, 'Callback Status'),
    images: extractDashItem(block, 'Images'),
  };
}

function extractSizeFromNotes(notes: string): string | null {
  const raw = extractLabelled(notes, 'Size');
  if (!raw) return null;
  // Some upstream versions write "Size:\n  Size: Check Attachments" (label duplicated
  // inside the value). Strip the redundant prefix so we don't ship "Size: …" downstream.
  const m = raw.match(SIZE_RE);
  return clean(m ? m[1] : raw);
}

function extractDashItem(block: string, label: string): string | null {
  const re = new RegExp(`-\\s*${escapeRegExp(label)}:\\s*([^\\n]+)`, 'i');
  return clean(block.match(re)?.[1]);
}

interface ParsedTaskName {
  trayNumber: string | null;
  geofence: string | null;
  orderId: string | null;
  brand: string | null;
  fullName: string | null;
  color: string | null;
  size: string | null;
}

function parseTaskName(name: string): ParsedTaskName {
  const trayNumber = name.match(TRAY_RE)?.[1] ?? null;
  const geofence = name.match(GEOFENCE_RE)?.[1]?.trim() ?? null;

  const after = name.match(AFTER_GEOFENCE_RE)?.[1] ?? '';
  const parts = after
    .split(/\s+-\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const orderId = clean(parts[0]);
  const brand = clean(parts[1]);
  const fullName = clean(parts[3]);
  const color = clean(parts[4]);
  // Segment 5 may be "Size: 44 EU" OR just "44 EU" depending on the upstream version.
  const sizeRaw = parts[5];
  const sizeMatch = sizeRaw?.match(SIZE_RE);
  const size = clean(sizeMatch ? sizeMatch[1] : sizeRaw);

  return { trayNumber, geofence, orderId, brand, fullName, color, size };
}

function clean(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (NONE_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function extractLabelled(notes: string, label: string): string | null {
  if (!notes) return null;
  // Notes use a "Label:\n  Value" pattern with optional indentation.
  const re = new RegExp(`${escapeRegExp(label)}:\\s*\\n\\s*([^\\n]+)`, 'i');
  const m = notes.match(re);
  return clean(m?.[1]);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitAttachments(attachments: RehostedAttachment[]): {
  beforeImages: string[];
  otherImages: string[];
} {
  const successful = attachments.filter(
    (a): a is RehostedAttachment & { rehosted_url: string } =>
      typeof a.rehosted_url === 'string',
  );
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
