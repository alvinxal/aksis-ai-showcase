// Client for the backend JSON API (/v1). The session is an httpOnly cookie set by /join/<token>,
// so nothing here touches tokens. Keep OnboardingState in sync with src/onboarding.ts.

export type Group = { jid: string; subject: string; participants: number | null; selected: boolean }

export type OnboardingState = {
  step: 'profile' | 'whatsapp' | 'pairing' | 'plan' | 'groups' | 'done'
  tenantName: string
  contactName: string | null
  pairing: { connection: string; qr: string | null; pairingCode: string | null } | null
  groups: { items: Group[]; limit: number; loadFailed: boolean } | null
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'error', data.message)
  return data as T
}

/** The admin dashboard (it changes access requests, customers and admins). Everything answers 401 without the cookie made by the login link of the Telegram bot. */
export type DashOverview = {
  customers: Record<string, number>
  newRequests: number
  costUsd: { today: number; month: number }
  monthlyRecurringIdr: number
  attention: Array<{ tenantId: string; name: string; kind: string; detail: string }>
  failedRuns: Array<{ at: string; customer: string; error: string }>
  blocked: Array<{ tenantId: string; tenantName: string; messages: number }>
}
export type DashCustomer = {
  id: string
  name: string
  status: string
  createdAt: string
  plan: string | null
  planCode: string | null
  subscription: string
  endsAt: string | null
  deletionOn: string | null
  whatsapp: string | null
  groups: number
  contacts: number
  messages: number
  paused: boolean
  notes: string | null
  acceptedTerms: boolean
  costUsd: { today: number; month: number }
  limitUsd: { daily: number | null; monthly: number | null }
}
export type DashUsage = {
  days: number
  series: Array<{ day: string; runs: number; failed: number; costUsd: number }>
  byKind: Array<{ kind: string; runs: number; costUsd: number }>
  byCustomer: Array<{ customer: string; runs: number; costUsd: number }>
}
export type DashRequest = { id: string; name: string; phone: string; status: string; createdAt: string }
export type DashAdmin = { telegramId: number; owner: boolean; addedBy: number | null; addedAt: string | null }
export type DashInvite = { name: string; phone: string | null; tenantId: string; link: string; expiresAt: string }
export type DashChoices = { plans: Array<{ code: string; name: string }>; allPlans: Array<{ code: string; name: string }>; choices: { months: number[]; dailyUsd: number[]; monthlyUsd: number[] } }
export type DashFeature = { failures: number; successes: number }
export type DashHealth = {
  at: string
  database: string
  agent: boolean | null
  system: { connection: string; paired: boolean } | null
  whatsapp: Array<{ customer: string; connection: string }>
  lastHour: { chat: DashFeature; summary: DashFeature; push: DashFeature }
  uptimeSeconds: number
}
export type DashAudit = { at: string; actor: number | null; action: string; customer: string | null; detail: Record<string, string | number | boolean> }

