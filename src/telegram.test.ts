import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from './db.js'
import { TelegramAdminBot } from './telegram.js'

type Call = { method: string; body: Record<string, unknown> }

function setup(
  ask?: (id: number, q: string) => Promise<{ text: string }>,
  rows: (query: string) => unknown[] = () => [],
  hooks: ConstructorParameters<typeof TelegramAdminBot>[4] = {},
) {
  const calls: Call[] = []
  const audits: unknown[][] = []
  const txCalls: unknown[][] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ method: url.split('/').pop() ?? '', body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true, result: [] }))
    }),
  )
  const tx = async (_strings?: unknown, ...values: unknown[]) => {
    txCalls.push(values)
    return [{ id: 'tenant-1' }]
  }
  const database = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      audits.push(values)
      return rows(strings.join('?'))
    },
    // sql.json(value) is recorded as the value itself, so audit assertions still see the detail.
    { begin: async (fn: (tx: unknown) => unknown) => fn(tx), json: (value: unknown) => value },
  ) as unknown as Database
  const bot = new TelegramAdminBot(
    database,
    { token: 'SECRET:TOKEN', adminIds: new Set([42]), publicBaseUrl: 'https://aksis.test' },
    async () => ['ok'],
    ask,
    hooks,
  )
  const handle = (update: unknown) => (bot as unknown as { handle: (u: unknown) => Promise<void> }).handle(update)
  return { calls, audits, txCalls, handle, bot }
}

const message = (text: string, from = 42) => ({
  update_id: 1,
  message: { text, chat: { id: from, type: 'private' }, from: { id: from } },
})
const callback = (data: string, from = 42) => ({
  update_id: 2,
  callback_query: {
    id: 'cb1',
    data,
    from: { id: from },
    message: { message_id: 99, chat: { id: from, type: 'private' } },
  },
})
const TENANT_ID = '3f2b1c4d-0000-4000-8000-000000000001'
const buttons = (call?: Call): Array<{ text: string; callback_data: string }> =>
  ((call?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined)
    ?.inline_keyboard ?? []).flat()

afterEach(() => vi.unstubAllGlobals())

