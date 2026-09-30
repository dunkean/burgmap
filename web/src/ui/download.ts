/**
 * File saving that works in a normal browser, from file://, and inside the claude.ai Artifact viewer
 * (where plain `<a download>` / blob links do nothing and the host offers a "downloads" capability).
 */

interface DownloadsCapability { save(o: { filename: string; data: Blob | string }): Promise<unknown> }
interface ClaudeHost { use?: (name: string) => Promise<unknown> | unknown }

export type SaveOutcome = 'saved' | 'declined' | 'fallback';

export interface SaveEnv {
  /** `window.claude`-like host object (injectable for tests). */
  claude?: ClaudeHost | null;
  /** Anchor-based download (injectable for tests). */
  anchor?: (blob: Blob, filename: string) => void;
}

function anchorDownload(blob: Blob, name: string): void {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Save `data` as `filename`. Order: the host's downloads capability when present (declined -> silently do
 * nothing; unavailable / not granted / any other failure -> fall back), then a classic `<a download>`.
 */
export async function saveFile(filename: string, data: Blob | string, mime: string, env: SaveEnv = {}): Promise<SaveOutcome> {
  const host: ClaudeHost | null | undefined = 'claude' in env ? env.claude : (globalThis as unknown as { claude?: ClaudeHost }).claude;
  let dl: DownloadsCapability | null = null;
  try {
    const got = await host?.use?.('downloads');
    dl = (got as DownloadsCapability | null | undefined) ?? null;
  } catch { dl = null; }
  if (dl && typeof dl.save === 'function') {
    try {
      await dl.save({ filename, data });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === 'declined') return 'declined';
      // 'unavailable', 'not_granted' or anything unexpected: use the plain path below
    }
  }
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  (env.anchor ?? anchorDownload)(blob, filename);
  return 'fallback';
}
