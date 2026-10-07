import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/server';
import { deleteConnection } from '@/lib/gmail';

export async function POST() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  try {
    await deleteConnection();
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not disconnect Gmail.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
