import {
  fetchTask,
  fetchTaskNotes,
  listAttachments,
  updateTaskNotes,
} from './asana';
import { rehostAttachments } from './rehost';
import { buildItems, buildOutboundFields } from './transform';
import type {
  AsanaEvent,
  AsanaWebhookPayload,
  Env,
  OutboundPayload,
} from './types';

const WEBHOOK_PATH = '/asana-webhook';
const CALLBACK_PATH = '/lovable-callback';
const SECRET_KV_KEY = 'webhook_secret';
const STATE_KEY_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const HMAC_HEX_LENGTH = 64; // SHA-256 produces 32 bytes = 64 hex chars

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      return handleAsanaWebhook(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === CALLBACK_PATH) {
      return handleLovableCallback(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleAsanaWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Asana handshake: an initial POST arrives with X-Hook-Secret. Echo it back
  // as a response header within ~5 seconds to confirm the subscription. Asana
  // re-uses this secret as the HMAC key for every subsequent event.
  //
  // Security note: only persist the secret if KV is empty. Otherwise an
  // attacker could replay the handshake path with a forged secret and hijack
  // signature verification. To re-key (rare), delete the KV entry manually.
  const handshakeSecret = request.headers.get('X-Hook-Secret');
  if (handshakeSecret) {
    const existing = await env.STATE.get(SECRET_KV_KEY);
    if (existing && existing !== handshakeSecret) {
      console.warn('handshake rejected: secret already initialised');
      return new Response('Secret already initialised', { status: 409 });
    }
    if (!existing) {
      await env.STATE.put(SECRET_KV_KEY, handshakeSecret);
    }
    return new Response(null, {
      status: 200,
      headers: { 'X-Hook-Secret': handshakeSecret },
    });
  }

  const signature = request.headers.get('X-Hook-Signature');
  const body = await request.text();

  const secret = await env.STATE.get(SECRET_KV_KEY);
  if (!secret) {
    return new Response('Webhook not initialised: handshake missing', { status: 401 });
  }

  if (!signature || !(await verifyHmac(secret, body, signature))) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: AsanaWebhookPayload;
  try {
    payload = JSON.parse(body) as AsanaWebhookPayload;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const events = payload.events ?? [];

  // Asana retries on non-2xx and treats responses >2s as failures. Acknowledge
  // immediately and process events asynchronously.
  ctx.waitUntil(processEvents(events, env));
  return new Response(null, { status: 200 });
}

async function handleLovableCallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = request.headers.get('Authorization');
  const expected = `Bearer ${env.CALLBACK_SECRET}`;
  if (!auth || !constantTimeStringEqual(auth, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: { task_gid?: unknown; approval_url?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const taskGid = typeof payload.task_gid === 'string' ? payload.task_gid.trim() : '';
  const approvalUrl =
    typeof payload.approval_url === 'string' ? payload.approval_url.trim() : '';

  if (!taskGid || !approvalUrl) {
    return new Response('Missing task_gid or approval_url', { status: 400 });
  }
  if (!/^\d+$/.test(taskGid)) {
    return new Response('Invalid task_gid', { status: 400 });
  }
  try {
    const u = new URL(approvalUrl);
    if (u.protocol !== 'https:') {
      return new Response('approval_url must be https', { status: 400 });
    }
  } catch {
    return new Response('Invalid approval_url', { status: 400 });
  }

  ctx.waitUntil(appendApprovalLink(taskGid, approvalUrl, env));
  return new Response(null, { status: 202 });
}

async function appendApprovalLink(
  taskGid: string,
  approvalUrl: string,
  env: Env,
): Promise<void> {
  try {
    const currentNotes = await fetchTaskNotes(taskGid, env);
    if (currentNotes.includes(approvalUrl)) {
      // Idempotent: Lovable retried, link already present.
      return;
    }
    const newNotes = `${currentNotes}\n\nCustomer approval response: ${approvalUrl}`;
    await updateTaskNotes(taskGid, newNotes, env);
  } catch (err) {
    console.error('appendApprovalLink failed', {
      taskGid,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    });
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyHmac(secret: string, body: string, signatureHex: string): Promise<boolean> {
  // Asana sends lowercase hex; tolerate either case.
  const sig = signatureHex.toLowerCase();
  if (sig.length !== HMAC_HEX_LENGTH || !/^[0-9a-f]+$/.test(sig)) return false;

  const sigBytes = new Uint8Array(HMAC_HEX_LENGTH / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  // crypto.subtle.verify is constant-time per Web Crypto spec.
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}

async function processEvents(events: AsanaEvent[], env: Env): Promise<void> {
  // Dedup task gids — a single webhook delivery often contains multiple events
  // for the same task (e.g. parallel custom_fields + memberships changes).
  const candidateTaskGids = new Set<string>();
  for (const event of events) {
    if (!isCustomFieldChangeOnTask(event)) continue;
    const gid = event.resource?.gid;
    if (gid) candidateTaskGids.add(gid);
  }

  if (candidateTaskGids.size === 0) return;

  const taskGids = Array.from(candidateTaskGids);
  const results = await Promise.allSettled(taskGids.map((gid) => processTask(gid, env)));

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'rejected') {
      const err = result.reason;
      console.error('processTask failed', {
        taskGid: taskGids[i],
        error:
          err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      });
    }
  }
}

function isCustomFieldChangeOnTask(event: AsanaEvent): boolean {
  if (event.action !== 'changed') return false;
  if (event.resource?.resource_type !== 'task') return false;
  if (event.change?.field !== 'custom_fields') return false;
  return true;
}

async function processTask(taskGid: string, env: Env): Promise<void> {
  const task = await fetchTask(taskGid, env);

  const triggerField = task.custom_fields?.find(
    (f) => (f.name ?? '').trim() === env.TRIGGER_FIELD_NAME.trim(),
  );
  // Trim defensively — Asana option names often have trailing whitespace
  // ("New " vs "New") that would otherwise cause spurious comparison misses.
  const currentValue = triggerField?.enum_value?.name?.trim() ?? null;
  const targetValue = env.TRIGGER_FIELD_VALUE.trim();

  // Edge-trigger: only fire on transitions. KV stores the last observed value
  // for the trigger field per task, so toggling the field away and back will
  // re-fire, but ambient changes to other fields will not.
  const stateKey = `task:${taskGid}:${env.TRIGGER_FIELD_NAME.trim()}`;
  const lastValue = await env.STATE.get(stateKey);
  const normalized = currentValue ?? '';

  if (normalized === (lastValue ?? '')) return; // no transition

  // If the transition is to a non-target value, just update state and exit.
  // No downstream side-effect to risk poisoning.
  if (currentValue !== targetValue) {
    await env.STATE.put(stateKey, normalized, { expirationTtl: STATE_KEY_TTL_SECONDS });
    return;
  }

  // Transition to target: do the side-effect work first, then commit state.
  // If the destination POST fails, KV is unchanged and the next event retries.
  const attachments = await listAttachments(taskGid, env);
  const rehosted = await rehostAttachments(attachments, taskGid, env);
  const fields = buildOutboundFields(task, rehosted);
  const items = buildItems(task, fields);

  const outbound: OutboundPayload = {
    source: 'asana',
    task_gid: taskGid,
    ASANA: task.permalink_url ?? null,
    permalink: task.permalink_url ?? null,
    fired_at: new Date().toISOString(),
    trigger: { field: env.TRIGGER_FIELD_NAME, value: env.TRIGGER_FIELD_VALUE },
    items,
    ...fields,
  };

  const res = await fetch(env.DESTINATION_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Source': 'asana-shooter',
      'X-Asana-Task-Gid': taskGid,
      'X-Trigger-Field': env.TRIGGER_FIELD_NAME,
      'X-Trigger-Value': env.TRIGGER_FIELD_VALUE,
    },
    body: JSON.stringify(outbound),
  });

  if (!res.ok) {
    const responseText = await res.text().catch(() => '<unreadable>');
    throw new Error(`destination POST failed ${res.status}: ${responseText.slice(0, 500)}`);
  }

  // Commit only on success, so transient failures get retried on the next event.
  await env.STATE.put(stateKey, normalized, { expirationTtl: STATE_KEY_TTL_SECONDS });
}
