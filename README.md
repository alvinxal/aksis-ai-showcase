# Aksis AI

> **Showcase copy.** Clean snapshot of a private product for portfolio purposes. Server units,
> deploy and backup scripts, runbooks, internal audit notes, and git history were removed.
> Built with Claude Code (Hono + TypeScript, Postgres, Baileys, Hermes agent with DeepSeek).

AI copilot for professionals who run client projects over WhatsApp (architects, contractors, designers, consultants). A customer links WhatsApp, picks up to 3 or 5 project groups, and
Aksis AI watches them: it detects decisions, revision requests, assignments, deadlines,
decision conflicts and follow-ups, and answers questions in the customer's WhatsApp self-chat.
Admins run everything from a Telegram bot.

Stack: Hono + TypeScript, PostgreSQL 16, Baileys (WhatsApp), Hermes agent with DeepSeek,
Docker Compose, a Cloudflare named tunnel  for the public pages.

## Features

- **Onboarding** (`/join/<token>` -> `/onboarding`): profile, WhatsApp pairing with a code typed on the same
  phone (the QR for a second device is hidden for now, see `web/src/features.ts`), group selection. A React page in `web/` that talks to `/v1/onboarding/*`;
  strict CSP (`script-src 'self'`).
- **Colors**: the app and the landing page share one green family (`web/src/styles.css`: leaf `#00843d` as brand-500, forest `#14231b` as ink, moss, mint). The comment at the
  top of that file lists the contrast of the pairs the screens use (white on brand-500 4.81:1, ink-mute on surface 4.79:1); keep every new pair at 4.5:1 or more for text.
  The Proyek screens (`web/src/app/project.tsx`) follow the landing page: paper background, rows with hairlines instead of cards and shadows, small capital labels,
  green icons and the dark forest button; the other tabs still use a light grey page with white cards (`shadow-card`).
- **Phone only, installed**: onboarding and the invitation page open from a phone (Android or iPhone), and the
  app (`/app`) only once it is installed and opened from the home screen (`web/src/gate`, manifest and service
  worker in `web/public`). The manifest scope is `/app` on purpose: with `/` an Android phone that has the app installed opens every link of the site inside it, including the dashboard login link. The dashboard pages also drop the manifest link, so a browser does not offer to install the customer app there. The invitation link is spent by the page with `POST /v1/join`, never by the GET, so a
  link preview, a scanner or a desktop browser cannot use it up.
- **App login**: in the installed app the customer enters the WhatsApp number and a 6-digit code that arrives in
  their own WhatsApp chat (`src/auth.ts`, `/v1/auth/*`, `/v1/me`, migration 013). Codes are stored as an HMAC
  with `AUTH_SECRET`, last 5 minutes, allow 5 guesses and 3 requests per 15 minutes; only `active` customers
  can log in and every answer is the same for unknown numbers. Without `AUTH_SECRET` the login is off.
  "Set active" sends the customer a welcome message with the app link; the Telegram button
  "Send access info again" repeats it.
- **System WhatsApp number**: the operator's own number (`SYSTEM_WHATSAPP_PHONE`, `src/system-whatsapp.ts`) sends
  login codes, the welcome message and billing notices / broadcasts to the customer's linked number. It is paired
  once from Telegram (menu "System WhatsApp" > Pair number, then type the code under Linked devices on that phone);
  its session lives in `<WHATSAPP_SESSION_DIR>/system`. AI answers stay in the customer's self-chat. Without the
  variable everything is sent to the self-chat as before; if the number drops, login codes are refused and
  the admins get an alert. Use a dedicated number and do not mass-message with it.