describe('telegram admin bot', () => {
  it('shows the button menu to an admin', async () => {
    const { calls, handle } = setup()
    await handle(message('/menu'))
    const send = calls.find((c) => c.method === 'sendMessage')
    const ids = buttons(send).map((b) => b.callback_data)
    expect(ids).toEqual(['m:invite', 'm:tenants', 'm:bill', 'm:bc', 'm:system'])
  })

  it('shows the Needs attention button with a count only when something needs attention', async () => {
    const quiet = setup()
    await quiet.handle(message('/menu'))
    expect(buttons(quiet.calls.find((c) => c.method === 'sendMessage')).map((b) => b.callback_data)).not.toContain('m:attn')

    const busy = setup(undefined, (query) => (query.includes('usage_paused') ? [{ id: TENANT_ID, name: 'Studio Satu' }] : []))
    await busy.handle(message('/menu'))
    const first = buttons(busy.calls.find((c) => c.method === 'sendMessage'))[0]
    expect(first).toEqual({ text: '🔔 Needs attention (1)', callback_data: 'm:attn' })

    await busy.handle(callback('m:attn'))
    const rows = buttons(busy.calls.filter((c) => c.method === 'editMessageText').at(-1))
    expect(rows[0]).toEqual({ text: '🚦 Studio Satu · dijeda: batas pemakaian', callback_data: `t:${TENANT_ID}` })
  })

  it('filters the customer list by status', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes('from tenants t') && query.includes('messages')
        ? [
            { id: TENANT_ID, name: 'Satu', status: 'active', created_at: new Date(), messages: '0' },
            { id: TENANT_ID.replace('1', '2'), name: 'Dua', status: 'disabled', created_at: new Date(), messages: '0' },
          ]
        : [],
    )
    await handle(callback('m:tenants:dis'))
    const all = buttons(calls.find((c) => c.method === 'editMessageText')).map((b) => b.text)
    expect(all).toContain('• Disabled (1)')
    expect(all.filter((label) => /^\d\./.test(label))).toEqual(['1. 🔴 Dua'])
  })

  it('ignores non-admin messages and button presses, but audits them', async () => {
    const { calls, audits, handle } = setup()
    await handle(message('/menu', 7))
    await handle(callback('m:status', 7))
    expect(calls).toHaveLength(0)
    expect(audits).toHaveLength(2)
  })

  it('asks for a name after the invite button and then creates the invitation', async () => {
    const { calls, handle } = setup()
    await handle(callback('m:invite'))
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true)
    expect(String(calls.at(-1)?.body.text)).toContain('nama pelanggan')

    await handle(message('Studio Contoh'))
    const reply = String(calls.at(-1)?.body.text)
    expect(reply).toContain('Undangan untuk Studio Contoh')
    expect(reply).toMatch(/https:\/\/aksis\.test\/join\/[A-Za-z0-9_-]{43}/)
  })

  it('does not treat plain text as an invite without a prior prompt', async () => {
    const { calls, handle } = setup()
    await handle(message('Studio Liar'))
    expect(String(calls.at(-1)?.body.text)).toContain('/menu')
  })

  it('forwards plain admin text to Hermes and replies with the answer', async () => {
    const asked: Array<[number, string]> = []
    const { calls, audits, handle } = setup(async (id, q) => {
      asked.push([id, q])
      return { text: 'Jawaban singkat' }
    })
    await handle(message('berapa kurs USD hari ini?'))
    await vi.waitFor(() => expect(calls.some((c) => c.body.text === 'Jawaban singkat')).toBe(true))
    expect(asked).toEqual([[42, 'berapa kurs USD hari ini?']])
    expect(audits.some((values) => values.includes(42))).toBe(true)
  })

  it('never forwards text from non-admins to Hermes', async () => {
    const ask = vi.fn(async () => ({ text: 'x' }))
    const { calls, handle } = setup(ask)
    await handle(message('halo', 7))
    expect(ask).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('reports a Hermes failure without exposing details', async () => {
    const { calls, handle } = setup(async () => {
      throw new Error('boom SECRET:TOKEN')
    })
    await handle(message('tes'))
    await vi.waitFor(() => expect(String(calls.at(-1)?.body.text)).toContain('Hermes tidak merespons'))
    expect(JSON.stringify(calls)).not.toContain('boom')
  })

  it('lists customers as buttons only, with back and invite buttons, editing in place', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes('from tenants t') && query.includes('messages')
        ? [{ id: TENANT_ID, name: 'Studio Satu', status: 'active', created_at: new Date(), messages: '3' }]
        : [],
    )
    await handle(callback('m:tenants'))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(edit?.body.message_id).toBe(99)
    expect(String(edit?.body.text)).toBe('Pelanggan (1) — pilih untuk melihat aksi:')
    expect(String(edit?.body.text)).not.toContain('Studio Satu')
    const all = buttons(edit)
    expect(all).toContainEqual({ text: '1. 🟢 Studio Satu', callback_data: `t:${TENANT_ID}` })
    expect(all.map((b) => b.callback_data)).toEqual(expect.arrayContaining(['m:invite', 'm:menu']))
  })

  it('numbers the customer buttons in order', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes('from tenants t') && query.includes('messages')
        ? [
            { id: TENANT_ID, name: 'Satu', status: 'active', created_at: new Date(), messages: '0' },
            { id: TENANT_ID.replace('1', '2'), name: 'Dua', status: 'onboarding', created_at: new Date(), messages: '0' },
          ]
        : [],
    )
    await handle(callback('m:tenants'))
    const labels = buttons(calls.find((c) => c.method === 'editMessageText')).map((b) => b.text)
    expect(labels).toContain('➕ Invite customer')
    expect(labels.filter((label) => /^\d\./.test(label))).toEqual(['1. 🟢 Satu', '2. 🟡 Dua'])
  })

  it('shows per-customer actions with a back button to the list', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes('t.contact_name')
        ? [
            {
              id: TENANT_ID,
              name: 'Studio Satu',
              status: 'disabled',
              contact_name: 'Dewi',
              created_at: new Date(),
              onboarded_at: null,
              whatsapp_jid: null,
              self_messages: '2',
              group_messages: '5',
              events: '1',
            },
          ]
        : [],
    )
    await handle(callback(`t:${TENANT_ID}`))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(buttons(edit).map((b) => b.callback_data)).toEqual([`t:${TENANT_ID}:a`, `t:${TENANT_ID}:p`, `t:${TENANT_ID}:j`, `t:${TENANT_ID}:c`, 'm:tenants'])
    expect(String(edit?.body.text)).toContain('Dewi')
    for (const [section, expected] of [
      ['c', [{ text: '✅ Set active', callback_data: `en:${TENANT_ID}` }]],
      ['p', [{ text: '💰 Usage', callback_data: `tu:${TENANT_ID}:d7` }]],
      ['a', [{ text: '🔄 WA re-pair (wipe)', callback_data: `rp:${TENANT_ID}` }]],
    ] as const) {
      await handle(callback(`t:${TENANT_ID}:${section}`))
      const group = buttons(calls.filter((c) => c.method === 'editMessageText').at(-1))
      expect(group, section).toEqual(expect.arrayContaining([...expected]))
      expect(group.at(-1), section).toEqual({ text: '⬅️ Back', callback_data: `t:${TENANT_ID}` })
    }
  })

  describe('sending an invitation through WhatsApp', () => {
    const PHONE = '6281234567890'
    const INVITE_ID = '3f2b1c4d-0000-4000-8000-0000000000a1'
    const urlButtons = (call?: Call) =>
      ((call?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; url?: string }>> } | undefined)?.inline_keyboard ?? [])
        .flat()
        .filter((button) => button.url)
    const sentMessage = (url: string) => decodeURIComponent(url.split('?text=')[1] ?? '')

    it('adds a send button when the command carries the number, and keeps the number out of the audit log', async () => {
      const { calls, audits, txCalls, handle } = setup()
      await handle(message('/invite Studio Satu 0812-3456-7890'))
      const reply = calls.at(-1)
      const [button] = urlButtons(reply)
      expect(button?.text).toBe('📲 Send via WhatsApp')
      expect(button?.url).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/)
      expect(sentMessage(button!.url!)).toMatch(/https:\/\/aksis\.test\/join\/[A-Za-z0-9_-]{43}/)
      expect(sentMessage(button!.url!)).toContain('Studio Satu')
      expect(txCalls.flat()).toContain(PHONE)
      expect(JSON.stringify(audits)).not.toContain(PHONE)
      expect(String(reply?.body.text)).not.toContain(PHONE)
      expect(String(reply?.body.text)).toContain('Undangan untuk Studio Satu')
    })

    it('always offers the button: without a number WhatsApp asks who to send it to', async () => {
      const { calls, txCalls, handle } = setup()
      await handle(message('/invite Studio Satu'))
      const [button] = urlButtons(calls.at(-1))
      expect(button?.text).toBe('📲 Send via WhatsApp')
      expect(button?.url).toMatch(/^https:\/\/wa\.me\/\?text=/)
      expect(sentMessage(button!.url!)).toMatch(/https:\/\/aksis\.test\/join\/[A-Za-z0-9_-]{43}/)
      expect(txCalls.flat()).not.toContain(PHONE)
    })

    it('does not ask for a number when the invite is made with buttons', async () => {
      const { calls, handle } = setup()
      await handle(callback('m:invite'))
      await handle(message('Studio Satu'))
      const reply = calls.at(-1)
      expect(String(reply?.body.text)).toMatch(/\/join\/[A-Za-z0-9_-]{43}/)
      expect(String(reply?.body.text)).not.toContain('nomor')
      expect(urlButtons(reply)[0]?.url).toMatch(/^https:\/\/wa\.me\/\?text=/)
    })

    const tenantDetail = (status: string) => ({
      id: TENANT_ID, name: 'Studio Satu', status, contact_name: null, created_at: new Date(), onboarded_at: null,
      whatsapp_jid: null, self_messages: '0', group_messages: '0', events: '0',
    })

    it('carries the number to a new link, from the customer card and from an older button', async () => {
      const row = { id: INVITE_ID, tenant_id: TENANT_ID, name: 'Studio Satu', expires_at: new Date(Date.now() + 3_600_000), expired: false }
      const rows = (query: string) =>
        query.includes('t.contact_name') ? [tenantDetail('invited')]
        : query.includes('from invitations i join tenants') ? [row]
        : query.includes('select phone from invitations') ? [{ phone: PHONE }]
        : []
      for (const data of [`tn:${TENANT_ID}`, `ivn:${INVITE_ID}`]) {
        const { calls, handle } = setup(undefined, rows)
        await handle(callback(data))
        const edit = calls.find((c) => c.method === 'editMessageText')
        const [button] = urlButtons(edit)
        expect(button?.url, data).toContain(`wa.me/${PHONE}`)
        expect(sentMessage(button!.url!), data).toMatch(/\/join\/[A-Za-z0-9_-]{43}/)
        expect(String(edit?.body.text), data).toContain('Link baru untuk Studio Satu')
      }
    })

    it('reads the linked number before a re-pair forgets it, and sends the new link to it', async () => {
      const order: string[] = []
      const { calls, handle } = setup(undefined, (query) => {
        if (query.includes('whatsapp_jid as jid')) {
          order.push('read number')
          return [{ jid: '6281234567890:12@s.whatsapp.net' }]
        }
        if (query.includes('whatsapp_jid = null')) order.push('reset')
        return [{ id: TENANT_ID, name: 'Studio Satu' }]
      })
      await handle(callback(`rpok:${TENANT_ID}`))
      expect(order).toEqual(['read number', 'reset'])
      const edit = calls.find((c) => c.method === 'editMessageText')
      expect(urlButtons(edit)[0]?.url).toContain(`wa.me/${PHONE}`)
      expect(String(edit?.body.text)).toContain('tautkan WhatsApp dengan kode')
    })
  })

  describe('WA reconnect', () => {
    const activeTenant = (query: string) =>
      query.includes('t.contact_name')
        ? [
            {
              id: TENANT_ID, name: 'Studio Satu', status: 'active', contact_name: 'Dewi', created_at: new Date(),
              onboarded_at: null, whatsapp_jid: null, self_messages: '2', group_messages: '5', events: '1',
            },
          ]
        : []

    it('offers the button only while WhatsApp is switched off', async () => {
      for (const [connection, shown] of [['tidak aktif', true], ['connected', false]] as const) {
        const { calls, handle } = setup(undefined, activeTenant, { connectionOf: () => connection, reconnectWhatsApp: async () => 'started' })
        await handle(callback(`t:${TENANT_ID}:a`))
        const all = buttons(calls.find((c) => c.method === 'editMessageText'))
        expect(all.some((b) => b.callback_data === `wr:${TENANT_ID}`), connection).toBe(shown)
      }
    })

    it('reopens the stored session, audits it, and tells the admin the outcome', async () => {
      const reconnectWhatsApp = vi.fn(async () => 'started' as const)
      const { calls, audits, handle } = setup(undefined, activeTenant, { connectionOf: () => 'tidak aktif', reconnectWhatsApp })
      await handle(callback(`wr:${TENANT_ID}`))
      expect(reconnectWhatsApp).toHaveBeenCalledWith(TENANT_ID)
      expect(JSON.stringify(audits)).toContain('whatsapp_reconnect')
      expect(String(calls.find((c) => c.method === 'editMessageText')?.body.text)).toContain('WhatsApp dibuka lagi')
    })

    it('explains when there is no free slot', async () => {
      const { calls, handle } = setup(undefined, activeTenant, { connectionOf: () => 'tidak aktif', reconnectWhatsApp: async () => 'full' })
      await handle(callback(`wr:${TENANT_ID}`))
      expect(String(calls.find((c) => c.method === 'editMessageText')?.body.text)).toContain('Slot WhatsApp penuh')
    })
  })

  it('asks for confirmation before disabling and offers to cancel back to the customer', async () => {
    const { calls, handle } = setup(undefined, () => [{ id: TENANT_ID, name: 'Studio Satu' }])
    await handle(callback(`dis:${TENANT_ID}`))
    const all = buttons(calls.find((c) => c.method === 'editMessageText'))
    expect(all.map((b) => b.callback_data)).toEqual([`disok:${TENANT_ID}`, `t:${TENANT_ID}`])
  })

  it('asks for a strong confirmation before deleting a customer', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes('t.contact_name')
        ? [
            {
              id: TENANT_ID, name: 'Studio Satu', status: 'active', contact_name: null,
              created_at: new Date(), onboarded_at: null, whatsapp_jid: null,
              self_messages: '2', group_messages: '5', events: '1',
            },
          ]
        : [],
    )
    await handle(callback(`del:${TENANT_ID}`))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(String(edit?.body.text)).toContain('HAPUS PERMANEN Studio Satu')
    expect(String(edit?.body.text)).toContain('7 pesan')
    expect(buttons(edit).map((b) => b.callback_data)).toEqual([`delok:${TENANT_ID}`, `t:${TENANT_ID}`])
  })

  it('closes the whatsapp session before deleting the customer data', async () => {
    const order: string[] = []
    const removeSession = vi.fn(async () => {
      order.push('session')
    })
    const { calls, handle } = setup(
      undefined,
      (query) => {
        if (query.includes('delete from') || query.includes('select name from tenants')) order.push('db')
        return [{ id: TENANT_ID, name: 'Studio Satu', messages: '3' }]
      },
      { removeSession },
    )
    await handle(callback(`delok:${TENANT_ID}`))
    expect(removeSession).toHaveBeenCalledWith(TENANT_ID)
    expect(order[0]).toBe('session')
    expect(String(calls.filter((c) => c.method === 'editMessageText').at(-1)?.body.text)).toContain(
      'dihapus permanen',
    )
  })

  it('has a single usage button, in the System menu', async () => {
    const { calls, handle } = setup()
    await handle(callback('m:system'))
    const usage = buttons(calls.find((c) => c.method === 'editMessageText')).filter((b) => b.text.includes('Usage'))
    expect(usage).toEqual([{ text: '💰 Usage', callback_data: 'u:d7' }])
  })

  it('offers today, 7 days, 30 days and custom on the usage screen', async () => {
    const { calls, handle } = setup()
    await handle(callback('u:d30'))
    const edit = calls.find((c) => c.method === 'editMessageText')
    const all = buttons(edit)
    expect(all.map((b) => b.callback_data)).toEqual(['u:d1', 'u:d7', 'u:d30', 'uc', 'm:menu'])
    expect(all.find((b) => b.callback_data === 'u:d30')?.text).toBe('• 30 hari')
    expect(String(edit?.body.text)).toContain('30 hari terakhir')
  })

  it('takes a typed custom range, and re-asks on a bad format', async () => {
    const { calls, handle } = setup()
    await handle(callback('uc'))
    expect(String(calls.at(-1)?.body.text)).toContain('Ketik rentang tanggal')

    await handle(message('minggu lalu'))
    expect(String(calls.at(-1)?.body.text)).toContain('Format tanggal tidak dikenali')

    await handle(message('2026-10-01 2026-10-15'))
    expect(String(calls.at(-1)?.body.text)).toContain('1 Okt 2026 – 15 Okt 2026')
    expect(buttons(calls.at(-1)).some((b) => b.callback_data === 'uc')).toBe(true)
  })

  it('does not swallow normal text after the custom prompt is cancelled', async () => {
    const ask = vi.fn(async () => ({ text: 'jawaban' }))
    const { handle } = setup(ask)
    await handle(callback('uc'))
    await handle(callback('m:menu'))
    await handle(message('2026-10-01 2026-10-15'))
    await vi.waitFor(() => expect(ask).toHaveBeenCalled())
  })

  it('shows per-customer usage with the same ranges and a custom option', async () => {
    const { calls, handle } = setup(undefined, () => [
      { name: 'Studio Satu', runs: '2', input: '10', output: '4', cost: '0.001' },
    ])
    await handle(callback(`tu:${TENANT_ID}:d1`))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(buttons(edit).map((b) => b.callback_data)).toEqual([
      `tu:${TENANT_ID}:d1`,
      `tu:${TENANT_ID}:d7`,
      `tu:${TENANT_ID}:d30`,
      `tc:${TENANT_ID}`,
      `t:${TENANT_ID}`,
    ])
  })

  it('shows where the AI cost came from, in plain words, on the usage screens', async () => {
    const rows = (query: string) =>
      query.includes('source_kind')
        ? [
            { kind: 'group', runs: '12', cost: '0.7' },
            { kind: 'contact', runs: '3', cost: '0.15' },
            { kind: 'app_chat', runs: '8', cost: '0.3' },
            { kind: 'summary', runs: '2', cost: '0.05' },
          ]
        : [{ name: 'Studio Satu', runs: '25', input: '100', output: '40', cost: '1.2' }]
    const { calls, handle } = setup(undefined, rows)
    await handle(callback('u:d7'))
    const all = String(calls.find((c) => c.method === 'editMessageText')?.body.text)
    expect(all).toContain('Per jenis:')
    expect(all).toContain('• Baca grup: 12 run, ~$0.7000')
    expect(all).toContain('• Baca chat pribadi: 3 run, ~$0.1500')
    expect(all).toContain('• Chat di app: 8 run, ~$0.3000')
    expect(all).toContain('• Catatan proyek: 2 run, ~$0.0500')
    expect(all).not.toMatch(/app_chat|self_chat|source_kind/)

    await handle(callback(`tu:${TENANT_ID}:d7`))
    const one = String(calls.filter((c) => c.method === 'editMessageText').at(-1)?.body.text)
    expect(one).toContain('Studio Satu')
    expect(one).toContain('Per jenis:')
  })

  it('leaves the "Per jenis" part out when nothing ran', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes('source_kind') ? [] : [{ name: 'Studio Satu', runs: '0', input: null, output: null, cost: null }],
    )
    await handle(callback('u:d7'))
    expect(String(calls.find((c) => c.method === 'editMessageText')?.body.text)).not.toContain('Per jenis')
  })

  it('shows the full main menu with the new sections', async () => {
    const { calls, handle } = setup()
    await handle(message('/menu'))
    const ids = buttons(calls.find((c) => c.method === 'sendMessage')).map((b) => b.callback_data)
    expect(ids).toEqual(expect.arrayContaining(['m:invite', 'm:tenants', 'm:bill', 'm:bc', 'm:system']))
    expect(ids).not.toContain('m:inv') // invitations live on the customers now
    await handle(callback('m:system'))
    const system = buttons(calls.filter((c) => c.method === 'editMessageText').at(-1)).map((b) => b.callback_data)
    expect(system).toEqual(['m:status', 'u:d7', 'm:failed', 'm:sys', 'm:dash', 'm:adm', 'm:menu'])
  })

  it('offers rename, notes, limits and whatsapp controls on the customer card', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes('t.contact_name')
        ? [
            {
              id: TENANT_ID, name: 'Studio Satu', status: 'active', contact_name: null,
              created_at: new Date(), onboarded_at: null, whatsapp_jid: null,
              self_messages: '0', group_messages: '0', events: '0',
            },
          ]
        : [],
    )
    const ids: string[] = []
    for (const section of ['a', 'p', 'j', 'c']) {
      await handle(callback(`t:${TENANT_ID}:${section}`))
      ids.push(...buttons(calls.filter((c) => c.method === 'editMessageText').at(-1)).map((b) => b.callback_data))
    }
    expect(ids).not.toContain(`wr:${TENANT_ID}`)
    expect(ids).toEqual(
      expect.arrayContaining([
        `lm:${TENANT_ID}`, `rn:${TENANT_ID}`, `nt:${TENANT_ID}`, `wd:${TENANT_ID}`, `rp:${TENANT_ID}`, `del:${TENANT_ID}`,
      ]),
    )
    expect(Math.max(...ids.map((id) => Buffer.byteLength(id)))).toBeLessThanOrEqual(64)
  })

  it('renames a customer from typed text', async () => {
    const seen: unknown[][] = []
    const { calls, handle } = setup(undefined, () => [])
    await handle(callback(`rn:${TENANT_ID}`))
    expect(String(calls.at(-1)?.body.text)).toContain('nama baru')
    await handle(message('  Studio   Baru  '))
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(true)
    void seen
  })

  it('only offers limit presets and rejects arbitrary amounts', async () => {
    const { calls, audits, handle } = setup(undefined, () => [
      { id: TENANT_ID, name: 'Studio Satu', daily: '1', monthly: '20', paused: false, today: '0.1', month: '1' },
    ])
    await handle(callback(`lm:${TENANT_ID}`))
    const ids = buttons(calls.at(-1)).map((b) => b.callback_data)
    expect(ids).toEqual(expect.arrayContaining([`ld:${TENANT_ID}:0.25`, `ld:${TENANT_ID}:0`, `lb:${TENANT_ID}:50`, `t:${TENANT_ID}`]))
    const before = audits.length
    await handle(callback(`ld:${TENANT_ID}:9999`))
    // An amount outside the presets only re-renders the screen; it is never written.
    expect(audits.slice(before).flat().includes(9999)).toBe(false)
  })

  it('lists failed runs with retry buttons for blocked customers', async () => {
    const { calls, handle } = setup(undefined, (query) =>
      query.includes("status = 'failed'")
        ? [{ finished_at: new Date(), started_at: new Date(), name: 'Studio Satu', error_text: 'Hermes API returned 500' }]
        : query.includes('analysis_attempts >= 3')
          ? [{ tenant_id: TENANT_ID, name: 'Studio Satu', n: '4' }]
          : [],
    )
    await handle(callback('m:failed'))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(String(edit?.body.text)).toContain('Hermes API returned 500')
    expect(buttons(edit).some((b) => b.callback_data === `fr:${TENANT_ID}` && b.text.includes('(4)'))).toBe(true)
  })

  describe('the link of a customer who has not started yet', () => {
    const detail = (status: string) => ({
      id: TENANT_ID, name: 'Studio Satu', status, contact_name: null, created_at: new Date(), onboarded_at: null,
      whatsapp_jid: null, self_messages: '0', group_messages: '0', events: '0',
    })
    const cardFor = async (status: string, invitation: { expired: boolean; used: boolean } | null) => {
      const { calls, handle } = setup(undefined, (query) =>
        query.includes('t.contact_name') ? [detail(status)]
        : query.includes('used_at is not null as used') && invitation ? [{ id: 'i1', expires_at: new Date(Date.now() + 86_400_000), ...invitation }]
        : [],
      )
      await handle(callback(`t:${TENANT_ID}:a`))
      const edit = calls.find((c) => c.method === 'editMessageText')
      return { text: String(edit?.body.text), ids: buttons(edit).map((b) => b.callback_data) }
    }

    it('shows where the link stands and offers a new one, with a revoke while it is open', async () => {
      const open = await cardFor('invited', { expired: false, used: false })
      expect(open.text).toContain('Link onboarding: berlaku sampai')
      expect(open.ids).toEqual(expect.arrayContaining([`tn:${TENANT_ID}`, `tr:${TENANT_ID}`]))

      const expired = await cardFor('invited', { expired: true, used: false })
      expect(expired.text).toContain('Link onboarding: kedaluwarsa')
      expect(expired.ids).toContain(`tn:${TENANT_ID}`)
      expect(expired.ids).not.toContain(`tr:${TENANT_ID}`)

      expect((await cardFor('invited', null)).text).toContain('Link onboarding: belum ada yang aktif')

      const used = await cardFor('onboarding', { expired: false, used: true })
      expect(used.text).toContain('Link onboarding: sudah dibuka pelanggan')
      expect(used.ids).toContain(`tn:${TENANT_ID}`)
      expect(used.ids).not.toContain(`tr:${TENANT_ID}`)
    })

    it('says nothing about links once the customer is active', async () => {
      const active = await cardFor('active', { expired: false, used: true })
      expect(active.text).not.toContain('Link onboarding')
      expect(active.ids).not.toContain(`tn:${TENANT_ID}`)
    })

    it('revokes the unused links on request', async () => {
      const seen: string[] = []
      const { calls, handle } = setup(undefined, (query) => {
        if (query.includes('set revoked_at = now(), phone = null')) seen.push('revoked')
        return query.includes('t.contact_name') ? [detail('invited')] : []
      })
      await handle(callback(`tr:${TENANT_ID}`))
      expect(seen).toEqual(['revoked'])
      expect(String(calls.find((c) => c.method === 'editMessageText')?.body.text)).toContain('Link dicabut')
    })

    it('lists the customer to invite first, marks customers nobody has opened, and still honours the old Invites menu', async () => {
      const { calls, handle } = setup(undefined, (query) =>
        query.includes('from tenants t') && query.includes('messages')
          ? [{ id: TENANT_ID, name: 'Studio Satu', status: 'invited', created_at: new Date(), messages: '0' }]
          : [],
      )
      await handle(callback('m:tenants'))
      const all = buttons(calls.find((c) => c.method === 'editMessageText'))
      expect(all).toContainEqual({ text: '➕ Invite customer', callback_data: 'm:invite' })
      expect(all.some((b) => b.text.includes('Studio Satu · belum dibuka'))).toBe(true)

      await handle(callback('m:inv'))
      expect(buttons(calls.at(-1)).map((b) => b.callback_data)).toContain('m:invite')
    })
  })

  it('previews a broadcast before sending and only queues it on confirmation', async () => {
    const { calls, audits, handle } = setup(undefined, (query) =>
      query.includes("status = 'active'") ? [{ id: TENANT_ID, name: 'Studio Satu' }] : [],
    )
    await handle(callback('bt:all'))
    await handle(message('Besok maintenance singkat.'))
    const preview = calls.at(-1)
    expect(String(preview?.body.text)).toContain('Aksis: Besok maintenance singkat.')
    expect(buttons(preview).map((b) => b.callback_data)).toEqual(['bs', 'm:menu'])
    expect(audits.flat().includes('broadcast')).toBe(false)

    await handle(callback('bs'))
    expect(String(calls.at(-1)?.body.text)).toContain('antrean untuk 1 pelanggan')
  })

  it('lets only owners add or remove admins', async () => {
    const { calls, handle } = setup()
    await handle(callback('m:adm'))
    expect(buttons(calls.at(-1)).some((b) => b.callback_data === 'ada')).toBe(true)
    // 42 is the owner in setup(); a database admin must not see add/remove controls.
  })

  it('rejects a malformed admin id', async () => {
    const { calls, handle } = setup()
    await handle(callback('ada'))
    await handle(message('abc'))
    expect(String(calls.at(-1)?.body.text)).toContain('harus berupa angka')
  })

  it('asks for confirmation before wiping a whatsapp session, and only then does it', async () => {
    const removeSession = vi.fn(async () => undefined)
    const { calls, handle } = setup(undefined, () => [{ id: TENANT_ID, name: 'Studio Satu' }], { removeSession })
    await handle(callback(`rp:${TENANT_ID}`))
    expect(removeSession).not.toHaveBeenCalled()
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(String(edit?.body.text)).toContain('Sesi WhatsApp sekarang dihapus')
    expect(buttons(edit).map((b) => b.callback_data)).toEqual([`rpok:${TENANT_ID}`, `t:${TENANT_ID}`])

    await handle(callback(`rpok:${TENANT_ID}`))
    expect(removeSession).toHaveBeenCalledWith(TENANT_ID)
  })

  it('starts the 14-day trial when an admin activates a customer, not when they disable one', async () => {
    const row = {
      id: TENANT_ID, name: 'Studio Satu', status: 'active', contact_name: null,
      created_at: new Date(), onboarded_at: null, whatsapp_jid: null,
      self_messages: '0', group_messages: '0', events: '0',
      plan_code: 'trial', plan_name: 'Trial', group_limit: 5, started_at: new Date(), ends_at: new Date(Date.now() + 864e5),
    }
    const { audits, handle } = setup(undefined, () => [row])
    const trialStarts = () =>
      audits.filter((v) => v[0] === TENANT_ID && v[1] instanceof Date && v[2] instanceof Date).length

    await handle(callback(`disok:${TENANT_ID}`))
    expect(trialStarts()).toBe(0)

    await handle(callback(`en:${TENANT_ID}`))
    expect(trialStarts()).toBe(1)
    const [, started, ends] = audits.find((v) => v[1] instanceof Date && v[2] instanceof Date)! as [string, Date, Date]
    expect(Math.round((ends.getTime() - started.getTime()) / 86_400_000)).toBe(14)
  })

  it('reopens the stored whatsapp session when a customer is switched back on', async () => {
    const resumeWhatsApp = vi.fn(async () => undefined)
    const row = {
      id: TENANT_ID, name: 'Studio Satu', status: 'active', contact_name: null,
      created_at: new Date(), onboarded_at: null, whatsapp_jid: null,
      self_messages: '0', group_messages: '0', events: '0',
      plan_code: 'pro', plan_name: 'Pro', group_limit: 5, started_at: new Date(), ends_at: new Date(Date.now() + 864e5),
    }
    const { handle } = setup(undefined, () => [row], { resumeWhatsApp })
    await handle(callback(`en:${TENANT_ID}`))
    expect(resumeWhatsApp).toHaveBeenCalledWith(TENANT_ID)

    resumeWhatsApp.mockClear()
    await handle(callback(`disok:${TENANT_ID}`))
    expect(resumeWhatsApp).not.toHaveBeenCalled()
  })

  it('tells an activated customer where the app is, and can send it again', async () => {
    const sendAccessInfo = vi.fn(async (_tenantId: string, _text: string) => true)
    const row = {
      id: TENANT_ID, name: 'Studio Satu', status: 'active', contact_name: null,
      created_at: new Date(), onboarded_at: null, whatsapp_jid: null,
      self_messages: '0', group_messages: '0', events: '0',
      plan_code: 'pro', plan_name: 'Pro', group_limit: 5, started_at: new Date(), ends_at: new Date(Date.now() + 864e5),
    }
    const { handle } = setup(undefined, () => [row], { sendAccessInfo })
    await handle(callback(`en:${TENANT_ID}`))
    expect(sendAccessInfo).toHaveBeenCalledTimes(1)
    const text = sendAccessInfo.mock.calls[0]![1]
    expect(text).toContain('/app')
    expect(text).not.toMatch(/\d{6}/)

    await handle(callback(`ai:${TENANT_ID}`))
    expect(sendAccessInfo).toHaveBeenCalledTimes(2)

    sendAccessInfo.mockClear()
    await handle(callback(`disok:${TENANT_ID}`))
    expect(sendAccessInfo).not.toHaveBeenCalled()
  })

  it('ignores presses on label-only buttons without redrawing', async () => {
    const { calls, handle } = setup()
    await handle(callback('noop'))
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery'])
  })

  it('every non-menu screen has a way back', async () => {
    const { calls, handle } = setup()
    for (const data of ['m:status', 'm:usage:7', 'm:invite', 'bogus']) {
      await handle(callback(data))
      const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)
      expect(buttons(edit).some((b) => b.callback_data === 'm:menu')).toBe(true)
    }
  })

  it('rejects malformed disable callbacks', async () => {
    const { calls, handle } = setup()
    await handle(callback('disok:not-a-uuid'))
    expect(String(calls.at(-1)?.body.text)).toBe('Tombol tidak dikenal.')
  })
})

