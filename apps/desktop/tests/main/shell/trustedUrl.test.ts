import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTrustedRendererUrl } from '../../../src/main/shell/trustedUrl.js';

const indexFile = process.platform === 'win32' ? 'C:\\Program Files\\agentpager\\resources\\app.asar\\out\\renderer\\index.html' : '/Applications/agentpager.app/Contents/Resources/app.asar/out/renderer/index.html';
const built = { devServerUrl: undefined, indexFile };

describe('isTrustedRendererUrl', () => {
  it('accepts the built index.html, with or without a hash', () => {
    const url = pathToFileURL(indexFile).href;
    expect(isTrustedRendererUrl(url, built)).toBe(true);
    expect(isTrustedRendererUrl(`${url}#/settings`, built)).toBe(true);
  });

  it('rejects other files, remote pages and non-URLs', () => {
    expect(isTrustedRendererUrl(pathToFileURL(indexFile.replace('index.html', 'other.html')).href, built)).toBe(false);
    expect(isTrustedRendererUrl('https://example.com/index.html', built)).toBe(false);
    expect(isTrustedRendererUrl('about:blank', built)).toBe(false);
    expect(isTrustedRendererUrl('', built)).toBe(false);
  });

  it('accepts only the dev server origin in development', () => {
    const dev = { devServerUrl: 'http://localhost:5173', indexFile };
    expect(isTrustedRendererUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isTrustedRendererUrl(pathToFileURL(indexFile).href, dev)).toBe(false);
  });
});