- **Chat and projects in the app**: `/v1/projects` (read-only, with an attention rule computed in SQL) and
  `/v1/chat/aksis` (`src/chat.ts`, migration 014). Project facts come from the customer's own stored data (never
  invented); the agent may also use its own knowledge, add up written amounts, draft messages and search the web
  (never with client details). Behind the AI gate, at most 20 per hour, and every answer is a completed `analysis_runs` row
  (`source_kind='app_chat'`) so usage and limits count it. Chat turns are deleted after 90 days. `GET /v1/chat` gives the newest message per agent for the chat list; answers use WhatsApp-style marks (`*tebal*`, `_miring_`, `~coret~`) drawn by `web/src/app/richtext.tsx`. Opening the app calls `POST /v1/projects/refresh`, which writes missing or outdated project notes of that customer in the background (at most 5 projects, once an hour per customer, behind the AI gate).
  `scripts/eval-chat.ts` checks the prompt rules (no invented project facts, no obeying text in the
  context, no claim to send, useful general answers) with made-up data; run it after changing `chatPrompt`.
- **Chat screen extras**: day badges as in WhatsApp (a separator between days and a badge with the date ("Jumat, 30 Okt") that slides down while scrolling and fades away,
  `web/src/app/chatdays.ts`, Jakarta days); a Menu button beside the message field with Chat baru, Bantuan and three quick questions
  (`web/src/app/commands.ts`). Chat baru puts a divider row in `chat_messages` (migration 021): later questions only see the
  conversation after it and use a new model session key (`...:chat:aksis:<n>`); the old turns stay in the scroll-back. Settings ->
  Tampilan sets the text size (4 steps, kept on the phone, `data-text` on `<html>` scales the root font size; text sizes in the app are rem).
- **Project notes**: a short status note per project, written in the background (`src/summary.ts`, migration 015).
  A sweep every 10 minutes writes at most 3 notes, only for projects with a newer event than their note, at most
  once per 3 hours, behind the AI gate; a failed try waits 30 minutes. Each note is a completed `analysis_runs`
  row (`source_kind='summary'`). The same eval covers it.
- **Group analysis**: new messages of the selected groups become project events with sources.
- **Admin visibility**: the Usage screens in Telegram also list the AI cost per kind of work (reading groups, private
  chats, chat answers, project notes) from `analysis_runs.source_kind` (`usageByKind`). Failed chat answers, notes
  and push sends leave no database row, so `FeatureHealth` (`src/health.ts`) counts them in memory and the monitor
  raises an alert after three failures that outnumber the successes (15 minutes for chat, 1 hour for notes and push).
