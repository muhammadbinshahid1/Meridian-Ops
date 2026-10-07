import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getConnection, getValidAccessToken, sendViaGmail, GmailError } from '@/lib/gmail';

export const maxDuration = 30;

/**
 * CAN-SPAM requires a working opt-out and a physical postal address on
 * commercial email. Do not remove this without a decision from the client.
 *
 * The sign-off signature (name/title) is NOT added here — it's baked into
 * draft_content at generation time (see app/api/generate/route.ts) so it's
 * part of what the user reviews and can edit. Adding it again here would
 * duplicate it under the reviewed sign-off.
 */
function withFooter(body: string, email: string) {
  const address = process.env.SENDER_POSTAL_ADDRESS || '';
  const unsubscribe = process.env.UNSUBSCRIBE_URL
    ? `${process.env.UNSUBSCRIBE_URL}?email=${encodeURIComponent(email)}`
    : '';

  return [
    body.trim(),
    address && `\n${address}`,
    unsubscribe && `\nTo stop receiving these emails: ${unsubscribe}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let leadId: string;
  try {
    ({ leadId } = await req.json());
    if (!leadId || typeof leadId !== 'string') throw new Error();
  } catch {
    return NextResponse.json({ error: 'A leadId is required.' }, { status: 400 });
  }

  // Recipient and content come from the database, never from the request.
  // This closes the open-relay hole and guarantees the text that was reviewed
  // is the text that goes out.
  const { data: lead, error: leadError } = await supabaseAdmin
    .from('leads')
    .select('id, name, email, subject, draft_content, status')
    .eq('id', leadId)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: 'That contact no longer exists.' }, { status: 404 });
  }
  if (lead.status === 'Sent') {
    return NextResponse.json({ error: 'This email was already sent.' }, { status: 409 });
  }
  if (!lead.draft_content?.trim()) {
    return NextResponse.json(
      { error: 'There is no draft to send. Generate one first.' },
      { status: 400 }
    );
  }

  const connection = await getConnection();
  if (!connection) {
    return NextResponse.json(
      { error: 'No Gmail account connected. Connect one in Connections first.' },
      { status: 400 }
    );
  }

  let result: { id?: string };
  try {
    const accessToken = await getValidAccessToken(connection);
    result = await sendViaGmail(accessToken, {
      from: connection.email,
      to: lead.email,
      subject: lead.subject?.trim() || 'Partnership inquiry',
      text: withFooter(lead.draft_content, lead.email),
    });
  } catch (err) {
    const message =
      err instanceof GmailError
        ? err.message
        : 'Could not reach Gmail — the connection may need to be reconnected.';
    console.error('Gmail send failed:', err);

    await supabaseAdmin.from('leads').update({ last_error: message }).eq('id', leadId);

    return NextResponse.json({ error: `The email was not sent: ${message}` }, { status: 502 });
  }

  const { error: updateError } = await supabaseAdmin
    .from('leads')
    .update({ status: 'Sent', sent_at: new Date().toISOString(), last_error: null })
    .eq('id', leadId);

  if (updateError) {
    // The email really did go out, so say so plainly rather than reporting a
    // failure that would tempt someone into sending it twice.
    console.error('Sent, but status update failed:', updateError);
    return NextResponse.json(
      {
        success: true,
        warning: `Email sent${result.id ? ` (id ${result.id})` : ''} but the status did not save: ${updateError.message}`,
      },
      { status: 200 }
    );
  }

  return NextResponse.json({ success: true, id: result.id });
}
