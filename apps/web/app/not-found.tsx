import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-6 px-5 py-16">
      <h1 style={{ fontSize: 'var(--text-title)', fontWeight: 650, letterSpacing: '-0.025em', lineHeight: 1 }}>No such session</h1>
      <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-muted)' }}>
        Session links look like /join/12. Scan the code on the stage, or start from the demo.
      </p>
      <Link href="/" className="self-start rounded-full px-6 py-3 font-semibold" style={{ background: 'var(--ink)', color: 'var(--ink-on-track)' }}>
        Back to Blockbeat
      </Link>
    </main>
  );
}
