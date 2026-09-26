/**
 * Decodes the fully onchain `tokenURI` of a Blockbeat track: a base64 JSON data URI whose
 * `image` is a base64 SVG data URI. Pure and server-safe (Buffer, no DOM).
 */
export interface TrackAttribute {
  traitType: string;
  value: string | number;
}

export interface TrackMetadata {
  name: string;
  description: string;
  /** The decoded SVG document. */
  imageSvg: string;
  /** The original `data:image/svg+xml;base64,…` URI, safe to use as an <img> src. */
  imageDataUri: string;
  attributes: TrackAttribute[];
}

export class TrackDecodeError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'TrackDecodeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const JSON_PREFIX = 'data:application/json;base64,';
const SVG_PREFIX = 'data:image/svg+xml;base64,';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(b64: string, what: string): string {
  if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new TrackDecodeError(`${what} is not valid base64`);
  }
  return Buffer.from(b64, 'base64').toString('utf8');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new TrackDecodeError(`token metadata is missing a string "${key}"`);
  return v;
}

function decodeAttribute(raw: unknown, index: number): TrackAttribute {
  if (!isRecord(raw) || typeof raw.trait_type !== 'string') {
    throw new TrackDecodeError(`attribute ${index} has no trait_type`);
  }
  const { value } = raw;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TrackDecodeError(`attribute ${index} ("${raw.trait_type}") has a non-scalar value`);
  }
  return { traitType: raw.trait_type, value };
}

export function decodeTokenUri(uri: string): TrackMetadata {
  if (!uri.startsWith(JSON_PREFIX)) {
    throw new TrackDecodeError(`tokenURI must start with ${JSON_PREFIX}`);
  }
  const text = decodeBase64(uri.slice(JSON_PREFIX.length), 'tokenURI payload');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TrackDecodeError('tokenURI payload is not valid JSON', { cause: error });
  }
  if (!isRecord(parsed)) throw new TrackDecodeError('tokenURI JSON is not an object');

  const name = requireString(parsed, 'name');
  const description = typeof parsed.description === 'string' ? parsed.description : '';
  const image = requireString(parsed, 'image');
  if (!image.startsWith(SVG_PREFIX)) throw new TrackDecodeError(`image must start with ${SVG_PREFIX}`);
  const imageSvg = decodeBase64(image.slice(SVG_PREFIX.length), 'image payload');

  const rawAttributes = parsed.attributes;
  if (!Array.isArray(rawAttributes)) throw new TrackDecodeError('token metadata is missing an "attributes" array');
  const attributes = rawAttributes.map(decodeAttribute);

  return { name, description, imageSvg, imageDataUri: image, attributes };
}
