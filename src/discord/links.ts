/**
 * Answer text is model output, and a prompt-injected model can write links:
 * `[official rules](https://evil…)` looks trustworthy under the bot's name.
 * Answers only need links into the game repository (and today cite plain
 * `path:line` text), so every other link is made unclickable:
 *
 * - a masked link `[text](url)` keeps only its text;
 * - any other URL is defanged, `https://evil.example` → `hxxps[:]//evil[.]example`,
 *   so it still shows but no client links it.
 *
 * Code is not exempt: matching Discord's code-span rules (escapes, backtick
 * runs) exactly is fragile, and a defanged URL is harmless anywhere. Because
 * nothing linkable is left, splitting the text into messages afterwards can't
 * create a link either.
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

// Masked links, then <angle> links, then any scheme://… URL.
const TOKENS =
  /\[([^\]\n]*)\]\(\s*<?([^()\s<>]*)>?\s*\)|<([a-z][a-z0-9+.-]*:\/\/[^\s<>]+)>|([a-z][a-z0-9+.-]*:\/\/[^\s<>`]+)/gi;

/** Linkifiers leave trailing punctuation out of a bare URL; so do we. */
function splitTrailing(url: string): [string, string] {
  const m = /[.,;:!?'")\]*_~`]+$/.exec(url);
  return m ? [url.slice(0, m.index), m[0]] : [url, ''];
}

/** Every `://` (a redirect can nest a second URL) and the host's dots. */
function defang(url: string): string {
  const i = url.indexOf('://');
  const rest = url.slice(i + 3);
  const host = /^[^/?#]*/.exec(rest)![0];
  const scheme = url.slice(0, i).replace(/^http/i, 'hxxp');
  return `${scheme}[:]//${host.replace(/\./g, '[.]')}${rest.slice(host.length).replaceAll('://', '[:]//')}`;
}

export function neutralizeLinks(text: string, allowed: LinkFilter): string {
  return text.replace(
    TOKENS,
    (match, label?: string, target?: string, angled?: string, bare?: string) => {
      if (label !== undefined) {
        if (target && allowed(target)) return match;
        // The label itself may be a URL: `[https://evil](https://evil)`.
        return neutralizeLinks(label, allowed);
      }
      if (angled !== undefined) return allowed(angled) ? match : defang(angled);
      const [url, trailing] = splitTrailing(bare!);
      return (allowed(url) ? url : defang(url)) + trailing;
    },
  );
}
