import { describe, expect, it } from 'vitest';
import { buildCommands, commandsFor, mayUse } from '../../src/discord/commands.js';

describe('buildCommands', () => {
  it('builds only the enabled commands', () => {
    const names = (enabled: Parameters<typeof buildCommands>[1]) =>
      buildCommands(['standard'], enabled).map((c) => c.name);
    const all = ['ask', 'collective-info', 'report-bug', 'wish', 'anomalies', 'latest-release'];
    expect(names(all as Parameters<typeof buildCommands>[1])).toEqual(all);
    expect(names(['report-bug'])).toEqual(['report-bug']);
  });

  it('hides admin-only commands from members without Administrator', () => {
    const commands = buildCommands(['standard'], ['ask'], ['wish']);
    expect(commands.map((c) => [c.name, c.default_member_permissions, c.contexts])).toEqual([
      ['ask', undefined, undefined],
      ['wish', '0', [0]],
    ]);
  });
});

describe('mayUse', () => {
  const admin = '123456789012345678';
  const discord: Parameters<typeof mayUse>[0] = {
    commands: ['collective-info'],
    adminCommands: ['ask', 'wish'],
    adminUserId: admin,
  };

  it('gives admin-only commands to the admin alone', () => {
    expect(mayUse(discord, admin, 'ask')).toBe(true);
    expect(mayUse(discord, admin, 'collective-info')).toBe(true);
    expect(mayUse(discord, '987654321098765432', 'ask')).toBe(false);
    expect(mayUse(discord, '987654321098765432', 'collective-info')).toBe(true);
    expect(mayUse(discord, admin, 'anomalies')).toBe(false);
    expect(commandsFor(discord, admin)).toEqual({
      released: ['collective-info'],
      adminOnly: ['ask', 'wish'],
    });
  });

  it('gives nobody admin-only commands without an admin', () => {
    expect(mayUse({ ...discord, adminUserId: undefined }, admin, 'ask')).toBe(false);
  });
});