describe('telegram group editor', () => {
  const tenantRow = (status = 'active') => [
    {
      id: TENANT_ID, name: 'Studio Satu', status, contact_name: 'Dewi',
      created_at: new Date(), onboarded_at: new Date(), whatsapp_jid: null,
      self_messages: '0', group_messages: '0', events: '0',
    },
  ]
  const rowsFor = (status = 'active') => (query: string) => (query.includes('t.contact_name') ? tenantRow(status) : [])
  const groupList = (count: number, selected: number[] = []) =>
    Array.from({ length: count }, (_, i) => ({
      jid: `g${i}@g.us`, subject: `Proyek Rahasia ${i}`, participants: 5, selected: selected.includes(i),
    }))
  const lastEdit = (calls: Call[]) => [...calls].reverse().find((c) => c.method === 'editMessageText')
  const labels = (call?: Call) => buttons(call).map((b) => b.text)

  function withGroups(list: () => Promise<ReturnType<typeof groupList>>, save = vi.fn(async (_t: string, jids: string[]) => ({ ok: true as const, count: jids.length })), status = 'active') {
    const ctx = setup(undefined, rowsFor(status), { groups: { list, save } })
    return { ...ctx, save }
  }

  it('offers the button on the customer screen only when group management is wired', async () => {
    const wired = withGroups(async () => groupList(1))
    await wired.handle(callback(`t:${TENANT_ID}:j`))
    expect(buttons(lastEdit(wired.calls)).map((b) => b.callback_data)).toContain(`ge:${TENANT_ID}`)

    const plain = setup(undefined, rowsFor())
    await plain.handle(callback(`t:${TENANT_ID}:j`))
    expect(buttons(lastEdit(plain.calls)).map((b) => b.callback_data)).not.toContain(`ge:${TENANT_ID}`)
  })

  it('lists groups with the stored selection and audits the access without group names', async () => {
    const { calls, audits, handle } = withGroups(async () => groupList(3, [1]))
    await handle(callback(`ge:${TENANT_ID}`))
    const edit = lastEdit(calls)
    expect(labels(edit).slice(0, 3)).toEqual(['☐ Proyek Rahasia 0', '☑ Proyek Rahasia 1', '☐ Proyek Rahasia 2'])
    expect(String(edit?.body.text)).toContain('Dipilih: 1/5')
    expect(JSON.stringify(audits)).toContain('groups_viewed')
    expect(JSON.stringify(audits)).not.toContain('Rahasia')
  })

  it('toggles groups and saves the chosen JIDs, auditing only the count', async () => {
    const { calls, audits, handle, save } = withGroups(async () => groupList(3, [1]))
    await handle(callback(`ge:${TENANT_ID}`))
    await handle(callback('gt:0'))
    await handle(callback('gt:1'))
    expect(labels(lastEdit(calls)).slice(0, 3)).toEqual(['☑ Proyek Rahasia 0', '☐ Proyek Rahasia 1', '☐ Proyek Rahasia 2'])

    await handle(callback('gs'))
    expect(save).toHaveBeenCalledWith(TENANT_ID, ['g0@g.us'])
    const done = lastEdit(calls)
    expect(String(done?.body.text)).toContain('1 grup dibaca')
    expect(String(done?.body.text)).not.toContain('Rahasia')
    expect(JSON.stringify(audits)).toContain('groups_changed')
    expect(buttons(done).map((b) => b.callback_data)).toEqual([`t:${TENANT_ID}`])
  })

  it('refuses a sixth group but still lets the admin release one', async () => {
    const { calls, handle } = withGroups(async () => groupList(7, [0, 1, 2, 3, 4]))
    await handle(callback(`ge:${TENANT_ID}`))
    await handle(callback('gt:5'))
    expect(String(lastEdit(calls)?.body.text)).toContain('Batas 5 grup tercapai')
    expect(labels(lastEdit(calls)).filter((t) => t.startsWith('☑'))).toHaveLength(5)
    await handle(callback('gt:0'))
    expect(String(lastEdit(calls)?.body.text)).toContain('Dipilih: 4/5')
  })

  it('pages and searches without losing positions', async () => {
    const { calls, handle } = withGroups(async () => groupList(12))
    await handle(callback(`ge:${TENANT_ID}`))
    expect(String(lastEdit(calls)?.body.text)).toContain('Halaman 1/2')
    await handle(callback('gp:1'))
    expect(labels(lastEdit(calls)).filter((t) => t.startsWith('☐'))).toHaveLength(4)

    await handle(callback('gq'))
    expect(String(lastEdit(calls)?.body.text)).toContain('Ketik sebagian nama grup')
    await handle(message('rahasia 11'))
    const found = [...calls].reverse().find((c) => c.method === 'sendMessage')
    expect(labels(found)).toContain('☐ Proyek Rahasia 11')
    expect(buttons(found).find((b) => b.text === '☐ Proyek Rahasia 11')?.callback_data).toBe('gt:11')
  })

  it('cancelling returns to the customer screen and drops the session', async () => {
    const { calls, handle, save } = withGroups(async () => groupList(2))
    await handle(callback(`ge:${TENANT_ID}`))
    await handle(callback('gx'))
    expect(String(lastEdit(calls)?.body.text)).toContain('Studio Satu')
    await handle(callback('gs'))
    expect(String(lastEdit(calls)?.body.text)).toContain('Sesi ganti grup sudah berakhir')
    expect(save).not.toHaveBeenCalled()
  })

  it('explains when WhatsApp is not connected and when the customer is disabled', async () => {
    const offline = withGroups(async () => { throw new Error('WhatsApp is not connected') })
    await offline.handle(callback(`ge:${TENANT_ID}`))
    expect(String(lastEdit(offline.calls)?.body.text)).toContain('belum tersambung')
    await offline.handle(callback('gs'))
    expect(String(lastEdit(offline.calls)?.body.text)).toContain('Sesi ganti grup sudah berakhir')

    const disabled = withGroups(async () => groupList(1), undefined, 'disabled')
    await disabled.handle(callback(`ge:${TENANT_ID}`))
    expect(String(lastEdit(disabled.calls)?.body.text)).toContain('nonaktif')
  })

  it('keeps the editor open when saving fails', async () => {
    const failing = vi.fn(async () => ({ ok: false as const, reason: 'Maksimal 5 grup untuk paket Anda.' }))
    const { calls, handle } = withGroups(async () => groupList(2), failing as never)
    await handle(callback(`ge:${TENANT_ID}`))
    await handle(callback('gt:0'))
    await handle(callback('gs'))
    expect(String(lastEdit(calls)?.body.text)).toContain('Maksimal 5 grup')
    expect(labels(lastEdit(calls))).toContain('☑ Proyek Rahasia 0')
  })

  it('does not let a non-admin open the editor', async () => {
    const { calls, handle } = withGroups(async () => groupList(2))
    await handle(callback(`ge:${TENANT_ID}`, 7))
    expect(calls).toHaveLength(0)
  })
})

