import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/server';
import { getConnection } from '@/lib/gmail';

export async function GET() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  try {
    const connection = await getConnection();
    return NextResponse.json({
      connected: !!connection,
      email: connection?.email ?? null,
      connectedAt: connection?.created_at ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load the Gmail connection.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
