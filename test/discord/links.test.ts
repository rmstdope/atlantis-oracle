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
    expect(n('[https://evil.example](https://evil.example)')).toBe('hxxps[:]//evil[.]example');
  });

  it('defangs bare and angle-bracket URLs, keeping trailing punctuation', () => {
    expect(n('Go to https://evil.example/x, now.')).toBe('Go to hxxps[:]//evil[.]example/x, now.');
    expect(n('(see https://evil.example)')).toBe('(see hxxps[:]//evil[.]example)');
    expect(n('**https://evil.example**')).toBe('**hxxps[:]//evil[.]example**');
    expect(n('<https://evil.example/a>')).toBe('hxxps[:]//evil[.]example/a');
    expect(n('steam://run/1 and discord://x')).toBe('steam[:]//run/1 and discord[:]//x');
  });

  it('defangs a URL nested in another one', () => {
    expect(n('https://a.example/r?to=https://evil.example')).toBe(
      'hxxps[:]//a[.]example/r?to=https[:]//evil.example',
    );
  });

  it('defangs a URL hidden in the host part', () => {
    expect(n('https://x@https://evil.example/a')).not.toMatch(/https?:\/\//);
    expect(n('https://a.example:https://evil.example')).not.toMatch(/https?:\/\//);
  });

  it('treats malformed scheme targets as masked links', () => {
    expect(n('[official rules](https:/evil.example)')).toBe('official rules');
    expect(n('[official rules](https:\\\\evil.example)')).toBe('official rules');
  });

  it('leaves code that only looks like a masked link alone', () => {
    const code = '`ItemDefs[i](y)` and `auto f = [](int) { return 1; };`';
    expect(n(code)).toBe(code);
  });

  it('keeps links into the game repository', () => {
    expect(n(`Source: ${REPO_LINK}`)).toBe(`Source: ${REPO_LINK}`);
    expect(n(`[gamedata.cpp](${REPO_LINK})`)).toBe(`[gamedata.cpp](${REPO_LINK})`);
    expect(n(`<${REPO_LINK}>`)).toBe(`<${REPO_LINK}>`);
  });

  it('gives code no exemption, so backtick tricks keep no link alive', () => {
    // Escaped backticks and uneven backtick runs are not code to Discord.
    expect(n('\\`[official rules](https://evil.example)\\`')).toBe('\\`official rules\\`');
    expect(n('`[x](https://evil.example)``')).toBe('`x``');
    expect(n('`see https://evil.example/x for details`')).toBe(
      '`see hxxps[:]//evil[.]example/x for details`',
    );
  });

  it('leaves no live URL for a later split to expose', () => {
    const out = n(`${'word '.repeat(380)}\`see https://evil.example/x\``);
    expect(out).not.toMatch(/https?:\/\//);
  });

  it('leaves ordinary answers unchanged', () => {
    const text =
      'Tactics gives +1 per level.\n\nSources: rules § Skills > Tactics, gamedata.cpp:123';
    expect(n(text)).toBe(text);
  });
});
