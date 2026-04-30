#!/usr/bin/env node
/* eslint-disable no-console */
import { argv, env, exit } from 'node:process';

const ASANA_PAT = env.ASANA_PAT;
const workspaceGid = argv[2] ?? env.ASANA_WORKSPACE_GID ?? '41091308892039';

if (!ASANA_PAT) {
  console.error('Missing ASANA_PAT env var.');
  console.error('Usage: ASANA_PAT=... node scripts/list-webhooks.mjs <workspace_gid>');
  exit(1);
}

const params = new URLSearchParams({
  workspace: workspaceGid,
  opt_fields: 'resource.name,target,active,last_success_at,last_failure_at,last_failure_content,filters',
});

const res = await fetch(`https://app.asana.com/api/1.0/webhooks?${params}`, {
  headers: { Authorization: `Bearer ${ASANA_PAT}` },
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
if (!res.ok) exit(1);
