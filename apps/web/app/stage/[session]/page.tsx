import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hostBarRequested } from '@/components/stage/host-bar';
import { StageView } from '@/components/stage/StageView';
import { parseSessionId } from '@/lib/types';

interface Props {
  params: Promise<{ session: string }>;
  searchParams: Promise<{ host?: string | string[] }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { session } = await params;
  return { title: `Stage · Session ${session} · Blockbeat` };
}

export default async function StagePage({ params, searchParams }: Props) {
  const { session } = await params;
  // W15: ?host=1 shows the host bar to the presenter; the projector's audience view stays clean.
  const { host } = await searchParams;
  const sessionId = parseSessionId(session);
  if (sessionId === null) notFound();
  return <StageView sessionId={sessionId} hostRequested={hostBarRequested(host)} />;
}