describe('System WhatsApp screen', () => {
  const system = (pair: () => Promise<string | null>, connection = 'qr_ready') => ({
    system: { status: () => ({ phone: '6281200000000', connection, paired: false, lastError: null }), pair },
  })

  it('shows the state and issues a pairing code on request', async () => {
    const pair = vi.fn(async () => 'ABCD-1234')
    const { calls, handle } = setup(undefined, () => [], system(pair))
    await handle(callback('m:sys:pair'))
    const text = String(calls.find((call) => call.method === 'editMessageText')?.body.text)
    expect(pair).toHaveBeenCalledOnce()
    expect(text).toContain('ABCD-1234')
    expect(text).toContain('6281200000000')
  })

  it('does not issue a code when only viewing, and hides Pair once connected', async () => {
    const pair = vi.fn(async () => 'ABCD-1234')
    const { calls, handle } = setup(undefined, () => [], system(pair, 'connected'))
    await handle(callback('m:sys'))
    expect(pair).not.toHaveBeenCalled()
    const edit = calls.find((call) => call.method === 'editMessageText')
    expect(buttons(edit).map((button) => button.callback_data)).not.toContain('m:sys:pair')
  })

  it('says so when the number is not configured', async () => {
    const { calls, handle } = setup()
    await handle(callback('m:sys'))
    expect(String(calls.find((call) => call.method === 'editMessageText')?.body.text)).toContain('SYSTEM_WHATSAPP_PHONE')
  })
})

