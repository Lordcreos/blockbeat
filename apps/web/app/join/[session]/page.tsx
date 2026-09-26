import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JoinView } from '@/components/join/JoinView';
import { parseSessionId } from '@/lib/types';

interface Props {
  params: Promise<{ session: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { session } = await params;
  return { title: `Join · Session ${session} · Blockbeat` };
}

export default async function JoinPage({ params }: Props) {
  const { session } = await params;
  const sessionId = parseSessionId(session);
  if (sessionId === null) notFound();
  return <JoinView sessionId={sessionId} />;
}