export const dashboardApi = {
  login: (token: string) => call<{ ok: true }>('POST', '/v1/dashboard/login', { token }),
  logout: () => call<{ ok: true }>('POST', '/v1/dashboard/logout', {}),
  me: () => call<{ ok: true }>('GET', '/v1/dashboard/me'),
  overview: () => call<DashOverview>('GET', '/v1/dashboard/overview'),
  customers: () => call<{ customers: DashCustomer[]; autoDelete: boolean } & DashChoices>('GET', '/v1/dashboard/customers'),
  usage: (days: number) => call<DashUsage>('GET', `/v1/dashboard/usage?days=${days}`),
  requests: () => call<{ requests: DashRequest[] }>('GET', '/v1/dashboard/requests').then((value) => value.requests),
  health: () => call<DashHealth>('GET', '/v1/dashboard/health'),
  admins: () => call<{ admins: DashAdmin[]; canManage: boolean }>('GET', '/v1/dashboard/admins'),
  addAdmin: (telegramId: string) => call<{ ok: true }>('POST', '/v1/dashboard/admins', { telegramId }),
  removeAdmin: (telegramId: number) => call<{ ok: true }>('POST', `/v1/dashboard/admins/${telegramId}/remove`, {}),
  createCustomer: (input: { name: string; phone: string }) => call<DashInvite>('POST', '/v1/dashboard/customers', input),
  renameCustomer: (id: string, name: string) => call<{ ok: true }>('POST', `/v1/dashboard/customers/${id}/rename`, { name }),
  setNotes: (id: string, notes: string) => call<{ ok: true }>('POST', `/v1/dashboard/customers/${id}/notes`, { notes }),
  setStatus: (id: string, status: 'active' | 'disabled') => call<{ ok: true; accessSent: boolean | null }>('POST', `/v1/dashboard/customers/${id}/status`, { status }),
  setPaused: (id: string, paused: boolean) => call<{ ok: true }>('POST', `/v1/dashboard/customers/${id}/pause`, { paused }),
  setLimit: (id: string, scope: 'daily' | 'monthly', usd: number) => call<{ ok: true }>('POST', `/v1/dashboard/customers/${id}/limits`, { scope, usd }),
  grantPlan: (id: string, plan: string, months: number) => call<{ ok: true; plan: string; endsAt: string }>('POST', `/v1/dashboard/customers/${id}/subscription`, { plan, months }),
  setPlan: (id: string, plan: string, endsOn: string) => call<{ ok: true; plan: string; endsAt: string }>('POST', `/v1/dashboard/customers/${id}/subscription/set`, { plan, endsOn }),
  endPlan: (id: string, plan: string) => call<{ ok: true; plan: string; endsAt: string }>('POST', `/v1/dashboard/customers/${id}/subscription/set`, { plan, endNow: true }),
  repair: (id: string) => call<DashInvite>('POST', `/v1/dashboard/customers/${id}/repair`, {}),
  renewInvitation: (id: string) => call<DashInvite>('POST', `/v1/dashboard/customers/${id}/invitation`, {}),
  deleteCustomer: (id: string, confirmName: string) => call<{ ok: true; messages: number }>('POST', `/v1/dashboard/customers/${id}/delete`, { confirmName }),
  markContacted: (id: string) => call<{ ok: true }>('POST', `/v1/dashboard/requests/${id}/contacted`, {}),
  reject: (id: string) => call<{ ok: true }>('POST', `/v1/dashboard/requests/${id}/reject`, {}),
  invite: (id: string) => call<DashInvite>('POST', `/v1/dashboard/requests/${id}/invite`, {}),
  audit: () => call<{ entries: DashAudit[] }>('GET', '/v1/dashboard/audit').then((value) => value.entries),
}

/** The public request-access form on the landing page. */
export const leadApi = {
  submit: (input: { name: string; phone: string; terms: boolean; website: string }) => call<{ ok: true }>('POST', '/v1/leads', input),
}

export type Me = { tenantName: string; contactName: string | null }

/** Login to the installed app: a code that arrives in the customer's own WhatsApp chat. */
export const authApi = {
  /** Always succeeds for a well-formed number, whether or not it belongs to a customer. */
  requestCode: (phone: string) => call<{ ok: true; retryAfter?: number }>('POST', '/v1/auth/code', { phone }),
  verify: (phone: string, code: string) => call<{ ok: true }>('POST', '/v1/auth/verify', { phone, code }),
  me: () => call<Me>('GET', '/v1/me'),
  logout: () => call<{ ok: true }>('POST', '/v1/auth/logout', {}),
}

export type ItemType =
  | 'DECISION_DETECTED'
  | 'DECISION_CONFLICT'
  | 'REVISION_REQUESTED'
  | 'TASK_ASSIGNED'
  | 'DEADLINE_DETECTED'
  | 'FOLLOW_UP_REQUIRED'
  | 'PAYMENT_DUE'
  | 'PAYMENT_RECEIVED'
  | 'INVOICE_SENT'
  | 'BUDGET_CHANGE'

