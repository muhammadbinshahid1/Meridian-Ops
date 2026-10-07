import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { generateDraft, renderTemplate, AIError } from '@/lib/ai';

// Generation plus retries can outrun the default limit on a cold start.
export const maxDuration = 60;

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

  // Read the contact from the database rather than trusting the request body,
  // so the caller can't inject arbitrary text into the prompt.
  const { data: lead, error: leadError } = await supabaseAdmin
    .from('leads')
    .select('id, name, email, title, company, notes, status, relationship, match_note')
    .eq('id', leadId)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: 'That contact no longer exists.' }, { status: 404 });
  }
  if (lead.status === 'Sent') {
    return NextResponse.json(
      { error: 'This email has already been sent and cannot be redrafted.' },
      { status: 409 }
    );
  }

  const { data: settings } = await supabaseAdmin
    .from('settings')
    .select('prompt_template')
    .eq('id', 1)
    .single();

  if (!settings?.prompt_template) {
    return NextResponse.json(
      { error: 'No prompt template is configured. Add one in Settings.' },
      { status: 500 }
    );
  }

  const prompt = renderTemplate(settings.prompt_template, {
    name: lead.name,
    title: lead.title,
    company: lead.company || 'their company',
    notes: lead.notes || 'No background notes supplied.',
    relationship: lead.relationship || 'Cold',
    match_note: lead.match_note || '',
  });

  try {
    const draft = await generateDraft(prompt);

    // The model is told not to invent a sign-off name/title (it doesn't know
    // one). We append the real signature here instead, so what the user
    // reviews already matches what goes out — the send route only adds the
    // postal address and unsubscribe link, which aren't meant to be edited
    // per email.
    const signature = process.env.SENDER_SIGNATURE?.trim();
    const body = signature ? `${draft.body.trim()}\n${signature}` : draft.body;

    const { error: updateError } = await supabaseAdmin
      .from('leads')
      .update({
        subject: draft.subject,
        draft_content: body,
        status: 'Draft',
        last_error: null,
      })
      .eq('id', leadId);

    if (updateError) {
      console.error('Supabase update failed after generation:', updateError);
      return NextResponse.json(
        { error: `Draft was written but could not be saved: ${updateError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, subject: draft.subject, body });
  } catch (error) {
    const message =
      error instanceof AIError ? error.message : 'The model could not be reached.';
    console.error('AI generation failed:', error);

    await supabaseAdmin.from('leads').update({ last_error: message }).eq('id', leadId);

    return NextResponse.json({ error: message }, { status: 502 });
  }
}