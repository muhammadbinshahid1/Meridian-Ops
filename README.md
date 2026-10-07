# Meridian Health Ops

A Next.js 16 (App Router, TypeScript, Tailwind v4) dashboard for GTM outreach to
healthcare-adjacent companies: import a CSV of prospects, generate a personalized
cold email per prospect with an LLM, review/edit it, send it, and track status.
Includes a "warm vs cold" flag that cross-references prospects against the user's
own network.

Stack: Next.js (App Router, Proxy, Route Handlers) · Supabase (Postgres + Auth,
via `@supabase/ssr`) · direct Gmail OAuth (email delivery) · Gemini or Claude
(draft generation, switchable) · Tailwind v4 · Papaparse (CSV).

---

## Getting started

For a detailed, click-by-click walkthrough of every step below — including
the Google Cloud OAuth setup — see [`SETUP.md`](./SETUP.md).

1. **Install dependencies**: `npm install`
2. **Set up the database**: copy `sql/setup-all.sql` into the Supabase SQL
   Editor for your project and run it. It's idempotent — safe to re-run any
   time. Check the verification query at the bottom of the file: it should
   return 4 rows (`leads`, `network_contacts`, `settings`, `gmail_connection`),
   all with `rowsecurity = true`.
3. **Create a Google OAuth client** (for sending): in Google Cloud Console,
   create a project, enable the **Gmail API**, configure the OAuth consent
   screen (scopes: `gmail.send` and `userinfo.email`; publishing status can
   stay in **Testing** for a single-user setup), then create an OAuth Client
   ID (Web application) with redirect URI
   `<your-app-url>/api/auth/google/callback`.
4. **Configure environment variables**: copy `env.local.example` to
   `.env.local` and fill in real values — see §8 below for what each one is
   and where it comes from.
5. **Create the login user**: this app is single-user. Create that one user
   in your Supabase project's Authentication tab.
6. **Run it**: `npm run dev`, then open `http://localhost:3000`, sign in,
   and connect Gmail from the dashboard's Connections panel.

---

## 1. Directory map

```
app/
  page.tsx                 the dashboard (client component, everything lives here)
  login/page.tsx            email+password sign-in
  layout.tsx                root layout, fonts
  api/
    generate/route.ts       POST — AI-draft a lead's email
    send/route.ts           POST — send a lead's email via Gmail
    match/route.ts          POST — recompute Warm/Cold for every lead
    auth/google/
      route.ts               GET — redirect to Google's OAuth consent screen
      callback/route.ts       GET — exchange code, store the connection
    connections/
      route.ts                GET — Gmail connection status (no tokens)
      disconnect/route.ts     POST — remove the stored connection
lib/
  ai.ts                      provider-agnostic draft generation (Gemini/Claude)
  gmail.ts                   Gmail OAuth: connect flow, token refresh, sending
  crypto.ts                  AES-256-GCM encrypt/decrypt for tokens at rest
  supabase/
    client.ts                browser Supabase client (anon key)
    server.ts                server Supabase client bound to cookies + getUser()
    admin.ts                 service-role Supabase client (bypasses RLS)
proxy.ts                     auth gate (Next.js's request middleware)
sql/setup-all.sql            the database migration to run
env.local.example            template for .env.local
test-csv/                    sample CSVs for exercising import/matching
```

---

## 2. Authentication

**`proxy.ts`** (project root) is the auth gate, run on every request:

- Refreshes the Supabase session cookie.
- Calls `supabase.auth.getUser()` — this round-trips to Supabase to confirm
  the session token is actually still valid, rather than just trusting a
  cookie the browser presents.
- Unauthenticated page requests redirect to `/login`; unauthenticated
  `/api/*` requests get `401 { error }` JSON.
- Signed-in users visiting `/login` are redirected to `/`.

Every route handler (`generate`, `send`, `match`) also checks `getUser()`
itself and returns 401 independently — a route is never protected by only one
layer.

**`app/login/page.tsx`** — email + password sign-in via
`supabase.auth.signInWithPassword()`. Single user, no signup flow — this app
is not multi-tenant.

**Three separate Supabase clients**, each with a distinct trust level:

| File | Key used | Used from | Purpose |
|---|---|---|---|
| `lib/supabase/client.ts` | anon key | `'use client'` components | Browser reads/writes, gated by RLS |
| `lib/supabase/server.ts` | anon key | Server Components / route handlers | Identifies *who* is calling (`getUser()`) |
| `lib/supabase/admin.ts` | service-role key | Route handlers only, after auth check | Privileged writes, bypasses RLS entirely |

