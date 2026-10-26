import fs from 'node:fs';

// Decoding + writing of response bodies for the "Save" action. Kept separate
// from main.js so the byte-level behavior is unit-testable without Electron.

export function decodeResponsePayload({ base64, text }) {
  return base64 != null ? Buffer.from(base64, 'base64') : Buffer.from(text ?? '', 'utf8');
}

export function writeResponseFile(filePath, payload) {
  fs.writeFileSync(filePath, decodeResponsePayload(payload));
  return filePath;
}