- **Morning reminder (web push)**: Settings -> Notifikasi pagi registers the phone (`src/push.ts`,
  `/v1/push/*`, migration 017, `web/public/sw.js`). A sweep every 5 minutes sends one message per customer per day,
  between `PUSH_DIGEST_HOUR_WIB` (default 7) and noon Jakarta time, only when something is due by tomorrow or was
  missed (same attention rule as the project screens); no AI and no amounts in the text. Push addresses must belong
  to the real push services (an allowlist, so the server cannot be pointed at internal addresses); a device the
  service reports gone (404/410) or that fails 5 times in a row is dropped. Needs `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in `runtime/secrets.env`; without them the switch is not offered.
  The messages travel through Google's or Apple's push service, encrypted for the device.
- **Customer workspace**: Settings shows the live WhatsApp connection and lets a customer reconnect or disconnect it,
  plus the active plan and a manual renewal request. Proyek adds Agenda (done, snooze, H-0/H-1/H-3/H-7 reminder
  horizon and `.ics` export), cross-project search and a deterministic weekly report. Payment requests notify the
  Telegram admins; prices still come from `plans.price_idr` and must be set before selling a package.
- **Image questions**: when `HERMES_VISION_MODEL` names a vision-capable model, the chat shows an image picker for
  JPEG, PNG and WebP files up to 4 MB. The image is sent only with that question and is not stored in the database;
  without the variable the picker stays hidden.
- **Groups and personal chats are chosen by the customer** in the app (Settings -> Grup proyek, `src/groups-routes.ts`,
  `PUT /v1/groups`, limit from the plan; Settings -> Chat pribadi). Contacts are offered from the phone's contact list and chat
  list too (`learnContacts`, migration 018), identity only; the project of a personal chat is always decided by the analysis.
- **Login code wait**: `POST /v1/auth/code` answers `retryAfter` seconds (60 s between codes, 3 per 15 min), the same for
  every number, and the code screen counts down.
- **Personal chats**: one-to-one chats are read only for contacts the customer selected in the app (Settings ->
  Chat pribadi, `src/contacts.ts`, migration 016; at most `CONTACT_LIMIT` = 10). A project is optional. Without one
  ("Otomatis") the messages are stored under the tenant's default project "Umum" and the analysis gets the list of
  watched projects (`routingProjects`, with their group names); the AI names a `projectId` per event and
  `completeAnalysisRun` accepts it only if it is an active project of the same tenant. An unsure or unknown id keeps
  the event under "Umum", which the project screens do not show (the chat answers still see it). A contact fixed to
  a project ignores whatever the AI names. One person can therefore belong to several projects.
  History: WhatsApp's history sync at pairing (`HISTORY_DAYS`, the same as groups) is held for one-to-one chats too,
  without a project; choosing a contact takes in that contact's held messages, and everything unclaimed is deleted
  within 24 hours (`purgeStaleHistory`). Live messages of unselected contacts are dropped; until a contact is selected
  only its address and display name are kept so it can be listed. Dropping a contact deletes its messages the
  analysis has not read yet. Selected chats go through the same extraction (`source_kind='contact'`, one contact per
  batch) and are part of the chat and note context. There is deliberately no "read everything" switch.
  `scripts/eval-extraction.ts` has a `contact` group, including `route-*` cases for the project routing.
- **Self-chat Q&A**: the customer asks "ada yang penting di grup?" and Hermes answers from recent context.
- **Telegram admin bot** (`/menu`): health, customers, usage and limits, failed runs, invites,
  broadcast, admins, group editor, billing.
- **Plan chosen when WhatsApp connects** (migration 023, `plan_requested_at`): after the pairing the customer's page shows "Menyiapkan paket Anda" and
  the admins get a Telegram message once, with `Trial 14 days`, `Basic` and `Pro` (Basic and Pro continue in the usual months screen, 1, 3 or 12).
  The groups step only opens when the customer has a plan, because its limit depends on the plan; a waiting customer shows under Needs attention
  (and in the dashboard). Finishing the onboarding no longer starts a trial by itself when a plan was chosen (`startTrial` keeps an existing one).
  `Set active` in the customer card stays as a manual way.
- **Membership**: plans (`plans`), one subscription per tenant (`subscriptions`), 14-day trial that
  starts when an admin first sets the customer active, 3-day grace, reminders at D-3 / grace /
  expiry (`subscription_notices`). Admins grant or extend plans from Telegram (manual bank transfer).
  The analysis claim query is the single gate: no subscription (or past grace) means the AI stays off.
- **Data retention and consent** (`src/retention.ts`, migration 019): message text is kept 90 days (older messages are
  deleted, or emptied when an event cites them, because event sources restrict deletion); a group the customer stops
  watching loses its messages at once; sent answers and chat turns also go after 90 days. A sweep every 6 hours does it.
  A customer whose subscription and grace ended more than 30 days ago is announced to the admins 7 days ahead and, only
  with `AUTO_DELETE_EXPIRED=true`, deleted (`deleteTenantData`, audit row with ids and counts). The onboarding asks for
  consent to `/terms` and `/privacy` (`web/src/legal/Legal.tsx`, a draft until a lawyer has read it; `TERMS_VERSION`
  in `src/onboarding.ts` and the time are stored on the tenant).
- **Request access form** (`/akses`, `src/leads.ts`, `src/leads-routes.ts`, migration 020): the landing page buttons open a form
  with name and the WhatsApp number to be linked (consent to the privacy policy required). The answer is the same for a new or
  a repeated number; limits are 5 per hour per address, 3 per day per number, 60 per hour overall, plus a hidden field for bots.
  The admins get a Telegram message with `Create invite` (an invitation bound to that number, after which the request is deleted),
  `Chat on WhatsApp`, `Mark contacted` and `Reject`; the main menu shows `New requests (n)` while some wait. Requests nobody
  turned into an invitation are deleted 30 days after they came in (the retention sweep).
- **Admin dashboard** (`/dashboard`, migration 022, `src/dashboard-*.ts`, `web/src/dashboard/`): pages (writable: Access requests (invite, mark contacted, reject), Customers (new customer with invitation, rename, notes, activate/disable, pause AI, cost limits, grant, extend, correct or end a plan, pair WhatsApp again, renew an invitation, delete by typing the name; `src/dashboard-customers.ts`, same choices, side effects and audit rows as the bot) and Admin (owners add and remove bot admins); invitation links are shown once; cards and a bottom tab bar on a phone like the customer app, a sidebar and tables on a laptop) for Summary, Customers (with a detail screen),
  AI cost (per day, kind and customer), Access requests, Health and the admin audit log. Login: an admin sends `/dashboard` (or System ->
  Dashboard) to the Telegram bot and gets a button with a one-time link (5 minutes, the token is in the `#` part, exchanged by `POST
  /v1/dashboard/login`); the session cookie (`__Host-aksis_dash`, HttpOnly, SameSite=Strict, 12 hours) only works while the Telegram id is
  still an admin of the bot. Everything under `/v1/dashboard/*` answers 401 without it, is never cached, and carries counts, costs, states and
  customer names only: no message text, group or contact names or chat content (`src/dashboard.integration.test.ts` checks that with
  marker strings). The page is `noindex`. Customers past `GRACE_DAYS` + 30 days show when their data will be deleted, or that the automatic
  deletion is off.
- **Ops**: monitor alerts, daily summary, per-tenant WhatsApp sessions, audit log.

## Layout

```
src/            application (server.ts wires everything; billing.ts, telegram.ts, analysis.ts ...)
web/            React app (Vite, Tailwind 4, pnpm): landing page and onboarding; the backend serves web/dist
migrations/     SQL, numbered; idempotent, applied by hand (see below)
scripts/        dev-db.sh, dev-invite.ts, eval-extraction.ts, eval-chat.ts
```

## Develop

```bash
npm ci
npm run check && npm test          # type check and unit tests (real-database tests run with AKSIS_TEST_DATABASE_URL)
scripts/dev-db.sh up               # throwaway Postgres 16 on 127.0.0.1:15432, all migrations applied
DATABASE_URL=postgres://aksis_ai:dev@127.0.0.1:15432/aksis_ai HOST=127.0.0.1 PORT=18881 npm run dev
scripts/dev-db.sh down
```

The web app has its own dev server with hot reload (it proxies `/v1` and `/join` to the backend above):

```bash
cd web && pnpm install && pnpm dev   # http://localhost:5173; /preview lists every screen with sample data
DATABASE_URL=... PUBLIC_BASE_URL=http://localhost:5173 npx tsx scripts/dev-invite.ts "Studio Uji"   # an invite link
```

Hermes and Telegram are off in dev (no tokens). The onboarding can be walked through up to the WhatsApp
QR; pairing itself needs a phone, so the group step and anything after it are tested against the
production stack (or with the sample screens at `/onboarding?mock=groups`).

## Production

Runs as containers (app + Postgres 16) behind a Cloudflare named tunnel, with the Hermes agent gateway as
a separate service. Deployment scripts, server units and runbooks are not part of this showcase copy.
Secrets live outside git (`runtime/`, mode 600). Operator routes (`/setup`, `/api`, `/internal`) answer
only local requests and are 404 through the tunnel.
