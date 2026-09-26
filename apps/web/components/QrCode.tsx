'use client';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  value: string;
  /** Rendered size in CSS pixels. Drawn at 2× for crisp scanning. */
  size: number;
  label: string;
  className?: string;
}

/** Canvas QR code; renders nothing until `value` is non-empty. */
export function QrCode({ value, size, label, className }: QrCodeProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !value) return;
    let cancelled = false;
    QRCode.toCanvas(canvas, value, {
      width: size * 2,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#050507', light: '#ffffff' },
    })
      .then(() => {
        if (cancelled) return;
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;
      })
      .catch((err: unknown) => {
        console.error('QR render failed', err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    // A blank white square helps nobody: show the address so people can type it.
    return (
      <p role="img" aria-label={label} className="num break-all p-3 text-center" style={{ width: size, maxWidth: '100%', color: '#050507', background: '#fff', borderRadius: 12, fontSize: 'var(--text-md)' }}>
        {value}
      </p>
    );
  }

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      className={className}
      style={{ width: size, height: size, maxWidth: '100%', borderRadius: 12, background: '#fff' }}
    />
  );
}
