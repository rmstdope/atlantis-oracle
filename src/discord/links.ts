/**
 * Answer text is model output, and a prompt-injected model can write links:
 * `[official rules](https://evil…)` looks trustworthy under the bot's name.
 * Answers only need links into the game repository (and today cite plain
 * `path:line` text), so every other link is made unclickable:
 *
 * - a masked link `[text](url)` keeps only its text;
 * - a bare or `<url>` link is wrapped in inline code, so it shows but can't be clicked.
 *
 * Code blocks and inline code are left alone: Discord doesn't link inside them.
 */

export type LinkFilter = (url: string) => boolean;

/** Keeps links into one GitHub repository, e.g. https://github.com/Atlantis-PBEM/Atlantis. */
export function githubRepoLinks(repoUrl: string): LinkFilter {
  let base: string | undefined;
  try {
    const u = new URL(repoUrl);
    const [owner, name] = u.pathname
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
    if (u.hostname === 'github.com' && owner && name) base = `/${owner}/${name}`.toLowerCase();
  } catch {
    // Not a URL (e.g. a local path): no link is allowed.
  }
  return (url) => {
    if (!base) return false;
    try {
      const u = new URL(url);
      const p = u.pathname.toLowerCase();
      return (
        u.protocol === 'https:' &&
        u.hostname === 'github.com' &&
        u.username === '' &&
        u.password === '' &&
        u.port === '' &&
        (p === base || p.startsWith(`${base}/`))
      );
    } catch {
      return false;
    }
  };
}

// Code first, so links inside it are skipped; then masked, <angle> and bare links.
const TOKENS =
  /(```[\s\S]*?```|`[^`\n]*`)|\[([^\]\n]*)\]\(\s*<?([^()\s<>]*)>?\s*\)|<([a-z][a-z0-9+.-]*:\/\/[^\s<>]+)>|((?:https?|ftp|steam|discord):\/\/[^\s<>`]+)/gi;

/** Linkifiers leave trailing punctuation out of a bare URL; so do we. */
function splitTrailing(url: string): [string, string] {
  const m = /[.,;:!?'")\]*_~]+$/.exec(url);
  return m ? [url.slice(0, m.index), m[0]] : [url, ''];
}

const inert = (url: string) => `\`${url}\``;

export function neutralizeLinks(text: string, allowed: LinkFilter): string {
  return text.replace(
    TOKENS,
    (match, code?: string, label?: string, target?: string, angled?: string, bare?: string) => {
      if (code !== undefined) return match;
      if (label !== undefined) {
        if (target && allowed(target)) return match;
        // The label itself may be a URL: `[https://evil](https://evil)`.
        return neutralizeLinks(label, allowed);
      }
      if (angled !== undefined) return allowed(angled) ? match : inert(angled);
      const [url, trailing] = splitTrailing(bare!);
      return (allowed(url) ? url : inert(url)) + trailing;
    },
  );
}
