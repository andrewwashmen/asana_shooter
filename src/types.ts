export interface Env {
  STATE: KVNamespace;
  PHOTOS: R2Bucket;
  ASANA_PAT: string;
  DESTINATION_WEBHOOK_URL: string;
  ASANA_PROJECT_GID: string;
  TRIGGER_FIELD_NAME: string;
  TRIGGER_FIELD_VALUE: string;
  R2_PUBLIC_BASE_URL: string;
  CALLBACK_SECRET: string;
}

export interface AsanaEvent {
  user?: { gid: string; resource_type: string } | null;
  created_at?: string;
  action?: string;
  resource?: { gid: string; resource_type: string } | null;
  parent?: { gid: string; resource_type: string } | null;
  change?: {
    field?: string;
    action?: string;
    new_value?: unknown;
    added_value?: unknown;
    removed_value?: unknown;
  } | null;
}

export interface AsanaWebhookPayload {
  events?: AsanaEvent[];
}

export interface AsanaCustomField {
  gid: string;
  name?: string;
  resource_subtype?: string;
  display_value?: string | null;
  text_value?: string | null;
  number_value?: number | null;
  enum_value?: { gid: string; name?: string } | null;
  multi_enum_values?: Array<{ gid: string; name?: string }> | null;
  date_value?: { date?: string; date_time?: string } | null;
  people_value?: Array<{ gid: string; name?: string }> | null;
}

export interface AsanaTask {
  gid: string;
  name?: string;
  notes?: string;
  html_notes?: string;
  permalink_url?: string;
  resource_subtype?: string;
  completed?: boolean;
  custom_fields?: AsanaCustomField[];
}

export interface AsanaAttachment {
  gid: string;
  name?: string;
  host?: string;
  resource_subtype?: string;
  size?: number;
  created_at?: string;
  created_by?: { gid: string; name?: string; email?: string } | null;
  download_url?: string | null;
  view_url?: string | null;
  permanent_url?: string | null;
  parent?: { gid: string; name?: string } | null;
}

export interface RehostedAttachment extends AsanaAttachment {
  rehosted_url: string | null;
  rehost_error: string | null;
  r2_key: string | null;
}

export interface CustomerInstructions {
  notes: string | null;
  callback_status: string | null;
  images: string | null;
}

export interface OutboundFields {
  geofence: string | null;
  order_id: string | null;
  customer_alpha_id: string | null;
  item_type: string | null;
  originapp: string | null;
  servicelinevalue: string | null;
  pickup_date: string | null;
  brand: string | null;
  color: string | null;
  full_name: string | null;
  shoe_size: string | null;
  notes: string | null;
  stain_details: string | null;
  damage_details: string | null;
  customer_instructions: CustomerInstructions;
  email: string | null;
  tel: string | null;
  tray_number: string | null;
  item_code: string | null;
  before_images_links: string[];
  other_images_links: string[];
}

export type OutboundPayload = OutboundFields & {
  source: 'asana';
  task_gid: string;
  ASANA: string | null;
  permalink: string | null;
  fired_at: string;
  trigger: { field: string; value: string };
  order_id: string | null;
};
