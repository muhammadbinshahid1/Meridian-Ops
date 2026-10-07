# Setup Guide

Step-by-step instructions for getting this project running on a fresh
machine — filling in `.env.local` and connecting Supabase, the AI provider,
and Gmail sending.

Before starting, copy `env.local.example` to a new file named `.env.local` in
the project root. You'll fill in each value below as you go.

**Two corrections to make to the `.env.local` you're starting from**, before
anything else:
1. It's missing a `SENDER_POSTAL_ADDRESS` line entirely — add
   `SENDER_POSTAL_ADDRESS=` under the Footer Details section. This is
   required: US commercial email law requires a physical postal address on
   outreach emails, and the app won't include one unless this is set.
2. `SENDER_SIGNATURE = "Your Name Here"` has spaces around the `=` — remove
   them: `SENDER_SIGNATURE="Your Name Here"`. Env files should never have
   spaces around `=`.

Every line starts commented out with `#` — as you fill in a value, remove the
leading `#` so the line actually takes effect.

---

## Step 1 — Supabase (database + login)

1. Go to [supabase.com](https://supabase.com), sign in, and click **New
   project**. Pick any name/region/password (the password here is for
   Postgres directly, not for logging into the app — you won't need it
   again).
2. Once the project finishes provisioning, go to **Project Settings** (gear
   icon, bottom of the left sidebar) → **API**.
3. You'll see three values — copy each into `.env.local`:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon / public** key (under Project API keys) → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** key (same section, click to reveal) → `SUPABASE_SERVICE_ROLE_KEY`
     — keep this one especially private, it bypasses all database security rules.
4. In the left sidebar, click **SQL Editor** → **New query**.
5. Open `sql/setup-all.sql` from this project, copy its entire contents,
   paste into the query editor, and click **Run**.
6. Scroll to the query result at the bottom — it should show 4 rows
   (`leads`, `network_contacts`, `settings`, `gmail_connection`), each with
   `rowsecurity = true`. If you see an error instead, stop and re-check
   you copied the whole file.
7. In the left sidebar, click **Authentication** → **Users** → **Add user**
   → **Create new user**. Enter the email and password you'll use to log
   into the app itself (this is separate from your Supabase account login).
   This app supports exactly one user — this is that user.

---

## Step 2 — AI provider (drafts generation)

By default this app uses Google's Gemini. You can switch to Anthropic's
Claude later by changing one line — no code changes needed.

**Using Gemini (default):**
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   and sign in with a Google account.
2. Click **Create API key**, then copy it.
3. In `.env.local`:
   - `AI_PROVIDER=gemini`
   - `GEMINI_API_KEY=<the key you just copied>`
   - `GEMINI_MODEL=gemini-3.6-flash` (this is a sensible default — avoid
     switching to a `-latest` alias, since those can silently change which
     model you're using without warning)

**Using Claude instead:** get an API key from
[console.anthropic.com](https://console.anthropic.com), then set
`AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=<key>`, and
`ANTHROPIC_MODEL=claude-sonnet-5`.

---

## Step 3 — Google Cloud OAuth client (Gmail sending)

This is the longest step. It lets the app send emails from a real, connected
Gmail account.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   sign in.
2. Click the project dropdown at the top → **New Project**. Give it any
   name (e.g. "Meridian Outreach") → **Create**. Once created, make sure
   it's selected in that same dropdown.
3. In the search bar at the top, type **Gmail API** → open it → click
   **Enable**.
4. In the left sidebar, go to **APIs & Services** → **OAuth consent
   screen**.
   - **User type**: choose **External** → **Create**.
   - Fill in the required fields (app name, your email as support contact
     and developer contact). You don't need a homepage or logo.
   - **Scopes**: click **Add or Remove Scopes**, and manually add these two
     by pasting them into the filter box: `https://www.googleapis.com/auth/gmail.send`
     and `https://www.googleapis.com/auth/userinfo.email`. Save.
   - **Test users**: click **Add Users**, and add the exact Gmail address
     that will actually be used to send outreach emails. This step matters —
     only addresses on this list will be able to connect.
   - Finish the wizard. **Leave the app in "Testing" status — do not click
     Publish.** Testing mode works fully for up to 100 listed test users and
     avoids Google's app-verification review process, which isn't needed for
     a single connected account.
5. In the left sidebar, go to **APIs & Services** → **Credentials**.
6. Click **Create Credentials** → **OAuth client ID**.
   - **Application type**: **Web application**.
   - **Authorized redirect URIs**: click **Add URI** and enter
     `http://localhost:3000/api/auth/google/callback` (while running
     locally). If you later deploy this to a real domain, add a second URI
     here for that domain too, e.g.
     `https://your-domain.com/api/auth/google/callback`.
   - Click **Create**. A popup shows your **Client ID** and **Client
     secret** — copy both.
7. In `.env.local`:
   - `GOOGLE_CLIENT_ID=<client ID>`
   - `GOOGLE_CLIENT_SECRET=<client secret>`
   - `OAUTH_REDIRECT_BASE_URL=http://localhost:3000` (update this if/when
     you deploy to a real domain — it must always match a URI you registered
     in step 6)

---

## Step 4 — Token encryption key

The app encrypts the Gmail connection's tokens before storing them. Generate
a key for this:

1. Open a terminal in the project folder and run:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. Copy the output string into `.env.local` as:
   `OAUTH_TOKEN_ENCRYPTION_KEY=<the output>`

Keep this value stable once set — changing it later invalidates the stored
Gmail connection, and Connect Gmail would need to be done again.

---

## Step 5 — Sender/compliance details

These appear on every email that gets sent.

- `SENDER_SIGNATURE` — your name and title, shown as the sign-off on every
  drafted email. Multi-line is supported:
  ```
  SENDER_SIGNATURE="Jane Smith
  Business Development"
  ```
- `SENDER_POSTAL_ADDRESS` — a physical mailing address, appended to every
  sent email. Legally required for commercial email in the US.
- `UNSUBSCRIBE_URL` — a link recipients can use to opt out. If you don't have
  a dedicated unsubscribe page yet, this can point anywhere reasonable for
  now (e.g. a contact page), but it should exist.

---

## Step 6 — Run it

1. `npm install`
2. `npm run dev`
3. Open `http://localhost:3000` — you should land on the login page.
4. Sign in with the user you created in Step 1.7.
5. In the dashboard header, click **Connect Gmail** and complete Google's
   consent screen using the same account you added as a test user in Step
   3.4. Once connected, the header will show **Gmail connected**.
6. Import a prospect CSV and try generating and sending a draft to confirm
   everything is wired up correctly end to end.

If you change anything in `.env.local` after the server is already running,
stop it (Ctrl+C) and run `npm run dev` again — environment variables are
only read once, at startup.
