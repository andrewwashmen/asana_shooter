#!/usr/bin/env node
/* eslint-disable no-console */
import { argv, env, exit } from 'node:process';

const ASANA_PAT = env.ASANA_PAT;
const webhookGid = argv[2];

if (!ASANA_PAT || !webhookGid) {
  console.error('Usage: ASANA_PAT=... node scripts/delete-webhook.mjs <webhook_gid>');
  exit(1);
}

const res = await fetch(`https://app.asana.com/api/1.0/webhooks/${encodeURIComponent(webhookGid)}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${ASANA_PAT}` },
});

console.log(`HTTP ${res.status}`);
console.log(await res.text());
if (!res.ok) exit(1);
