import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TipView } from '@/components/tip/TipView';
import { parseSessionId } from '@/lib/types';

interface Props {
  params: Promise<{ session: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { session } = await params;
  return { title: `Tip · Session ${session} · Blockbeat` };
}

/** W21b: the stage's second code. Tips for the session, from their own burner (components/tip/TipView.tsx). */
export default async function TipPage({ params }: Props) {
  const { session } = await params;
  const sessionId = parseSessionId(session);
  if (sessionId === null) notFound();
  return <TipView sessionId={sessionId} />;
}
