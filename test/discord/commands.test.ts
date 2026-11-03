import { describe, expect, it } from 'vitest';
import { buildCommands } from '../../src/discord/commands.js';

describe('buildCommands', () => {
  it('builds only the enabled commands', () => {
    const names = (enabled: Parameters<typeof buildCommands>[1]) =>
      buildCommands(['standard'], enabled).map((c) => c.name);
    const all = ['ask', 'collective-info', 'report-bug', 'wish', 'anomalies', 'latest-release'];
    expect(names(all as Parameters<typeof buildCommands>[1])).toEqual(all);
    expect(names(['report-bug'])).toEqual(['report-bug']);
  });
});
