// Creates a tenant and an onboarding invite on the dev database, like the Telegram "invite" action.
//   DATABASE_URL=... PUBLIC_BASE_URL=https://... npx tsx scripts/dev-invite.ts "Studio Uji"
import { createInvitation } from '../src/admin.js'
import { createDatabase } from '../src/db.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const base = (process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:18881').replace(/\/$/, '')

const database = createDatabase(databaseUrl)
const { token, expiresAt } = await createInvitation(database, process.argv[2] ?? 'Studio Uji', 0)
console.log(`${base}/join/${token}`)
console.log(`expires ${expiresAt.toISOString()}`)
await database.end()