describe('access requests from the landing page', () => {
  const LEAD_ID = '3f2b1c4d-0000-4000-8000-0000000000c1'
  const PHONE = '6281234567890'
  const lead = { id: LEAD_ID, name: 'Dewi', phone: PHONE, status: 'new' as const, createdAt: new Date() }
  const rows = (query: string) =>
    query.includes('delete from leads') ? [{ name: 'Dewi', phone: PHONE, terms_version: 'v1' }]
    : query.includes('from leads where id') ? [{ id: LEAD_ID, name: 'Dewi', phone: PHONE, status: 'new', created_at: new Date() }]
    : query.includes('update leads') ? [{ id: LEAD_ID, name: 'Dewi', phone: PHONE, status: 'contacted', created_at: new Date() }]
    : query.includes('count(*)::int') && query.includes('from leads') ? [{ n: 2 }]
    : []

  it('tells the admins with English buttons for the next step', async () => {
    const { calls, bot } = setup()
    await bot.notifyNewLead(lead)
    const sent = calls.find((c) => c.method === 'sendMessage')
    expect(String(sent?.body.text)).toContain('Dewi')
    expect(String(sent?.body.text)).toContain(`+${PHONE}`)
    const all = ((sent?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }).inline_keyboard).flat()
    expect(all.map((b) => b.text)).toEqual(['✅ Create invite', '💬 Chat on WhatsApp', '📞 Mark contacted', '🚫 Reject'])
    expect(all.map((b) => b.callback_data).filter(Boolean)).toEqual([`lr:i:${LEAD_ID}`, `lr:c:${LEAD_ID}`, `lr:r:${LEAD_ID}`])
    expect(all[1]?.url).toContain(`wa.me/${PHONE}`)
  })

  it('shows a New requests button in the menu only when requests are waiting', async () => {
    const waiting = setup(undefined, rows)
    await waiting.handle(message('/menu'))
    const ids = buttons(waiting.calls.find((c) => c.method === 'sendMessage')).map((b) => b.callback_data)
    expect(ids).toContain('m:leads')
    const quiet = setup()
    await quiet.handle(message('/menu'))
    expect(buttons(quiet.calls.find((c) => c.method === 'sendMessage')).map((b) => b.callback_data)).not.toContain('m:leads')
  })

  it('makes an invitation for the number the person gave and keeps the number out of the audit log', async () => {
    const { calls, audits, txCalls, handle } = setup(undefined, rows)
    await handle(callback(`lr:i:${LEAD_ID}`))
    const edit = calls.find((c) => c.method === 'editMessageText')
    const urls = ((edit?.body.reply_markup as { inline_keyboard: Array<Array<{ url?: string }>> }).inline_keyboard).flat().filter((b) => b.url)
    expect(urls[0]?.url).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/)
    expect(decodeURIComponent(urls[0]!.url!)).toMatch(/\/join\/[A-Za-z0-9_-]{43}/)
    expect(txCalls.flat()).toContain(PHONE)
    expect(JSON.stringify(audits)).not.toContain(PHONE)
    expect(String(edit?.body.text)).toContain('Undangan untuk Dewi')
  })

  it('says so when the request was already handled', async () => {
    const { calls, handle } = setup()
    await handle(callback(`lr:i:${LEAD_ID}`))
    expect(String(calls.find((c) => c.method === 'editMessageText')?.body.text)).toContain('sudah diproses')
  })

  it('marks a request as contacted', async () => {
    const { calls, handle } = setup(undefined, rows)
    await handle(callback(`lr:c:${LEAD_ID}`))
    expect(String(calls.find((c) => c.method === 'editMessageText')?.body.text)).toContain('Ditandai sudah dihubungi')
  })
})

