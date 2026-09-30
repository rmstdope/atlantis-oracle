import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RulesConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { GameRepo } from '../repo/sync.js';
import { makeRulesBuilder, type RulesBuilder } from './build.js';
import { extractHeadings, rulesHtmlToMarkdown, type Heading } from './markdown.js';

export type RulesSource = 'built' | 'snapshot';

export interface RulesDoc {
  variant: string;
  commit: string;
  source: RulesSource;
  lines: string[];
  headings: Heading[];
}

interface Meta {
  commit: string;
  source: RulesSource;
}

/** Player rules per variant, as Markdown, rebuilt when the game repo's commit changes. */
export class RulesStore {
  private readonly docs = new Map<string, RulesDoc>();
  private preparing: Promise<void> | undefined;

  constructor(
    private readonly cfg: RulesConfig,
    private readonly logger: Logger,
    private readonly builder: RulesBuilder = makeRulesBuilder,
  ) {}

  get(variant: string): RulesDoc | undefined {
    return this.docs.get(variant);
  }

  /** Variants with rules available. */
  get variants(): string[] {
    return [...this.docs.keys()].sort();
  }

  /** Makes rules for every variant available at the repo's current commit. */
  prepare(repo: Pick<GameRepo, 'dir' | 'commit' | 'variants'>): Promise<void> {
    this.preparing ??= this.doPrepare(repo).finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  private mdPath(variant: string) {
    return path.join(path.resolve(this.cfg.dir), `${variant}.md`);
  }

  private async load(variant: string): Promise<boolean> {
    try {
      const meta = JSON.parse(await readFile(`${this.mdPath(variant)}.json`, 'utf8')) as Meta;
      const lines = (await readFile(this.mdPath(variant), 'utf8')).split('\n');
      this.docs.set(variant, { variant, ...meta, lines, headings: extractHeadings(lines) });
      return true;
    } catch {
      return false;
    }
  }

  private async save(variant: string, html: string, meta: Meta): Promise<void> {
    const md = rulesHtmlToMarkdown(html);
    const file = this.mdPath(variant);
    // Write-then-rename so a concurrent reader never sees a partial file.
    await writeFile(`${file}.tmp`, md);
    await rename(`${file}.tmp`, file);
    await writeFile(`${file}.json`, JSON.stringify(meta));
    const lines = md.split('\n');
    this.docs.set(variant, { variant, ...meta, lines, headings: extractHeadings(lines) });
  }

  private async doPrepare(repo: Pick<GameRepo, 'dir' | 'commit' | 'variants'>): Promise<void> {
    await mkdir(path.resolve(this.cfg.dir), { recursive: true });
    for (const v of repo.variants) await this.load(v);
    const stale = repo.variants.filter((v) => this.docs.get(v)?.commit !== repo.commit);
    if (stale.length === 0) return;

    let built = new Map<string, string>();
    if (this.cfg.build) {
      this.logger.info({ variants: stale }, 'Building rules');
      try {
        built = await this.builder({
          repoDir: repo.dir,
          variants: stale,
          workDir: path.join(path.resolve(this.cfg.dir), 'build'),
          logger: this.logger,
        });
      } catch (err) {
        this.logger.warn({ err: err instanceof Error ? err.message : err }, 'Rules build failed');
      }
    }

    for (const variant of stale) {
      const builtHtml = built.get(variant);
      const snapshot = path.join(repo.dir, 'snapshot-tests', 'rules', `${variant}.html`);
      for (const [file, source] of [
        [builtHtml, 'built'],
        [snapshot, 'snapshot'],
      ] as const) {
        if (!file) continue;
        try {
          await this.save(variant, await readFile(file, 'utf8'), { commit: repo.commit, source });
          break;
        } catch {
          // Try the next source.
        }
      }
      const doc = this.docs.get(variant);
      if (doc?.commit !== repo.commit) {
        this.logger.warn(
          { variant, using: doc ? `outdated rules from ${doc.commit.slice(0, 10)}` : 'none' },
          'No current rules for variant',
        );
      }
    }
    this.logger.info(
      { rules: this.variants.map((v) => `${v}:${this.docs.get(v)!.source}`) },
      'Rules ready',
    );
  }
}
