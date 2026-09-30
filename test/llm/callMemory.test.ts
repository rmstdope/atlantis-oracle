import { describe, expect, it } from 'vitest';
import { CallMemory } from '../../src/llm/callMemory.js';

describe('CallMemory', () => {
  it('matches repeats regardless of key order, case and whitespace', () => {
    const m = new CallMemory();
    m.remember('search_code', '{"pattern":"Balrog","path":"gamedata.cpp"}', 1);
    expect(m.earlier('search_code', '{ "path": "gamedata.cpp", "pattern": " balrog " }')).toBe(1);
    expect(m.earlier('search_code', '{"pattern":"Balrog"}')).toBeUndefined();
    expect(m.earlier('search_rules', '{"pattern":"Balrog","path":"gamedata.cpp"}')).toBeUndefined();
  });

  it('treats batched queries in the same order as repeats', () => {
    const m = new CallMemory();
    m.remember('find_definition', '{"queries":["I_PICK","I_AXE"]}', 3);
    expect(m.earlier('find_definition', '{"queries":["i_pick","i_axe"]}')).toBe(3);
    expect(m.earlier('find_definition', '{"queries":["I_PICK"]}')).toBeUndefined();
  });

  it('covers line ranges inside an earlier read of the same file', () => {
    const m = new CallMemory();
    m.remember('read_file', '{"path":"standard/extra.cpp","start_line":100,"end_line":260}', 2);
    expect(
      m.earlier('read_file', '{"path":"./standard/extra.cpp","start_line":120,"end_line":228}'),
    ).toBe(2);
    expect(
      m.earlier('read_file', '{"path":"standard/extra.cpp","start_line":150,"end_line":260}'),
    ).toBe(2);
    // Without end_line the default window is 150 lines: 150-299 extends past 260.
    expect(
      m.earlier('read_file', '{"path":"standard/extra.cpp","start_line":150}'),
    ).toBeUndefined();
  });

  it('does not cover ranges that extend past earlier reads', () => {
    const m = new CallMemory();
    m.remember('read_file', '{"path":"a.cpp","start_line":100,"end_line":200}', 2);
    expect(
      m.earlier('read_file', '{"path":"a.cpp","start_line":150,"end_line":260}'),
    ).toBeUndefined();
    expect(
      m.earlier('read_file', '{"path":"b.cpp","start_line":120,"end_line":130}'),
    ).toBeUndefined();
    // Default window: start_line 1 means lines 1-150.
    m.remember('read_file', '{"path":"c.cpp"}', 4);
    expect(
      m.earlier('read_file', '{"path":"c.cpp","start_line":10,"end_line":20}'),
    ).toBeUndefined();
  });

  it('keeps rules ranges per variant and ignores unparseable arguments', () => {
    const m = new CallMemory();
    m.remember('read_rules', '{"start_line":1,"end_line":100}', 1);
    expect(m.earlier('read_rules', '{"start_line":10,"end_line":50}')).toBe(1);
    expect(
      m.earlier('read_rules', '{"start_line":10,"end_line":50,"variant":"fracas"}'),
    ).toBeUndefined();
    m.remember('read_file', 'not json', 2);
    expect(m.earlier('read_file', 'not json')).toBeUndefined();
  });
});