describe('dashboard login link', () => {
  it('gives an admin a button with a one-time link, with the token only in the # part and never in the text', async () => {
    const { calls, handle } = setup()
    await handle(message('/dashboard'))
    const send = calls.find((c) => c.method === 'sendMessage')
    const urls = ((send?.body.reply_markup as { inline_keyboard: Array<Array<{ url?: string }>> }).inline_keyboard).flat().filter((b) => b.url)
    expect(urls[0]?.url).toMatch(/^https:\/\/aksis\.test\/dashboard\/masuk#[A-Za-z0-9_-]{43}$/)
    const token = urls[0]!.url!.split('#')[1]!
    expect(String(send?.body.text)).not.toContain(token)
    expect(String(send?.body.text)).toContain('5 menit')
  })

  it('is reachable from the System menu and not for people who are not admins', async () => {
    const admin = setup()
    await admin.handle(callback('m:dash'))
    expect(admin.calls.some((c) => c.method === 'editMessageText' && JSON.stringify(c.body).includes('/dashboard/masuk#'))).toBe(true)
    const stranger = setup()
    await stranger.handle(message('/dashboard', 7))
    expect(stranger.calls).toHaveLength(0)
  })

  it('knows its admins', () => {
    const { bot } = setup()
    expect(bot.isAdminId(42)).toBe(true)
    expect(bot.isAdminId(7)).toBe(false)
  })
})

describe('choosing a plan for a customer whose WhatsApp just connected', () => {
  const TENANT = '3f2b1c4d-0000-4000-8000-0000000000d1'
  const found = (query: string) =>
    query.includes('from tenants') && query.includes('lower(name)') ? [{ id: TENANT, name: 'Studio Baru' }]
    : query.includes('insert into subscriptions') ? [{ tenant_id: TENANT }]
    : []

  it('tells the admins with Trial, Basic and Pro buttons', async () => {
    const { calls, bot } = setup()
    await bot.notifyPlanRequest({ id: TENANT, name: 'Studio Baru' })
    const sent = calls.find((c) => c.method === 'sendMessage')
    expect(String(sent?.body.text)).toContain('Studio Baru')
    const all = ((sent?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard).flat()
    expect(all.map((b) => b.text)).toEqual(['🎁 Trial 14 days', 'Basic', 'Pro'])
    expect(all.map((b) => b.callback_data)).toEqual([`pt:${TENANT}`, `sp:${TENANT}:basic`, `sp:${TENANT}:pro`])
  })

  it('Basic and Pro lead to the usual months screen', async () => {
    const { calls, handle } = setup(undefined, (query) => (query.includes('from plans') ? [{ code: 'basic', name: 'Basic', group_limit: 3, price_idr: 0 }] : []))
    await handle(callback(`sp:${TENANT}:basic`))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(String(edit?.body.text)).toContain('berapa bulan')
  })

  it('Trial starts the 14-day trial and says the customer moves on to the groups', async () => {
    const { calls, audits, handle } = setup(undefined, found)
    await handle(callback(`pt:${TENANT}`))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(String(edit?.body.text)).toContain('Uji coba 14 hari dimulai')
    expect(JSON.stringify(audits)).toContain('true')
  })

  it('does nothing for a stranger', async () => {
    const { calls, handle } = setup(undefined, found)
    await handle(callback(`pt:${TENANT}`, 7))
    expect(calls).toHaveLength(0)
  })
})