// Keep in sync with src/projects.ts.
export type ProjectItem = { id: string; type: ItemType; title: string; occurredAt: string; dueAt: string | null; amount: number | null; sources: number }
export type AttentionItem = ProjectItem & { urgent: boolean }
/** The AI's short status note of a project; null until one has been written. */
export type Note = { text: string; writtenAt: string } | null
export type ProjectSummary = {
  id: string
  name: string
  groups: string[]
  /** Names of the selected personal chats attached to the project. */
  contacts: string[]
  note: Note
  attention: number
  urgent: number
  counts: { decisions: number; revisions: number; tasks: number; payments: number }
  lastActivityAt: string | null
}
export type ProjectDetail = {
  id: string
  name: string
  groups: string[]
  contacts: string[]
  note: Note
  attention: AttentionItem[]
  decisions: ProjectItem[]
  revisions: ProjectItem[]
  tasks: ProjectItem[]
  payments: ProjectItem[]
}

// Personal chats the customer chose to have read. Keep in sync with src/contacts.ts.
export type ContactItem = { id: string; label: string; selected: boolean; projectId: string | null; lastSeenAt: string; lastMessageAt: string | null }
export type ContactsOverview = { limit: number; selectedCount: number; projects: Array<{ id: string; name: string }>; contacts: ContactItem[] }

