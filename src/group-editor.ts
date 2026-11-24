import type { Button } from './telegram.js'
import { GROUP_LIMIT, type StoredGroup } from './groups.js'

export const PAGE_SIZE = 8
export const EDITOR_TTL_MS = 10 * 60_000
const LABEL_MAX = 34

/**
 * In-memory state of one admin's "Ganti grup" session. Telegram callback data is capped at
 * 64 bytes, so buttons carry list positions instead of WhatsApp JIDs.
 */
export type GroupEditor = {
  tenantId: string
  tenantName: string
  groups: StoredGroup[]
  selected: Set<string>
  page: number
  query: string
  /** Group limit of the tenant's plan. */
  limit: number
  at: number
}

export function newEditor(tenantId: string, tenantName: string, groups: StoredGroup[], now = Date.now(), limit = GROUP_LIMIT): GroupEditor {
  return {
    tenantId,
    tenantName,
    groups,
    selected: new Set(groups.filter((group) => group.selected).map((group) => group.jid)),
    page: 0,
    query: '',
    limit,
    at: now,
  }
}

export function isExpired(editor: GroupEditor, now = Date.now()): boolean {
  return now - editor.at > EDITOR_TTL_MS
}

function visible(editor: GroupEditor): Array<{ group: StoredGroup; index: number }> {
  const query = editor.query.toLowerCase()
  return editor.groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => !query || group.subject.toLowerCase().includes(query))
}

function pageCount(editor: GroupEditor): number {
  return Math.max(1, Math.ceil(visible(editor).length / PAGE_SIZE))
}

export function setPage(editor: GroupEditor, page: number): void {
  editor.page = Math.min(Math.max(0, Math.trunc(page) || 0), pageCount(editor) - 1)
}

export function setQuery(editor: GroupEditor, query: string): void {
  editor.query = query.replace(/\s+/g, ' ').trim().slice(0, 40)
  editor.page = 0
}

export type ToggleResult = 'selected' | 'unselected' | 'limit' | 'missing'

export function toggleGroup(editor: GroupEditor, index: number): ToggleResult {
  const group = editor.groups[index]
  if (!group) return 'missing'
  if (editor.selected.has(group.jid)) {
    editor.selected.delete(group.jid)
    return 'unselected'
  }
  if (editor.selected.size >= editor.limit) return 'limit'
  editor.selected.add(group.jid)
  return 'selected'
}

function label(group: StoredGroup): string {
  const name = group.subject.replace(/\s+/g, ' ').trim() || '(tanpa nama)'
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name
}

export function renderEditor(editor: GroupEditor, notice?: string): { text: string; keyboard: Button[][] } {
  const matches = visible(editor)
  const pages = pageCount(editor)
  const page = Math.min(editor.page, pages - 1)
  const shown = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const lines = [
    `🗂 Ganti grup — ${editor.tenantName}`,
    `Dipilih: ${editor.selected.size}/${editor.limit}`,
    ...(editor.query ? [`Cari: "${editor.query}" (${matches.length} cocok)`] : []),
    ...(pages > 1 ? [`Halaman ${page + 1}/${pages}`] : []),
    ...(editor.groups.length === 0 ? ['Tidak ada grup ditemukan di akun WhatsApp ini.'] : []),
    ...(editor.groups.length > 0 && matches.length === 0 ? ['Tidak ada grup yang cocok.'] : []),
    ...(notice ? ['', notice] : []),
  ]

  const keyboard: Button[][] = shown.map(({ group, index }) => [
    { text: `${editor.selected.has(group.jid) ? '☑' : '☐'} ${label(group)}`, callback_data: `gt:${index}` },
  ])
  if (pages > 1) {
    keyboard.push([
      { text: '◀', callback_data: `gp:${Math.max(0, page - 1)}` },
      { text: `${page + 1}/${pages}`, callback_data: `gp:${page}` },
      { text: '▶', callback_data: `gp:${Math.min(pages - 1, page + 1)}` },
    ])
  }
  keyboard.push([
    { text: '🔎 Search', callback_data: 'gq' },
    ...(editor.query ? [{ text: '✖ Clear search', callback_data: 'gc' }] : []),
  ])
  keyboard.push([
    { text: '💾 Save', callback_data: 'gs' },
    { text: 'Cancel', callback_data: 'gx' },
  ])
  return { text: lines.join('\n'), keyboard }
}
