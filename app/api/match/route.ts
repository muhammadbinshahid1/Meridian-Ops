import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Titles stripped during name normalisation, with or without a trailing period.
const TITLE_RE = /^(dr|mr|mrs|ms|prof)\.?\s+/i;

function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(TITLE_RE, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/**
 * Recomputes Warm/Cold for every lead against the current network_contacts
 * list. Exact matching only (v1 spec). Email match wins over name match, and
 * is recorded as more reliable — two different people can share a name, so
 * the note tells the user which basis to trust.
 *
 * Re-runnable and idempotent: a lead whose matching network contact was
 * deleted is actually demoted back to Cold, because every lead is
 * recomputed from scratch on every call rather than only upgraded.
 */
export async function POST() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const [{ data: leads, error: leadsError }, { data: contacts, error: contactsError }] =
    await Promise.all([
      supabaseAdmin.from('leads').select('id, name, email, relationship, match_note'),
      supabaseAdmin.from('network_contacts').select('name, email'),
    ]);

  if (leadsError || contactsError) {
    return NextResponse.json(
      { error: (leadsError ?? contactsError)?.message || 'Could not load matching data.' },
      { status: 500 }
    );
  }

  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();
  (contacts ?? []).forEach((c) => {
    if (c.email) byEmail.set(normalizeEmail(c.email), c.name);
    const normName = normalizeName(c.name);
    if (normName && !byName.has(normName)) byName.set(normName, c.name);
  });

  let warm = 0;
  let cold = 0;
  let updated = 0;
  const errors: string[] = [];

  await Promise.all(
    (leads ?? []).map(async (lead) => {
      let relationship: 'Warm' | 'Cold' = 'Cold';
      let matchNote: string | null = null;

      const emailMatch = lead.email ? byEmail.get(normalizeEmail(lead.email)) : undefined;
      if (emailMatch) {
        relationship = 'Warm';
        matchNote = `Email match: ${emailMatch}`;
      } else {
        const nameMatch = byName.get(normalizeName(lead.name));
        if (nameMatch) {
          relationship = 'Warm';
          matchNote = `Name match: ${nameMatch} (unverified)`;
        }
      }

      if (relationship === 'Warm') warm++;
      else cold++;

      if (lead.relationship !== relationship || lead.match_note !== matchNote) {
        const { error } = await supabaseAdmin
          .from('leads')
          .update({ relationship, match_note: matchNote })
          .eq('id', lead.id);
        if (error) errors.push(`${lead.id}: ${error.message}`);
        else updated++;
      }
    })
  );

  return NextResponse.json({ warm, cold, updated, errors: errors.length ? errors : undefined });
}
