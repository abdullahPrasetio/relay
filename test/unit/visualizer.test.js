import { describe, expect, it } from 'vitest';
import { runTests } from '../../src/lib/testRunner.js';
import {
  buildVisualizerDocument,
  escapeHtml,
  renderVisualizerTemplate,
} from '../../src/lib/visualizer.js';

describe('pm.visualizer rendering', () => {
  it('escapes double-brace values and leaves triple braces raw', () => {
    const html = renderVisualizerTemplate(
      '<b>{{user.name}}</b><i>{{{html}}}</i>',
      { user: { name: '<Ada>' }, html: '<em>ok</em>' }
    );
    expect(html).toBe('<b>&lt;Ada&gt;</b><i><em>ok</em></i>');
  });

  it('renders missing values as empty strings', () => {
    expect(renderVisualizerTemplate('a{{missing}}b', {})).toBe('ab');
  });

  it('falls back to formatted JSON when the template is empty', () => {
    const doc = buildVisualizerDocument({ template: '', data: { ok: true } });
    expect(doc).toContain('&quot;ok&quot;: true');
    expect(doc).toContain("default-src 'none'");
  });

  it('escapes text for the fallback pre block', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('passes the visualizer payload through runTests', async () => {
    const visualizer = { template: '<b>{{v}}</b>', data: { v: 1 } };
    const out = await runTests('pm.visualizer.set(...)', {}, {}, null, {
      runScript: async () => ({ ran: true, results: [], logs: [], visualizer }),
    });
    expect(out.visualizer).toEqual(visualizer);
  });
});
