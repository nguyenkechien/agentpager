import { pathToFileURL } from 'node:url';

export interface RendererLocation {
  /** `ELECTRON_RENDERER_URL` in development (Vite dev server). */
  devServerUrl: string | undefined;
  /** The built `out/renderer/index.html`. */
  indexFile: string;
}

/** Only the app's own renderer may call the bridge: the dev server origin, or the built index.html. */
export function isTrustedRendererUrl(url: string, location: RendererLocation): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all (about:blank has none of our origins either).
    return false;
  }
  if (location.devServerUrl !== undefined) return parsed.origin === new URL(location.devServerUrl).origin;
  const index = pathToFileURL(location.indexFile);
  return parsed.protocol === 'file:' && decodeURIComponent(parsed.pathname).toLowerCase() === decodeURIComponent(index.pathname).toLowerCase();
}
