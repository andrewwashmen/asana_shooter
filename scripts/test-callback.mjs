#!/usr/bin/env node
/* eslint-disable no-console */
//
// Test the /lovable-callback endpoint without going through Lovable.
// Exercises the same auth + payload contract Lovable's edge function must use.
//
// Usage:
//   CALLBACK_SECRET=<secret> node scripts/test-callback.mjs <task_gid> <approval_url>
//
// Defaults (handy for local smoke tests):
//   task_gid     -> 1214429954181947                       (override with arg 1)
//   approval_url -> https://service-wizard-kit.lovable.app/approved/test-<timestamp>
//   target       -> https://asana-shooter.washmen-egolf.workers.dev/lovable-callback
//                   (override with CALLBACK_URL env var)
import { argv, env, exit } from 'node:process';
import { randomUUID } from 'node:crypto';

const CALLBACK_SECRET = env.CALLBACK_SECRET;
const target = env.CALLBACK_URL ?? 'https://asana-shooter.washmen-egolf.workers.dev/lovable-callback';
const taskGid = argv[2] ?? '1214429954181947';
const approvalUrl =
  argv[3] ??
  `https://service-wizard-kit.lovable.app/approved/${randomUUID()}`;

if (!CALLBACK_SECRET) {
  console.error('Missing CALLBACK_SECRET env var.');
  console.error('Usage: CALLBACK_SECRET=<secret> node scripts/test-callback.mjs <task_gid> <approval_url>');
  exit(1);
}

const body = JSON.stringify({ task_gid: taskGid, approval_url: approvalUrl });

console.log(`POST ${target}`);
console.log(`  task_gid:     ${taskGid}`);
console.log(`  approval_url: ${approvalUrl}`);
console.log('');

const start = Date.now();
const res = await fetch(target, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${CALLBACK_SECRET}`,
    'Content-Type': 'application/json',
  },
  body,
});
const elapsed = Date.now() - start;

const text = await res.text();
console.log(`HTTP ${res.status} (${elapsed}ms)`);
if (text) console.log(text);

// Hint on common failure modes
if (res.status === 401) {
  console.error('\nHint: 401 means the secret is wrong or missing. Check the Authorization header.');
  exit(1);
}
if (res.status === 400) {
  console.error('\nHint: 400 means the body is malformed. Confirm task_gid is digits and approval_url is https.');
  exit(1);
}
if (res.status >= 500) {
  console.error('\nHint: 5xx means the Worker crashed. Check Cloudflare Worker logs.');
  exit(1);
}
if (res.status !== 202) {
  console.error(`\nHint: expected 202, got ${res.status}.`);
  exit(1);
}

console.log(`\n✅ Accepted. The Worker will append the line to task ${taskGid} in Asana.`);
