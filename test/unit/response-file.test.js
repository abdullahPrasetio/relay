import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeResponsePayload, writeResponseFile } from '../../electron/response-file.js';

const fixturePath = path.join(import.meta.dirname, '..', 'fixtures', 'binary', 'pixel.png');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'relay-response-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('response file writing', () => {
  it('writes binary payloads byte-for-byte', () => {
    const original = readFileSync(fixturePath);
    const out = path.join(dir, 'saved.png');

    writeResponseFile(out, { base64: original.toString('base64') });

    const written = readFileSync(out);
    expect(written.equals(original)).toBe(true);
    expect(sha256(written)).toBe(sha256(original));
  });

  it('writes text payloads as UTF-8', () => {
    const out = path.join(dir, 'saved.txt');
    const text = 'héllo — relay\n';

    writeResponseFile(out, { text });

    expect(readFileSync(out, 'utf8')).toBe(text);
  });

  it('decodes base64 before text and treats empty input as empty bytes', () => {
    expect(decodeResponsePayload({ base64: 'aGk=', text: 'ignored' }).toString()).toBe('hi');
    expect(decodeResponsePayload({ text: '' }).length).toBe(0);
    expect(decodeResponsePayload({}).length).toBe(0);
  });
});
