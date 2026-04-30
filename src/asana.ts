import type { AsanaAttachment, AsanaTask, Env } from './types';

const ASANA_BASE = 'https://app.asana.com/api/1.0';

const TASK_OPT_FIELDS = [
  'name',
  'notes',
  'html_notes',
  'completed',
  'completed_at',
  'completed_by.name',
  'completed_by.email',
  'created_at',
  'created_by.name',
  'modified_at',
  'due_on',
  'due_at',
  'start_on',
  'start_at',
  'assignee.name',
  'assignee.email',
  'assignee_status',
  'parent.name',
  'projects.name',
  'memberships.project.name',
  'memberships.section.name',
  'tags.name',
  'workspace.name',
  'custom_fields.name',
  'custom_fields.display_value',
  'custom_fields.text_value',
  'custom_fields.number_value',
  'custom_fields.enum_value.name',
  'custom_fields.multi_enum_values.name',
  'custom_fields.date_value',
  'custom_fields.people_value.name',
  'custom_fields.resource_subtype',
  'num_subtasks',
  'permalink_url',
  'resource_subtype',
  'followers.name',
  'followers.email',
  'liked',
  'num_likes',
  'num_hearts',
  'dependencies',
  'dependents',
  'actual_time_minutes',
].join(',');

const ATTACHMENT_OPT_FIELDS = [
  'name',
  'resource_subtype',
  'host',
  'size',
  'created_at',
  'created_by.name',
  'created_by.email',
  'download_url',
  'view_url',
  'permanent_url',
  'parent.name',
].join(',');

export async function fetchTask(taskGid: string, env: Env): Promise<AsanaTask> {
  const url = `${ASANA_BASE}/tasks/${encodeURIComponent(taskGid)}?opt_fields=${TASK_OPT_FIELDS}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.ASANA_PAT}` },
  });
  if (!res.ok) {
    throw new Error(`Asana fetchTask ${taskGid} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { data: AsanaTask };
  return data.data;
}

export async function fetchTaskNotes(taskGid: string, env: Env): Promise<string> {
  const url = `${ASANA_BASE}/tasks/${encodeURIComponent(taskGid)}?opt_fields=notes`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.ASANA_PAT}` },
  });
  if (!res.ok) {
    throw new Error(`Asana fetchTaskNotes ${taskGid} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { data: { notes?: string } };
  return data.data.notes ?? '';
}

export async function updateTaskNotes(
  taskGid: string,
  notes: string,
  env: Env,
): Promise<void> {
  const url = `${ASANA_BASE}/tasks/${encodeURIComponent(taskGid)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.ASANA_PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ data: { notes } }),
  });
  if (!res.ok) {
    throw new Error(`Asana updateTaskNotes ${taskGid} failed: ${res.status} ${await res.text()}`);
  }
}

export async function listAttachments(taskGid: string, env: Env): Promise<AsanaAttachment[]> {
  const all: AsanaAttachment[] = [];
  let offset: string | null = null;
  do {
    const params = new URLSearchParams({
      parent: taskGid,
      opt_fields: ATTACHMENT_OPT_FIELDS,
      limit: '100',
    });
    if (offset) params.set('offset', offset);

    const res = await fetch(`${ASANA_BASE}/attachments?${params}`, {
      headers: { Authorization: `Bearer ${env.ASANA_PAT}` },
    });
    if (!res.ok) {
      throw new Error(`Asana listAttachments ${taskGid} failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data: AsanaAttachment[]; next_page?: { offset: string } | null };
    all.push(...body.data);
    offset = body.next_page?.offset ?? null;
  } while (offset);
  return all;
}
