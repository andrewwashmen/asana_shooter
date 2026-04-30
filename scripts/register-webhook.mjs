#!/usr/bin/env node
/* eslint-disable no-console */
import { argv, env, exit } from 'node:process';

const ASANA_PAT = env.ASANA_PAT;
const projectGid = argv[2] ?? env.ASANA_PROJECT_GID ?? '1202289964354061';
const targetUrl = argv[3] ?? env.WORKER_TARGET_URL;

if (!ASANA_PAT) {
  console.error('Missing ASANA_PAT env var.');
  console.error('Usage: ASANA_PAT=... node scripts/register-webhook.mjs <project_gid> <target_url>');
  exit(1);
}
if (!targetUrl) {
  console.error('Missing target URL.');
  console.error('Usage: ASANA_PAT=... node scripts/register-webhook.mjs <project_gid> <target_url>');
  console.error('Example: ASANA_PAT=... node scripts/register-webhook.mjs 1202289964354061 https://asana-shooter.<acct>.workers.dev/asana-webhook');
  exit(1);
}

const res = await fetch('https://app.asana.com/api/1.0/webhooks', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${ASANA_PAT}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: JSON.stringify({
    data: {
      resource: projectGid,
      target: targetUrl,
      // Pre-filter at the source: we only care about task changes.
      // We still need to inspect the task in the Worker because Asana
      // does not let us filter by custom-field value here.
      filters: [
        { resource_type: 'task', action: 'changed', fields: ['custom_fields'] },
      ],
    },
  }),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
if (!res.ok) exit(1);
