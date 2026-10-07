'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Papa from 'papaparse';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Inbox,
  LogOut,
  Mail,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Trash2,
  Unlink,
  Upload,
  Users,
  Wand2,
  X,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

const supabase = createClient();

type Status = 'Draft' | 'Sent' | 'Replied';
type Relationship = 'Warm' | 'Cold';

type Lead = {
  id: string;
  name: string;
  email: string;
  title?: string | null;
  company?: string | null;
  notes?: string | null;
  subject?: string | null;
  draft_content?: string | null;
  status: Status;
  created_at?: string;
  sent_at?: string | null;
  replied_at?: string | null;
  last_error?: string | null;
  relationship?: Relationship | null;
  match_note?: string | null;
};

type NetworkContact = {
  id: string;
  name: string;
  email?: string | null;
  company?: string | null;
  notes?: string | null;
};

type GmailConnectionState = {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
};

/** Fields we are willing to insert. Anything else in the CSV is ignored. */
const IMPORT_FIELDS = ['name', 'email', 'title', 'company', 'notes'] as const;
const NETWORK_IMPORT_FIELDS = ['name', 'email', 'company', 'notes'] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Excel writes a byte-order mark, which otherwise turns the first CSV header
// into "<BOM>name" and silently drops every row. Built via fromCharCode to
// avoid an invisible character sitting in the source file.
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);

const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—';

