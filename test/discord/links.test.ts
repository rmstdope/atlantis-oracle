import { describe, expect, it } from 'vitest';
import { githubRepoLinks, neutralizeLinks } from '../../src/discord/links.js';

const repo = githubRepoLinks('https://github.com/Atlantis-PBEM/Atlantis.git');
const n = (text: string) => neutralizeLinks(text, repo);
const REPO_LINK = 'https://github.com/Atlantis-PBEM/Atlantis/blob/abc/gamedata.cpp#L10';

describe('githubRepoLinks', () => {
  it('allows only https links into the game repository', () => {
    expect(repo(REPO_LINK)).toBe(true);
    expect(repo('https://github.com/atlantis-pbem/atlantis')).toBe(true);
    expect(repo('http://github.com/Atlantis-PBEM/Atlantis')).toBe(false);
    expect(repo('https://github.com/Atlantis-PBEM/Atlantis-evil/x')).toBe(false);
    expect(repo('https://github.com/Atlantis-PBEM/Atlantis.evil.com')).toBe(false);
    expect(repo('https://github.com.evil.com/Atlantis-PBEM/Atlantis')).toBe(false);
    expect(repo('https://user@github.com/Atlantis-PBEM/Atlantis')).toBe(false);
    expect(repo('https://evil.com/github.com/Atlantis-PBEM/Atlantis')).toBe(false);
  });

  it('allows nothing for a repository that is not on GitHub', () => {
    expect(githubRepoLinks('/srv/game')('https://github.com/a/b')).toBe(false);
    expect(githubRepoLinks('https://gitlab.com/a/b.git')('https://gitlab.com/a/b')).toBe(false);
  });
});

describe('neutralizeLinks', () => {
  it('keeps the text of masked links to other sites', () => {
    expect(n('See [the official rules](https://evil.example/rules).')).toBe(
      'See the official rules.',
    );
    expect(n('[rules](<https://evil.example>)')).toBe('rules');
  });

  it('does not let a masked link hide behind a URL-shaped label', () => {
    expect(n('[https://evil.example](https://evil.example)')).toBe('`https://evil.example`');
  });

  it('makes bare and angle-bracket URLs unclickable, keeping trailing punctuation', () => {
    expect(n('Go to https://evil.example/x, now.')).toBe('Go to `https://evil.example/x`, now.');
    expect(n('(see https://evil.example)')).toBe('(see `https://evil.example`)');
    expect(n('**https://evil.example**')).toBe('**`https://evil.example`**');
    expect(n('<https://evil.example/a>')).toBe('`https://evil.example/a`');
    expect(n('steam://run/1 and discord://x')).toBe('`steam://run/1` and `discord://x`');
  });

  it('keeps links into the game repository', () => {
    expect(n(`Source: ${REPO_LINK}`)).toBe(`Source: ${REPO_LINK}`);
    expect(n(`[gamedata.cpp](${REPO_LINK})`)).toBe(`[gamedata.cpp](${REPO_LINK})`);
    expect(n(`<${REPO_LINK}>`)).toBe(`<${REPO_LINK}>`);
  });

  it('leaves code alone', () => {
    const text = 'Use `https://evil.example` or\n```\ncurl https://evil.example\n```';
    expect(n(text)).toBe(text);
  });

  it('leaves ordinary answers unchanged', () => {
    const text =
      'Tactics gives +1 per level.\n\nSources: rules § Skills > Tactics, gamedata.cpp:123';
    expect(n(text)).toBe(text);
  });
});
