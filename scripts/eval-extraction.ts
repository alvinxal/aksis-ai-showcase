// Runs synthetic group and private chats through the extraction prompt on Hermes and scores the events.
// Sends only the made-up messages in scripts/eval-cases.ts to the model, never database content.
//
//   HERMES_API_KEY=... [HERMES_API_ENDPOINT=http://172.30.0.1:8642] [HERMES_MODEL=deepseek-flash] \
//     npx tsx scripts/eval-extraction.ts [--runs=2] [--only=fin-due,core-task] [--baseline=path/to/old-prompt.ts] [--out=results.json]
//
// --baseline is a module exporting promptFor(batch) (e.g. the prompt before a change), scored on the same cases.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { extractJson, promptFor } from '../src/agent-worker.js'
import { parseAnalysisCompletion, type AnalysisBatch, type CompletedEvent, type RoutingProject } from '../src/analysis.js'
import { cases, type EvalCase, type Expected } from './eval-cases.js'

const args = new Map<string, string>(
  process.argv.slice(2).map((arg) => {
    const [name = '', ...value] = arg.replace(/^--/, '').split('=')
    return [name, value.join('=')]
  }),
)
const key = process.env.HERMES_API_KEY
if (!key) throw new Error('HERMES_API_KEY is required')
const endpoint = (process.env.HERMES_API_ENDPOINT ?? 'http://172.30.0.1:8642').replace(/\/$/, '')
const model = process.env.HERMES_MODEL ?? 'deepseek-flash'
const runs = Number(args.get('runs') ?? 1)
const only = args.get('only')?.split(',')
const concurrency = Number(args.get('concurrency') ?? 3)
const nonce = randomUUID().slice(0, 8)

type PromptFn = (batch: AnalysisBatch, projects?: RoutingProject[]) => string
const variants: Array<{ name: string; prompt: PromptFn }> = [{ name: 'new', prompt: (batch, projects) => promptFor(batch, undefined, projects ?? null) }]
const baseline = args.get('baseline')
if (baseline) {
  const loaded = (await import(pathToFileURL(baseline).href)) as { promptFor: PromptFn }
  variants.unshift({ name: 'baseline', prompt: loaded.promptFor })
}

type Outcome = {
  variant: string
  caseId: string
  group: string
  run: number
  parsed: boolean
  pass: boolean
  problems: string[]
  extras: string[]
  events: Array<Record<string, unknown>>
  tokens: { input: number; output: number }
  raw?: string
}

const wibDate = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' })
const amountOf = (event: CompletedEvent): unknown => (event.details as Record<string, unknown>).amount

async function callModel(prompt: string, session: string) {
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-hermes-session-key': session,
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  if (!response.ok) throw new Error(`Hermes returned ${response.status}`)
  const content = raw.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('no text content')
  return { content, input: raw.usage?.prompt_tokens ?? 0, output: raw.usage?.completion_tokens ?? 0 }
}

function matches(event: CompletedEvent, expected: Expected, ids: Map<string, string>): boolean {
  const types = Array.isArray(expected.type) ? expected.type : [expected.type]
  if (!types.includes(event.eventType)) return false
  if ('amount' in expected && expected.amount !== undefined) {
    const amount = amountOf(event)
    if (expected.amount === null ? amount !== null && amount !== undefined : amount !== expected.amount) return false
  }
  if (expected.dueDate !== undefined && (!event.dueAt || wibDate(event.dueAt) !== expected.dueDate)) return false
  return expected.sources.every((source) => event.sourceMessageIds.includes(ids.get(source)!))
}

function score(testCase: EvalCase, events: CompletedEvent[], reply: string | null, ids: Map<string, string>) {
  const problems: string[] = []
  const used = new Set<number>()
  for (const expected of testCase.expected) {
    const index = events.findIndex((event, i) => !used.has(i) && matches(event, expected, ids))
    if (index < 0) problems.push(`missing ${JSON.stringify({ ...expected, sources: expected.sources })}`)
    else used.add(index)
  }
  const extras = events.filter((_, i) => !used.has(i)).map((event) => `${event.eventType}: ${event.title}`)
  if (reply !== null) problems.push('reply on a group batch must be null')
  for (const event of events) {
    if (testCase.routing && (event.projectId ?? null) !== testCase.routing.project) problems.push(`routed to ${String(event.projectId ?? null)}, expected ${String(testCase.routing.project)}`)
    if (testCase.forbidden?.includes(event.eventType)) problems.push(`forbidden ${event.eventType}`)
    if (['DEADLINE_DETECTED', 'PAYMENT_DUE'].includes(event.eventType) && !event.dueAt) problems.push(`${event.eventType} without dueAt`)
    if (testCase.noDueAt && event.dueAt) problems.push(`unexpected dueAt on ${event.eventType}`)
    const amount = amountOf(event)
    if (typeof amount === 'number' && testCase.forbidAmounts?.includes(amount)) problems.push(`summed amount ${amount}`)
  }
  if (testCase.maxEvents !== undefined && events.length > testCase.maxEvents) problems.push(`${events.length} events, at most ${testCase.maxEvents}`)
  return { problems, extras }
}