/** Runs tasks with a fixed number in flight, so a 200-row import can't fan out. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (next !== undefined) await worker(next);
    }
  });
  await Promise.all(runners);
}

export default function MeridianDashboard() {
  const router = useRouter();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [networkContacts, setNetworkContacts] = useState<NetworkContact[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [subjects, setSubjects] = useState<Record<string, string>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [matching, setMatching] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [template, setTemplate] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showNetwork, setShowNetwork] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [relationshipFilter, setRelationshipFilter] = useState<'All' | Relationship>('All');
  const [connection, setConnection] = useState<GmailConnectionState | null>(null);

  const setBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const fetchLeads = useCallback(async () => {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      setNotice({ tone: 'error', text: `Could not load contacts: ${error.message}` });
      return;
    }

    const rows = (data ?? []) as Lead[];
    setLeads(rows);

    // Seed the editors, but never overwrite text the user is mid-edit on.
    setDrafts((prev) => {
      const next = { ...prev };
      rows.forEach((l) => {
        if (!(l.id in next)) next[l.id] = l.draft_content ?? '';
      });
      return next;
    });
    setSubjects((prev) => {
      const next = { ...prev };
      rows.forEach((l) => {
        if (!(l.id in next)) next[l.id] = l.subject ?? '';
      });
      return next;
    });
  }, []);

  const fetchNetworkContacts = useCallback(async () => {
    const { data, error } = await supabase
      .from('network_contacts')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      setNotice({ tone: 'error', text: `Could not load your network: ${error.message}` });
      return;
    }
    setNetworkContacts((data ?? []) as NetworkContact[]);
  }, []);

  // gmail_connection has no RLS policy at all (see sql/002_gmail_connection.sql)
  // — only the service-role admin client can read it, so this has to go
  // through a route handler rather than the browser Supabase client used
  // everywhere else on this page.
  const fetchConnection = useCallback(async () => {
    const res = await fetch('/api/connections');
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNotice({ tone: 'error', text: `Could not load Gmail connection: ${payload.error}` });
      return;
    }
    setConnection(payload as GmailConnectionState);
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([fetchLeads(), fetchNetworkContacts(), fetchConnection()]);
      const { data } = await supabase
        .from('settings')
        .select('prompt_template')
        .eq('id', 1)
        .single();
      if (data) setTemplate(data.prompt_template);

      // Surface the OAuth callback's result once, then strip it from the URL
      // so a page refresh doesn't re-show it.
      const params = new URLSearchParams(window.location.search);
      const connected = params.get('connected');
      const connectError = params.get('connect_error');
      if (connected) setNotice({ tone: 'info', text: 'Gmail connected.' });
      if (connectError) setNotice({ tone: 'error', text: connectError });
      if (connected || connectError) router.replace('/');
    })();
  }, [fetchLeads, fetchNetworkContacts, fetchConnection, router]);

  // -----------------------------------------------------------------------
  // Fetch helper / warm-cold matching
  // -----------------------------------------------------------------------
  const post = async (url: string, body?: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status}).`);
    return payload;
  };

  const runMatch = useCallback(async () => {
    setMatching(true);
    try {
      const result = await post('/api/match');
      await fetchLeads();
      return result as { warm: number; cold: number; updated: number };
    } catch (err) {
      setNotice({ tone: 'error', text: `Matching failed: ${(err as Error).message}` });
      return null;
    } finally {
      setMatching(false);
    }
  }, [fetchLeads]);

  // -----------------------------------------------------------------------
  // Import — prospects
  // -----------------------------------------------------------------------
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const input = e.target;

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.replace(BOM_RE, '').trim().toLowerCase(),
      transform: (v) => (typeof v === 'string' ? v.trim() : v),
      complete: async ({ data }) => {
        input.value = '';

        const valid: Record<string, string>[] = [];
        const problems: string[] = [];

        data.forEach((row, i) => {
          const line = i + 2; // +1 for the header, +1 for 1-based counting
          if (!row.name) return problems.push(`Row ${line}: missing name`);
          if (!row.email) return problems.push(`Row ${line}: missing email`);
          if (!EMAIL_RE.test(row.email))
            return problems.push(`Row ${line}: "${row.email}" is not a valid email`);

          valid.push(Object.fromEntries(IMPORT_FIELDS.map((f) => [f, row[f] ?? null])));
        });

        if (!valid.length) {
          setNotice({
            tone: 'error',
            text: `Nothing imported. The file needs name and email columns. ${problems
              .slice(0, 5)
              .join('; ')}`,
          });
          return;
        }

        // Conflict target is email_norm (a generated lower(trim(email))
        // column) rather than email — Postgres can only match ON CONFLICT
        // against a real unique index, and the DB-level uniqueness guarantee
        // is case-insensitive. See sql/001_fix_schema.sql.
        const { data: inserted, error } = await supabase
          .from('leads')
          .upsert(valid, { onConflict: 'email_norm', ignoreDuplicates: true })
          .select('id');

        if (error) {
          setNotice({ tone: 'error', text: `Import failed: ${error.message}` });
          return;
        }

        const added = inserted?.length ?? 0;
        const skipped = valid.length - added;
        setNotice({
          tone: problems.length ? 'error' : 'info',
          text: [
            `${added} contact${added === 1 ? '' : 's'} imported.`,
            skipped > 0 && `${skipped} already in the list.`,
            problems.length &&
              `${problems.length} row${problems.length === 1 ? '' : 's'} skipped — ${problems
                .slice(0, 5)
                .join('; ')}${problems.length > 5 ? '…' : ''}`,
          ]
            .filter(Boolean)
            .join(' '),
        });

        await fetchLeads();
        await runMatch();
      },
      error: (err) => setNotice({ tone: 'error', text: `Could not read the file: ${err.message}` }),
    });
  };

  // -----------------------------------------------------------------------
  // Import — the user's own network (for warm/cold matching)
  // -----------------------------------------------------------------------
  const handleNetworkFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const input = e.target;

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.replace(BOM_RE, '').trim().toLowerCase(),
      transform: (v) => (typeof v === 'string' ? v.trim() : v),
      complete: async ({ data }) => {
        input.value = '';

        const valid: Record<string, string | null>[] = [];
        const problems: string[] = [];

        data.forEach((row, i) => {
          const line = i + 2;
          if (!row.name) return problems.push(`Row ${line}: missing name`);
          // Unlike prospects, email is optional here — a network list can
          // hold name-only entries.
          if (row.email && !EMAIL_RE.test(row.email))
            return problems.push(`Row ${line}: "${row.email}" is not a valid email`);

          valid.push(Object.fromEntries(NETWORK_IMPORT_FIELDS.map((f) => [f, row[f] || null])));
        });

        if (!valid.length) {
          setNotice({
            tone: 'error',
            text: `Nothing imported. The file needs a name column. ${problems
              .slice(0, 5)
              .join('; ')}`,
          });
          return;
        }

        // Rows without an email can't go through upsert (there's nothing to
        // conflict on), so they're always plain inserts.
        const withEmail = valid.filter((v) => v.email);
        const withoutEmail = valid.filter((v) => !v.email);

        const [emailResult, plainResult] = await Promise.all([
          withEmail.length
            ? supabase
                .from('network_contacts')
                .upsert(withEmail, { onConflict: 'email_norm', ignoreDuplicates: true })
                .select('id')
            : Promise.resolve({ data: [] as { id: string }[], error: null }),
          withoutEmail.length
            ? supabase.from('network_contacts').insert(withoutEmail).select('id')
            : Promise.resolve({ data: [] as { id: string }[], error: null }),
        ]);

        const error = emailResult.error || plainResult.error;
        if (error) {
          setNotice({ tone: 'error', text: `Import failed: ${error.message}` });
          return;
        }

        const added = (emailResult.data?.length ?? 0) + (plainResult.data?.length ?? 0);
        const skipped = withEmail.length - (emailResult.data?.length ?? 0);

        setNotice({
          tone: problems.length ? 'error' : 'info',
          text: [
            `${added} network contact${added === 1 ? '' : 's'} imported.`,
            skipped > 0 && `${skipped} already in the list.`,
            problems.length &&
              `${problems.length} row${problems.length === 1 ? '' : 's'} skipped — ${problems
                .slice(0, 5)
                .join('; ')}${problems.length > 5 ? '…' : ''}`,
          ]
            .filter(Boolean)
            .join(' '),
        });

        await fetchNetworkContacts();
        await runMatch();
      },
      error: (err) => setNotice({ tone: 'error', text: `Could not read the file: ${err.message}` }),
    });
  };

  const removeNetworkContact = async (contact: NetworkContact) => {
    if (!confirm(`Remove ${contact.name} from your network? This cannot be undone.`)) return;
    const { error } = await supabase.from('network_contacts').delete().eq('id', contact.id);
    if (error) {
      setNotice({ tone: 'error', text: `Could not remove: ${error.message}` });
      return;
    }
    await fetchNetworkContacts();
    await runMatch();
  };

  // -----------------------------------------------------------------------
  // Generate / send
  // -----------------------------------------------------------------------
  const generate = async (lead: Lead) => {
    setBusy(lead.id, true);
    try {
      const { subject, body } = await post('/api/generate', { leadId: lead.id });
      setDrafts((p) => ({ ...p, [lead.id]: body }));
      setSubjects((p) => ({ ...p, [lead.id]: subject }));
      await fetchLeads();
    } catch (err) {
      setNotice({ tone: 'error', text: `${lead.name}: ${(err as Error).message}` });
    } finally {
      setBusy(lead.id, false);
    }
  };

  const generateAll = async () => {
    const targets = leads.filter((l) => l.status === 'Draft' && !l.draft_content);
    if (!targets.length) {
      setNotice({ tone: 'info', text: 'Every contact already has a draft.' });
      return;
    }

    setBulk({ done: 0, total: targets.length });
    await pool(targets, 3, async (lead) => {
      await generate(lead);
      setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
    });
    setBulk(null);
  };

  /** Persists any edit, then sends. The route re-reads from the database, so
   *  the reviewed text is guaranteed to be the text that goes out. */
  const send = async (lead: Lead) => {
    setBusy(lead.id, true);
    try {
      const body = (drafts[lead.id] ?? '').trim();
      const subject = (subjects[lead.id] ?? '').trim();
      if (!body) throw new Error('The draft is empty.');

      const { error } = await supabase
        .from('leads')
        .update({ draft_content: body, subject })
        .eq('id', lead.id);
      if (error) throw new Error(`Could not save your edit: ${error.message}`);

      const result = await post('/api/send', { leadId: lead.id });
      setNotice(
        result.warning
          ? { tone: 'error', text: result.warning }
          : { tone: 'info', text: `Sent to ${lead.name}.` }
      );
      await fetchLeads();
    } catch (err) {
      setNotice({ tone: 'error', text: `${lead.name}: ${(err as Error).message}` });
    } finally {
      setBusy(lead.id, false);
    }
  };

  const saveEdit = async (lead: Lead) => {
    const body = drafts[lead.id] ?? '';
    const subject = subjects[lead.id] ?? '';
    if (body === (lead.draft_content ?? '') && subject === (lead.subject ?? '')) return;

    const { error } = await supabase
      .from('leads')
      .update({ draft_content: body, subject })
      .eq('id', lead.id);

    if (error) setNotice({ tone: 'error', text: `Edit not saved: ${error.message}` });
    else fetchLeads();
  };

  const markReplied = async (lead: Lead) => {
    const { error } = await supabase
      .from('leads')
      .update({ status: 'Replied', replied_at: new Date().toISOString() })
      .eq('id', lead.id);
    if (error) setNotice({ tone: 'error', text: `Could not update: ${error.message}` });
    else fetchLeads();
  };

  const discard = async (lead: Lead) => {
    if (!confirm(`Remove ${lead.name} from the list? This cannot be undone.`)) return;
    const { error } = await supabase.from('leads').delete().eq('id', lead.id);
    if (error) setNotice({ tone: 'error', text: `Could not remove: ${error.message}` });
    else fetchLeads();
  };

  /** Manual escape hatch — exact name matching produces false positives, so
   *  the user can flip a lead's relationship without waiting on a re-match. */
  const overrideRelationship = async (lead: Lead) => {
    const next: Relationship = lead.relationship === 'Warm' ? 'Cold' : 'Warm';
    const { error } = await supabase
      .from('leads')
      .update({ relationship: next, match_note: 'Manually set' })
      .eq('id', lead.id);
    if (error) setNotice({ tone: 'error', text: `Could not update: ${error.message}` });
    else fetchLeads();
  };

  // -----------------------------------------------------------------------
  // Export / settings / auth
  // -----------------------------------------------------------------------
  const exportCsv = () => {
    const csv = Papa.unparse(
      leads.map((l) => ({
        name: l.name,
        email: l.email,
        title: l.title ?? '',
        company: l.company ?? '',
        relationship: l.relationship ?? 'Cold',
        match_note: l.match_note ?? '',
        subject: l.subject ?? '',
        draft: l.draft_content ?? '',
        status: l.status,
        sent_at: l.sent_at ?? '',
      }))
    );

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `meridian-outreach-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveTemplate = async () => {
    const { error } = await supabase
      .from('settings')
      .update({ prompt_template: template, updated_at: new Date().toISOString() })
      .eq('id', 1);

    setNotice(
      error
        ? { tone: 'error', text: `Template not saved: ${error.message}` }
        : { tone: 'info', text: 'Prompt template saved.' }
    );
  };

  const disconnectGmail = async () => {
    if (!confirm('Disconnect Gmail? You will not be able to send until you reconnect.')) return;
    try {
      await post('/api/connections/disconnect');
      await fetchConnection();
      setNotice({ tone: 'info', text: 'Gmail disconnected.' });
    } catch (err) {
      setNotice({ tone: 'error', text: `Could not disconnect: ${(err as Error).message}` });
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  const counts = useMemo(
    () => ({
      draft: leads.filter((l) => l.status === 'Draft').length,
      sent: leads.filter((l) => l.status === 'Sent').length,
      replied: leads.filter((l) => l.status === 'Replied').length,
      warm: leads.filter((l) => l.relationship === 'Warm').length,
      cold: leads.filter((l) => (l.relationship ?? 'Cold') === 'Cold').length,
    }),
    [leads]
  );

  const visibleLeads = useMemo(
    () =>
      relationshipFilter === 'All'
        ? leads
        : leads.filter((l) => (l.relationship ?? 'Cold') === relationshipFilter),
    [leads, relationshipFilter]
  );

  const badge = (status: Status) =>
    status === 'Sent'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'Replied'
        ? 'bg-blue-100 text-blue-800'
        : 'bg-amber-100 text-amber-800';

  const relationshipBadge = (relationship?: Relationship | null) =>
    relationship === 'Warm' ? 'bg-orange-100 text-orange-800' : 'bg-slate-100 text-slate-600';

  const toggleButtonClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg transition ${
      active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
    }`;

  return (
    <main className="min-h-screen bg-linear-to-b from-slate-50 to-indigo-50/40 p-8 text-slate-900">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap justify-between items-center gap-4 bg-white p-6 rounded-2xl shadow-sm shadow-slate-200/60 border border-slate-200">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
              <Activity className="h-5 w-5" strokeWidth={2.25} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Meridian Health Ops</h1>
              <p className="text-sm text-slate-500">
                {leads.length} contacts · {counts.draft} to send · {counts.sent} sent ·{' '}
                {counts.replied} replied · {counts.warm} warm · {counts.cold} cold
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowConnections((s) => !s)}
              className={toggleButtonClass(showConnections || !!connection?.connected)}
            >
              <Mail className="h-4 w-4" />
              {connection?.connected ? 'Gmail connected' : 'Connect Gmail'}
            </button>
            <button onClick={() => setShowNetwork((s) => !s)} className={toggleButtonClass(showNetwork)}>
              <Users className="h-4 w-4" />
              Network
            </button>
            <button onClick={() => setShowSettings((s) => !s)} className={toggleButtonClass(showSettings)}>
              <SlidersHorizontal className="h-4 w-4" />
              Prompt
            </button>
            <button
              onClick={exportCsv}
              disabled={!leads.length}
              className="inline-flex items-center gap-1.5 border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-medium px-4 py-2 rounded-lg text-sm transition"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </button>
            <button
              onClick={generateAll}
              disabled={!!bulk}
              className="inline-flex items-center gap-1.5 border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-medium px-4 py-2 rounded-lg text-sm transition"
            >
              <Wand2 className="h-4 w-4" />
              {bulk ? `Drafting ${bulk.done}/${bulk.total}…` : 'Draft all'}
            </button>
            <label className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-4 py-2 rounded-lg text-sm cursor-pointer transition shadow-sm">
              <Upload className="h-4 w-4" />
              Import prospects (CSV)
              <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
            </label>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 px-2 py-2"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>

        {notice && (
          <div
            className={`flex justify-between items-start gap-4 rounded-xl border px-4 py-3 text-sm ${
              notice.tone === 'error'
                ? 'bg-red-50 border-red-200 text-red-800'
                : 'bg-blue-50 border-blue-200 text-blue-800'
            }`}
          >
            <div className="flex items-start gap-2.5">
              {notice.tone === 'error' ? (
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              )}
              <p>{notice.text}</p>
            </div>
            <button onClick={() => setNotice(null)} className="shrink-0 hover:opacity-70 transition">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {showConnections && (
          <div className="bg-white rounded-2xl shadow-sm shadow-slate-200/60 border border-slate-200 p-6 space-y-3">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-indigo-600" />
              <h2 className="font-semibold">Gmail connection</h2>
            </div>
            <p className="text-sm text-slate-500">
              Outreach emails send from this account. Replies land in its real inbox.
            </p>
            {connection?.connected ? (
              <div className="flex items-center justify-between">
                <span className="text-sm">
                  Connected as <span className="font-medium">{connection.email}</span>
                </span>
                <button
                  onClick={disconnectGmail}
                  className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-red-600 transition"
                >
                  <Unlink className="h-3.5 w-3.5" />
                  Disconnect
                </button>
              </div>
            ) : (
              <a
                href="/api/auth/google"
                className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-4 py-2 rounded-lg text-sm transition shadow-sm"
              >
                <Mail className="h-4 w-4" />
                Connect Gmail
              </a>
            )}
          </div>
        )}

        {showSettings && (
          <div className="bg-white rounded-2xl shadow-sm shadow-slate-200/60 border border-slate-200 p-6 space-y-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-indigo-600" />
              <h2 className="font-semibold">Prompt template</h2>
            </div>
            <p className="text-sm text-slate-500">
              Use {'{{name}}'}, {'{{title}}'}, {'{{company}}'}, {'{{notes}}'},{' '}
              {'{{relationship}}'} and {'{{match_note}}'} to drop in each contact&rsquo;s
              details.
            </p>
            <textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              rows={10}
              className="w-full text-xs font-mono border border-slate-300 rounded-lg p-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none transition"
            />
            <button
              onClick={saveTemplate}
              className="bg-slate-900 hover:bg-slate-700 text-white font-medium px-4 py-2 rounded-lg text-sm transition"
            >
              Save template
            </button>
          </div>
        )}

        {showNetwork && (
          <div className="bg-white rounded-2xl shadow-sm shadow-slate-200/60 border border-slate-200 p-6 space-y-4">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-indigo-600" />
                  <h2 className="font-semibold">Your network</h2>
                </div>
                <p className="text-sm text-slate-500 mt-1">
                  Contacts you already know. Prospects whose email or name matches one of these
                  are flagged Warm. Requires a{' '}
                  <code className="text-slate-700">name</code> column; <code className="text-slate-700">email</code>,{' '}
                  <code className="text-slate-700">company</code> and{' '}
                  <code className="text-slate-700">notes</code> are optional.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={runMatch}
                  disabled={matching}
                  className="inline-flex items-center gap-1.5 border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-medium px-3 py-2 rounded-lg text-sm transition"
                >
                  <RefreshCw className={`h-4 w-4 ${matching ? 'animate-spin' : ''}`} />
                  {matching ? 'Checking…' : 'Re-check network'}
                </button>
                <label className="inline-flex items-center gap-1.5 bg-slate-900 hover:bg-slate-700 text-white font-medium px-3 py-2 rounded-lg text-sm cursor-pointer transition">
                  <Upload className="h-4 w-4" />
                  Import my network (CSV)
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleNetworkFileUpload}
                  />
                </label>
              </div>
            </div>

            {networkContacts.length === 0 ? (
              <p className="text-sm text-slate-500">No network contacts imported yet.</p>
            ) : (
              <ul className="divide-y divide-slate-200 max-h-64 overflow-y-auto">
                {networkContacts.map((c) => (
                  <li key={c.id} className="flex justify-between items-center py-2 text-sm">
                    <div>
                      <span className="font-medium">{c.name}</span>{' '}
                      <span className="text-slate-500">
                        {[c.email, c.company].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <button
                      onClick={() => removeNetworkContact(c)}
                      className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-red-600 transition"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Filter</span>
          {(['All', 'Warm', 'Cold'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setRelationshipFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                relationshipFilter === f
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl shadow-sm shadow-slate-200/60 border border-slate-200 overflow-hidden">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Contact</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Company
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Outreach draft
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {leads.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-14 text-center text-sm text-slate-500">
                    <Inbox className="h-8 w-8 mx-auto mb-3 text-slate-300" />
                    Import a CSV to get started. It needs a{' '}
                    <code className="text-slate-700">name</code> and{' '}
                    <code className="text-slate-700">email</code> column;{' '}
                    <code className="text-slate-700">title</code>,{' '}
                    <code className="text-slate-700">company</code> and{' '}
                    <code className="text-slate-700">notes</code> are optional but make the drafts
                    much better.
                  </td>
                </tr>
              ) : visibleLeads.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-14 text-center text-sm text-slate-500">
                    <Inbox className="h-8 w-8 mx-auto mb-3 text-slate-300" />
                    No {relationshipFilter.toLowerCase()} contacts.
                  </td>
                </tr>
              ) : (
                visibleLeads.map((lead) => {
                  const busy = busyIds.has(lead.id);
                  const locked = lead.status !== 'Draft';
                  const relationship: Relationship = lead.relationship ?? 'Cold';

                  return (
                    <tr key={lead.id} className="hover:bg-slate-50/80 transition align-top">
                      <td className="px-6 py-4">
                        <div className="font-semibold">{lead.name}</div>
                        <div className="text-sm text-slate-500">{lead.email}</div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <button
                            onClick={() => overrideRelationship(lead)}
                            title={lead.match_note || 'No network match — click to mark Warm'}
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold transition ${relationshipBadge(relationship)}`}
                          >
                            {relationship}
                          </button>
                          <button
                            onClick={() => discard(lead)}
                            className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-red-600 transition"
                          >
                            <Trash2 className="h-3 w-3" />
                            Remove
                          </button>
                        </div>
                      </td>

                      <td className="px-6 py-4 text-sm text-slate-600">
                        <div>{lead.company || '—'}</div>
                        <div className="text-xs text-slate-400">{lead.title || ''}</div>
                      </td>

                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${badge(lead.status)}`}
                        >
                          {lead.status}
                        </span>
                        {lead.sent_at && (
                          <div className="text-xs text-slate-400 mt-1">
                            Sent {formatDate(lead.sent_at)}
                          </div>
                        )}
                        {lead.status === 'Sent' && (
                          <button
                            onClick={() => markReplied(lead)}
                            className="mt-1 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            Mark replied
                          </button>
                        )}
                        {lead.last_error && (
                          <div className="text-xs text-red-600 mt-1 max-w-48">
                            {lead.last_error}
                          </div>
                        )}
                      </td>

                      <td className="px-6 py-4 text-sm max-w-md">
                        {!lead.draft_content && !locked && (
                          <button
                            onClick={() => generate(lead)}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium px-3 py-1.5 rounded-lg text-xs transition disabled:opacity-50"
                          >
                            <Wand2 className="h-3.5 w-3.5" />
                            {busy ? 'Writing…' : 'Write draft'}
                          </button>
                        )}

                        {lead.draft_content && (
                          <div className="space-y-2">
                            <input
                              value={subjects[lead.id] ?? ''}
                              disabled={locked}
                              onChange={(e) =>
                                setSubjects((p) => ({ ...p, [lead.id]: e.target.value }))
                              }
                              onBlur={() => saveEdit(lead)}
                              placeholder="Subject line"
                              className="w-full text-xs font-medium border border-slate-300 rounded-lg px-2 py-1 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none transition disabled:bg-slate-50 disabled:text-slate-500"
                            />
                            <textarea
                              value={drafts[lead.id] ?? ''}
                              disabled={locked}
                              rows={4}
                              onChange={(e) =>
                                setDrafts((p) => ({ ...p, [lead.id]: e.target.value }))
                              }
                              onBlur={() => saveEdit(lead)}
                              className="w-full text-xs border border-slate-300 rounded-lg p-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:outline-none transition disabled:bg-slate-50 disabled:text-slate-500"
                            />
                            {!locked && (
                              <div className="flex gap-2 items-center">
                                <button
                                  onClick={() => send(lead)}
                                  disabled={busy || !connection?.connected}
                                  title={
                                    connection?.connected
                                      ? undefined
                                      : 'Connect Gmail first (top of page).'
                                  }
                                  className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-3 py-1.5 rounded-lg text-xs transition disabled:opacity-50"
                                >
                                  <Send className="h-3.5 w-3.5" />
                                  {busy ? 'Sending…' : 'Approve and send'}
                                </button>
                                <button
                                  onClick={() => generate(lead)}
                                  disabled={busy}
                                  className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-900 px-2 py-1 text-xs disabled:opacity-50 transition"
                                >
                                  <RefreshCw className="h-3 w-3" />
                                  Rewrite
                                </button>
                                {!connection?.connected && (
                                  <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                                    <AlertTriangle className="h-3 w-3" />
                                    No Gmail connected
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
