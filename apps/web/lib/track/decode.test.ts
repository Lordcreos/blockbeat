import { describe, expect, it } from 'vitest';
import { TrackDecodeError, decodeTokenUri } from './decode';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 336 176"><rect width="336" height="176" fill="#0b0b12"/></svg>';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function tokenUri(overrides: Record<string, unknown> = {}): string {
  const json = {
    name: 'Blockbeat Track #1',
    description: 'A 16-step loop composed live by the room on Monad.',
    image: `data:image/svg+xml;base64,${b64(SVG)}`,
    attributes: [
      { trait_type: 'hits', value: 12 },
      { trait_type: 'contributors', value: 3 },
      { trait_type: 'parent', value: 0 },
      { trait_type: 'session', value: 1 },
    ],
    ...overrides,
  };
  return `data:application/json;base64,${b64(JSON.stringify(json))}`;
}

describe('decodeTokenUri', () => {
  it('decodes the contract-shaped base64 JSON and the inline SVG', () => {
    const meta = decodeTokenUri(tokenUri());
    expect(meta.name).toBe('Blockbeat Track #1');
    expect(meta.description).toMatch(/16-step loop/);
    expect(meta.imageSvg).toBe(SVG);
    expect(meta.imageDataUri).toBe(`data:image/svg+xml;base64,${b64(SVG)}`);
    expect(meta.attributes).toEqual([
      { traitType: 'hits', value: 12 },
      { traitType: 'contributors', value: 3 },
      { traitType: 'parent', value: 0 },
      { traitType: 'session', value: 1 },
    ]);
  });

  it('accepts string attribute values', () => {
    const meta = decodeTokenUri(tokenUri({ attributes: [{ trait_type: 'mood', value: 'acid' }] }));
    expect(meta.attributes).toEqual([{ traitType: 'mood', value: 'acid' }]);
  });

  it('rejects a non-data URI', () => {
    expect(() => decodeTokenUri('https://example.com/1.json')).toThrow(TrackDecodeError);
    expect(() => decodeTokenUri('ipfs://abc')).toThrow(/data:application\/json;base64/);
  });

  it('rejects malformed base64', () => {
    expect(() => decodeTokenUri('data:application/json;base64,!!!not-base64!!!')).toThrow(TrackDecodeError);
  });

  it('rejects invalid JSON', () => {
    expect(() => decodeTokenUri(`data:application/json;base64,${b64('{not json')}`)).toThrow(/JSON/);
  });

  it('rejects JSON missing name, image or attributes', () => {
    expect(() => decodeTokenUri(tokenUri({ name: undefined }))).toThrow(/name/);
    expect(() => decodeTokenUri(tokenUri({ image: undefined }))).toThrow(/image/);
    expect(() => decodeTokenUri(tokenUri({ attributes: 'nope' }))).toThrow(/attributes/);
  });

  it('rejects an image that is not an inline SVG data URI', () => {
    expect(() => decodeTokenUri(tokenUri({ image: 'https://cdn.example/1.png' }))).toThrow(/image/);
  });

  it('rejects an attribute without trait_type or with a non-scalar value', () => {
    expect(() => decodeTokenUri(tokenUri({ attributes: [{ value: 1 }] }))).toThrow(/attribute/);
    expect(() => decodeTokenUri(tokenUri({ attributes: [{ trait_type: 'x', value: { a: 1 } }] }))).toThrow(/attribute/);
  });
});
