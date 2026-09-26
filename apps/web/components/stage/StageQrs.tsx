'use client';
import { QrCode } from '@/components/QrCode';
import { shortUrl } from '@/components/format';

interface StageQrsProps {
  sessionId: bigint;
  joinUrl: string;
  tipUrl: string;
  /** The host's choice (host bar); hidden by default. */
  joinVisible: boolean;
  /** QR edge in CSS px; two sit side by side in the 500 px rail. */
  size: number;
}

/**
 * W21b: the rail's two codes. Play (the join page) is hidden until the host shows it: a
 * blurred decoy code (never the join URL, so no frame of the projector can be scanned) and no
 * URL. Tip (the tip page) is always there. Same white tiles, same label size, so neither reads
 * as secondary; the blur says which one is off.
 */
export function StageQrs({ sessionId, joinUrl, tipUrl, joinVisible, size }: StageQrsProps) {
  const id = sessionId.toString();
  const urlSize = (url: string): string => (url && shortUrl(url).length > 22 ? 'var(--text-xs)' : 'var(--text-sm)');
  const tile = { background: '#fff', boxShadow: '0 0 0 5px rgba(255,255,255,0.06), 0 24px 48px -20px rgba(0,0,0,0.9)' } as const;
  const urlStyle = { fontWeight: 600, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere', lineHeight: 1.25 } as const;
  return (
    <div data-testid="stage-qrs" className="grid grid-cols-2 gap-3">
      <figure data-testid="qr-join" data-visible={joinVisible ? 'true' : 'false'} className="flex min-w-0 flex-col items-center gap-2">
        <h2 data-testid="scan-cta" style={{ fontSize: 'var(--text-lg)', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 }}>
          Scan to play
        </h2>
        <div className="relative overflow-hidden rounded-[18px] p-2.5" style={tile}>
          {joinVisible ? (
            <QrCode value={joinUrl} size={size} label={`QR code to join session ${id}`} />
          ) : (
            <>
              <div aria-hidden="true" style={{ filter: 'blur(9px)', opacity: 0.55 }}>
                <QrCode value="blockbeat" size={size} label="" />
              </div>
              <p
                data-testid="join-hidden"
                className="absolute inset-0 flex items-center justify-center px-4 text-center font-semibold"
                style={{ color: '#050507', fontSize: 'var(--text-md)', lineHeight: 1.2 }}
              >
                Hidden by the host
              </p>
            </>
          )}
        </div>
        <p data-testid="short-url" className="num max-w-full text-center" style={{ ...urlStyle, fontSize: urlSize(joinUrl), color: joinVisible ? 'var(--ink)' : 'var(--ink-muted)' }}>
          {joinVisible ? (joinUrl ? shortUrl(joinUrl) : `/join/${id}`) : 'Join code hidden'}
        </p>
      </figure>
      <figure data-testid="qr-tip" className="flex min-w-0 flex-col items-center gap-2">
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, color: 'var(--track-hat)' }}>Scan to tip</h2>
        <div className="rounded-[18px] p-2.5" style={tile}>
          <QrCode value={tipUrl} size={size} label={`QR code to tip session ${id}`} />
        </div>
        <p data-testid="tip-url" className="num max-w-full text-center" style={{ ...urlStyle, fontSize: urlSize(tipUrl) }}>
          {tipUrl ? shortUrl(tipUrl) : `/tip/${id}`}
        </p>
      </figure>
    </div>
  );
}
