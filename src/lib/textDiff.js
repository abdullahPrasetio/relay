// Small line diff for comparing a response with a saved example. It is
// intentionally dependency-free and bounded so a huge body cannot freeze the
// renderer.

const MAX_LINES = 1200;
const MAX_CELLS = 1_500_000;

export function prettyForDiff(text) {
  try {
    return JSON.stringify(JSON.parse(String(text ?? '')), null, 2);
  } catch {
    return String(text ?? '');
  }
}

export function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (a.length * b.length > MAX_CELLS || a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ type: 'remove', text })),
      ...b.map((text) => ({ type: 'add', text })),
    ];
  }

  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'remove', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ type: 'remove', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    out.push({ type: 'add', text: b[j] });
    j += 1;
  }
  return out;
}