The service-role key never carries a `NEXT_PUBLIC_` prefix and is never
imported into a `'use client'` file — that would ship it to every browser.

---

## 3. Database (`sql/setup-all.sql`)

Run once in the Supabase SQL Editor.

**`leads`** (prospects) has: `name`, `email`, `title`, `company`, `notes`,
`subject`, `draft_content`, `status` (`Draft` / `Sent` / `Replied`),
`sent_at`, `replied_at`, `last_error`, `relationship` (`Warm` / `Cold`,
defaults `Cold`), and `match_note`. Email uniqueness is case-insensitive,
enforced via a generated `email_norm` column with a unique index on it.

**`network_contacts`** — the user's own network, used only for matching:
`name`, `email` (nullable — a network list can hold name-only entries),
`company`, `notes`. Same case-insensitive uniqueness approach on email.

**`settings`** — a singleton row holding `prompt_template`, the editable
prompt used for draft generation.

**`gmail_connection`** — a singleton row holding the connected Gmail
account's email and its encrypted OAuth tokens. This table has no access
policy for regular sessions at all — only the server-side admin client can
read or write it; the dashboard's Connections panel goes through
`app/api/connections/route.ts` rather than querying it directly.

**Row Level Security** is enabled on all tables. `leads`, `network_contacts`,
and `settings` each allow full access to any authenticated session (this is a
single-user app, so there's no per-row ownership to enforce — just "is
someone signed in at all").

---

## 4. AI draft generation

### `lib/ai.ts`
A provider-agnostic `generateDraft(prompt): Promise<{subject, body}>`.

- **Provider switch**: `AI_PROVIDER=gemini|anthropic` env var (defaults to
  `gemini`). Swapping providers is a config change, not a code change.
- **Retry policy**: retries on `408/429/500/502/503/504` (up to 3 attempts,
  exponential backoff with jitter); `400`/`401` never retry.
- **Timeout**: each attempt is bounded (~20s) so a hung upstream can't stall
  the request indefinitely.
- Empty model responses are treated as errors (with the provider's stated
  reason included), never silently saved as a blank draft.
- **`renderTemplate(template, ctx)`** fills in `{{name}}`, `{{title}}`,
  `{{company}}`, `{{notes}}`, `{{relationship}}`, `{{match_note}}`.
- The model is asked to reply with `{"subject": "...", "body": "..."}`; if
  parsing that fails, the raw response becomes the body with a default
  subject rather than failing outright.

### The prompt template
Lives in `settings.prompt_template`, editable from the dashboard's **Prompt**
panel. The seeded default wraps `{{notes}}` in triple quotes with an explicit
instruction to treat that text as data, not instructions — `notes` comes from
an uploaded CSV and should be treated as untrusted input. It also asks for a
greeting, a short body, and a sign-off line, while explicitly telling the
model not to invent a sender name underneath the sign-off (the real signature
is appended separately, from `SENDER_SIGNATURE`).

### `app/api/generate/route.ts`
Auth check → load the lead from the database by `leadId` → 409 if already
`Sent` → render the prompt template → generate → append `SENDER_SIGNATURE` to
the body → save `subject` + `draft_content`. On failure, writes the error to
`leads.last_error` so it's visible on the dashboard row.

---

## 5. Sending — direct Gmail OAuth

Outreach emails send from the user's own connected Gmail account.

### `lib/gmail.ts`
- `buildAuthUrl(state)` — builds the Google consent screen URL, requesting
  only `gmail.send` (narrow, send-only) and `userinfo.email`.
- `exchangeCodeForTokens()` / `refreshAccessToken()` — token exchange and
  refresh against Google's OAuth endpoint.
- `getConnection()` / `saveConnection()` / `deleteConnection()` — read/write
  the `gmail_connection` row, encrypting both tokens via `lib/crypto.ts`
  before they're ever written.
- `getValidAccessToken(conn)` — refreshes the access token when it's close to
  expiring, otherwise returns the cached one.
- `sendViaGmail(accessToken, mail)` — sends via the Gmail API.

### `lib/crypto.ts`
AES-256-GCM encryption for the stored OAuth tokens, keyed by
`OAUTH_TOKEN_ENCRYPTION_KEY` (a 32-byte base64 key). This is on top of
`gmail_connection` already having no regular access policy — a leaked
refresh token would otherwise be a standing "send email as this account"
capability until manually revoked at Google.

### The connect flow (`app/api/auth/google/*`)
Initiate route: auth check → generate a CSRF `state` token, stored in an
httpOnly cookie → redirect to Google. Callback route: auth check → verify
`state` → exchange the code → look up the connected email → save the
connection → redirect back to the dashboard with a status message.

### `app/api/send/route.ts`
Accepts only `{ leadId }` — recipient, subject, and body are always read from
the database, never trusted from the request. This means the text a user
reviewed and approved is guaranteed to be the text that's actually sent.

- 409 if the lead's already `Sent`, 404 if it doesn't exist, 400 if there's
  no draft or no Gmail account connected.
- If the send itself fails, `leads.last_error` is set, the response is a
  502, and status stays `Draft` — never `Sent` unless the send genuinely
  succeeded.
- If the send succeeds but the follow-up status update fails to save, the
  response is `200` with a `warning` field rather than an error — this
  avoids the risk of a user re-sending an email that already went out just
  because a database write hiccuped afterward.

A footer with `SENDER_POSTAL_ADDRESS` and an `UNSUBSCRIBE_URL` link is
appended at send time, independent of the signature (which is already part
of the reviewed draft — see §4).

---

## 6. Warm/Cold network matching

Prospects can be flagged as **Warm** (someone already in the user's network)
or **Cold**, based on exact matching against an uploaded network/contacts
list.

### `app/api/match/route.ts`
Recomputes every lead's relationship, in priority order:

1. **Email match** (case/whitespace-insensitive) → `Warm`,
   `match_note = "Email match: <name>"`.
2. **Name match** — both sides normalized (lowercased, leading titles like
   `Dr.`/`Mr.`/`Mrs.`/`Ms.`/`Prof.` stripped, punctuation removed, whitespace
   collapsed) → `Warm`, `match_note = "Name match: <name> (unverified)"`.
3. No match → `Cold`, `match_note = null`.

Email matches and name matches are recorded distinctly because they carry
different confidence — two different people can share a name, so the UI
shows which basis a Warm flag rests on. Matching is exact only, by design.

Every lead is recomputed from scratch on every run, so removing a network
contact correctly demotes any lead that had matched them back to `Cold`.
Matching runs automatically after either CSV import, and can be re-triggered
manually from the dashboard.

### Frontend surface
- A **Network** panel with its own **"Import my network (CSV)"** upload,
  kept visually distinct from **"Import prospects (CSV)"**. Lists imported
  contacts with a remove action.
- A Warm/Cold badge on each contact, with the match reason shown as a
  tooltip, and a click-to-override for correcting a false positive.
- Header counts (`N warm · N cold`) and an All/Warm/Cold filter.
- `relationship`/`match_note` are included in the CSV export.

---

## 7. Frontend dashboard (`app/page.tsx`)

A few notable behaviors:

- Draft and subject text are controlled state, and any in-progress edit is
  persisted before a send request is made — the reviewed text is always what
  gets sent, with no race between editing and sending.
- Background refreshes never overwrite a field the user is actively editing.
- Each row's busy/loading state is tracked independently, so an action on
  one contact doesn't disable the whole table.
- **Bulk drafting** ("Draft all") runs with a concurrency limit of 3 rather
  than all at once, to stay under AI provider rate limits on large imports.
- **CSV import** strips a UTF-8 byte-order mark from headers (so Excel
  exports work), whitelists known columns (extra columns are ignored rather
  than causing an error), validates every row individually and reports
  specific row numbers and reasons, and upserts on email so re-importing the
  same file reports duplicates instead of creating them.
- One dismissible notice banner surfaces every error or confirmation, sourced
  from a shared fetch helper that always checks the response status.
- The Connections panel is the one part of the UI that talks to a route
  handler instead of Supabase directly, since `gmail_connection` isn't
  readable by a normal session (see §3/§5). "Approve and send" is disabled
  with an explanatory hint whenever no Gmail account is connected.

---

## 8. Environment variables (`env.local.example`)

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Public, RLS-gated |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only, bypasses RLS — never expose |
| `AI_PROVIDER` | no (defaults `gemini`) | `gemini` \| `anthropic` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | if using Gemini | avoid `-latest` model aliases in production |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | if using Claude | |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | from the Google Cloud OAuth client — see Getting started |
| `OAUTH_REDIRECT_BASE_URL` | yes | must exactly match the redirect URI registered in Google Cloud Console |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | yes | 32-byte base64 key; rotating it invalidates the stored Gmail connection |
| `SENDER_SIGNATURE` | for a proper sign-off | multi-line supported (name + title) |
| `SENDER_POSTAL_ADDRESS` / `UNSUBSCRIBE_URL` | for CAN-SPAM compliance | appended to every sent email |