async function runOne(variant: (typeof variants)[number], testCase: EvalCase, run: number): Promise<Outcome> {
  const ids = new Map(testCase.messages.map((message) => [message.key, randomUUID()]))
  const batch: AnalysisBatch = {
    runId: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), kind: testCase.contact ? 'contact' : 'group', model,
    messages: testCase.messages.map((message) => ({ id: ids.get(message.key)!, sentAt: message.sentAt, text: message.text, fromMe: message.fromMe })),
  }
  const base = { variant: variant.name, caseId: testCase.id, group: testCase.group, run }
  try {
    const result = await callModel(variant.prompt(batch, testCase.routing?.projects), `eval:${nonce}:${variant.name}:${testCase.id}:${run}`)
    const tokens = { input: result.input, output: result.output }
    let completion
    try {
      completion = parseAnalysisCompletion(extractJson(result.content))
    } catch (error) {
      return { ...base, parsed: false, pass: false, problems: [`unparseable: ${(error as Error).message}`], extras: [], events: [], tokens, raw: result.content.slice(0, 600) }
    }
    const { problems, extras } = score(testCase, completion.events, completion.reply, ids)
    const events = completion.events.map((event) => ({ type: event.eventType, title: event.title, dueAt: event.dueAt, amount: amountOf(event) ?? null, sources: event.sourceMessageIds.map((id) => [...ids].find(([, value]) => value === id)?.[0] ?? '?') }))
    return { ...base, parsed: true, pass: problems.length === 0, problems, extras, events, tokens }
  } catch (error) {
    return { ...base, parsed: false, pass: false, problems: [`call failed: ${(error as Error).message}`], extras: [], events: [], tokens: { input: 0, output: 0 } }
  }
}

const jobs = variants.flatMap((variant) =>
  cases.filter((testCase) => !only || only.includes(testCase.id)).flatMap((testCase) => Array.from({ length: runs }, (_, run) => () => runOne(variant, testCase, run))),
)
const outcomes: Outcome[] = []
let next = 0
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      const outcome = await job()
      outcomes.push(outcome)
      process.stderr.write(`${outcome.pass ? '.' : 'x'}`)
    }
  }),
)
process.stderr.write('\n')

// ---- report ----
const rate = (items: Outcome[]) => `${items.filter((item) => item.pass).length}/${items.length}`
console.log(`\nmodel ${model} · ${runs} run(s) per case\n`)
console.log(['group'.padEnd(9), ...variants.map((variant) => variant.name.padEnd(10))].join(' '))
for (const group of ['core', 'finance', 'edge', 'contact']) {
  console.log([group.padEnd(9), ...variants.map((variant) => rate(outcomes.filter((o) => o.variant === variant.name && o.group === group)).padEnd(10))].join(' '))
}
console.log([ 'parsed'.padEnd(9), ...variants.map((variant) => `${outcomes.filter((o) => o.variant === variant.name && o.parsed).length}/${outcomes.filter((o) => o.variant === variant.name).length}`.padEnd(10))].join(' '))
for (const variant of variants) {
  const mine = outcomes.filter((o) => o.variant === variant.name)
  const input = mine.reduce((sum, o) => sum + o.tokens.input, 0)
  const output = mine.reduce((sum, o) => sum + o.tokens.output, 0)
  console.log(`${variant.name}: ${input} in / ${output} out tokens, about $${((input * 0.3 + output * 1.2) / 1_000_000).toFixed(4)} (formula of agent-worker.ts)`)
}
console.log('\nfailures:')
for (const outcome of outcomes.filter((o) => !o.pass).sort((a, b) => a.variant.localeCompare(b.variant) || a.caseId.localeCompare(b.caseId))) {
  console.log(`- [${outcome.variant}] ${outcome.caseId} #${outcome.run}: ${outcome.problems.join('; ')}`)
}
const out = args.get('out')
if (out) writeFileSync(out, JSON.stringify(outcomes, null, 2))