export const contactsApi = {
  list: (search = '') => call<ContactsOverview>('GET', `/v1/contacts${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  /** Chooses or drops a contact. Aksis finds the project of each message itself. */
  set: (id: string, selected: boolean) => call<{ ok: true }>('PUT', `/v1/contacts/${encodeURIComponent(id)}`, { selected }),
}

// Keep in sync with src/groups-routes.ts.
export type GroupItem = { id: string; name: string; members: number | null; selected: boolean }
export type GroupsOverview = { limit: number; groups: GroupItem[] }

export const groupsApi = {
  list: () => call<GroupsOverview>('GET', '/v1/groups'),
  /** Replaces the groups that are read. */
  save: (groups: string[]) => call<{ ok: true; count: number }>('PUT', '/v1/groups', { groups }),
}

export const pushApi = {
  key: () => call<{ publicKey: string }>('GET', '/v1/push/key').then((value) => value.publicKey),
  subscribe: (endpoint: string, p256dh: string, auth: string) => call<{ ok: true }>('POST', '/v1/push/subscribe', { endpoint, keys: { p256dh, auth } }),
  unsubscribe: (endpoint: string) => call<{ ok: true }>('POST', '/v1/push/unsubscribe', { endpoint }),
}

export const projectsApi = {
  list: () => call<{ projects: ProjectSummary[] }>('GET', '/v1/projects').then((value) => value.projects),
  /** Asks the server to write missing project notes in the background; the answer does not wait for them. */
  refresh: () => call<{ started: boolean }>('POST', '/v1/projects/refresh', {}),
  get: (id: string) => call<ProjectDetail>('GET', `/v1/projects/${encodeURIComponent(id)}`),
}

export type ConnectionOverview = { enabled: boolean; connection: string; lastMessageAt: string | null; lastError: string | null }
export type BillingOverview = {
  subscription: { planCode: string; planName: string; groupLimit: number; endsAt: string; status: string } | null
  plans: Array<{ code: string; name: string; groupLimit: number; priceIdr: number }>
  latestRequest: { id: string; planCode: string; months: number; amountIdr: number; status: string; createdAt: string } | null
}
export type AgendaItem = {
  id: string; projectId: string; project: string; type: string; title: string; dueAt: string; amount: number | null
  status: 'open' | 'done' | 'snoozed'; snoozedUntil: string | null
}
export type SearchItem = {
  id: string; projectId: string; project: string; type: string; title: string; occurredAt: string; dueAt: string | null; amount: number | null
}
export type WeeklyReport = {
  from: string; to: string
  projects: Array<{ id: string; name: string; decisions: string[]; revisions: string[]; tasks: string[]; payments: string[] }>
}
export type ReminderPreferences = { reminderLeadDays: number; weeklyReportEnabled: boolean }

export const workspaceApi = {
  connection: () => call<ConnectionOverview>('GET', '/v1/workspace/connection'),
  reconnect: () => call<{ ok: true }>('POST', '/v1/workspace/connection/reconnect', {}),
  disconnect: () => call<{ ok: true }>('POST', '/v1/workspace/connection/disconnect', {}),
  billing: () => call<BillingOverview>('GET', '/v1/workspace/billing'),
  requestPayment: (planCode: string, months: number) => call<{ ok: true }>('POST', '/v1/workspace/billing/request', { planCode, months }),
  agenda: () => call<{ items: AgendaItem[] }>('GET', '/v1/workspace/agenda').then((value) => value.items),
  setAction: (id: string, status: AgendaItem['status'], snoozedUntil: string | null = null) =>
    call<{ ok: true }>('PUT', `/v1/workspace/agenda/${encodeURIComponent(id)}`, { status, snoozedUntil }),
  search: (query: string) => call<{ items: SearchItem[] }>('GET', `/v1/workspace/search?q=${encodeURIComponent(query)}`).then((value) => value.items),
  report: () => call<WeeklyReport>('GET', '/v1/workspace/report'),
  preferences: () => call<ReminderPreferences>('GET', '/v1/workspace/preferences'),
  setPreferences: (reminderLeadDays: number, weeklyReportEnabled: boolean) => call<{ ok: true }>('PUT', '/v1/workspace/preferences', { reminderLeadDays, weeklyReportEnabled }),
}

export type ChatMessage = { id: string; role: 'user' | 'agent' | 'divider'; text: string; createdAt: string }

export const chatApi = {
  capabilities: () => call<{ images: boolean }>('GET', '/v1/chat-capabilities'),
  latest: () => call<{ latest: Array<ChatMessage & { agent: string }> }>('GET', '/v1/chat').then((value) => value.latest),
  history: (agent: string) => call<{ messages: ChatMessage[] }>('GET', `/v1/chat/${encodeURIComponent(agent)}`).then((value) => value.messages),
  /** "Chat baru": a divider; null when the thread has nothing to separate. */
  startNew: (agent: string) => call<{ divider: ChatMessage | null }>('POST', `/v1/chat/${encodeURIComponent(agent)}/new`, {}).then((value) => value.divider),
  send: (agent: string, text: string, projectId: string | null, image?: { name: string; type: string; dataUrl: string }) =>
    call<{ reply: ChatMessage }>('POST', `/v1/chat/${encodeURIComponent(agent)}`, { text, ...(projectId ? { projectId } : {}), ...(image ? { image } : {}) }).then((value) => value.reply),
}

export const onboardingApi = {
  /** Spends the invitation link; the page does this, never the GET, so a preview or scanner cannot. */
  join: (token: string) => call<{ ok: true }>('POST', '/v1/join', { token }),
  state: () => call<OnboardingState>('GET', '/v1/onboarding/state'),
  saveProfile: (studio: string, name: string) => call<{ ok: true }>('POST', '/v1/onboarding/profile', { studio, name, terms: true }),
  startQr: () => call<{ result: string }>('POST', '/v1/onboarding/whatsapp/start', {}),
  requestCode: (phone: string) => call<{ ok: true }>('POST', '/v1/onboarding/whatsapp/code', { phone }),
  saveGroups: (groups: string[]) => call<{ ok: true; count: number }>('POST', '/v1/onboarding/groups', { groups }),
}
