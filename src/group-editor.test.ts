import { describe, expect, it } from 'vitest'
import { EDITOR_TTL_MS, PAGE_SIZE, isExpired, newEditor, renderEditor, setPage, setQuery, toggleGroup } from './group-editor.js'
import type { StoredGroup } from './groups.js'

const make = (count: number, selected: number[] = []): StoredGroup[] =>
  Array.from({ length: count }, (_, i) => ({
    jid: `g${i}@g.us`,
    subject: `Proyek ${i}`,
    participants: i + 2,
    selected: selected.includes(i),
  }))

const texts = (editor: ReturnType<typeof newEditor>) =>
  renderEditor(editor).keyboard.flat().map((button) => button.text)

describe('group editor', () => {
  it('starts from the stored selection', () => {
    const editor = newEditor('t1', 'Studio', make(3, [1]))
    expect([...editor.selected]).toEqual(['g1@g.us'])
    expect(texts(editor).slice(0, 3)).toEqual(['☐ Proyek 0', '☑ Proyek 1', '☐ Proyek 2'])
  })

  it('stops at the limit and lets a group be released again', () => {
    const editor = newEditor('t1', 'Studio', make(7, [0, 1, 2, 3, 4]))
    expect(toggleGroup(editor, 5)).toBe('limit')
    expect(editor.selected.size).toBe(5)
    expect(toggleGroup(editor, 0)).toBe('unselected')
    expect(toggleGroup(editor, 5)).toBe('selected')
    expect(toggleGroup(editor, 99)).toBe('missing')
  })

  it('pages the list and clamps out-of-range pages', () => {
    const editor = newEditor('t1', 'Studio', make(PAGE_SIZE + 3))
    expect(renderEditor(editor).text).toContain('Halaman 1/2')
    setPage(editor, 5)
    expect(editor.page).toBe(1)
    expect(texts(editor).filter((text) => text.startsWith('☐'))).toHaveLength(3)
    setPage(editor, -3)
    expect(editor.page).toBe(0)
  })

  it('keeps the original list positions while filtering', () => {
    const editor = newEditor('t1', 'Studio', make(12))
    setQuery(editor, 'proyek 11')
    const { keyboard, text } = renderEditor(editor)
    expect(text).toContain('1 cocok')
    expect(keyboard[0]).toEqual([{ text: '☐ Proyek 11', callback_data: 'gt:11' }])
    expect(keyboard.flat().map((b) => b.callback_data)).toContain('gc')
  })

  it('says so when nothing matches or the account has no groups', () => {
    const editor = newEditor('t1', 'Studio', make(2))
    setQuery(editor, 'zzz')
    expect(renderEditor(editor).text).toContain('Tidak ada grup yang cocok')
    expect(renderEditor(newEditor('t1', 'Studio', [])).text).toContain('Tidak ada grup ditemukan')
  })

  it('truncates long names and keeps every callback within Telegram\'s 64 byte limit', () => {
    const groups = make(PAGE_SIZE)
    groups[0]!.subject = 'A'.repeat(120)
    const editor = newEditor('t1', 'Studio', groups)
    const { keyboard } = renderEditor(editor)
    expect(keyboard[0]![0]!.text.length).toBeLessThanOrEqual(36)
    for (const button of keyboard.flat()) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
  })

  it('expires after the idle limit', () => {
    const editor = newEditor('t1', 'Studio', make(1), 1_000)
    expect(isExpired(editor, 1_000 + EDITOR_TTL_MS)).toBe(false)
    expect(isExpired(editor, 1_001 + EDITOR_TTL_MS)).toBe(true)
  })
})
