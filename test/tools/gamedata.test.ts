import { describe, expect, it } from 'vitest';
import { attachEnumNames, parseEnums, parseGamedata } from '../../src/tools/gamedata.js';

describe('parseGamedata', () => {
  it('parses std::vector tables', () => {
    const tables = parseGamedata(
      'std::vector<SkillType> SkillDefs = {\n  {"tactics","TACT",200},\n};\n',
    );
    expect(tables).toMatchObject([{ name: 'SkillDefs', type: 'SkillType', line: 1 }]);
    expect(tables[0]!.entries[0]!.strings).toEqual(['tactics', 'TACT']);
  });

  it('parses C arrays exposed through a *Defs pointer', () => {
    const src = [
      '// name, abbr, cost',
      'static SkillType sd[] = {',
      '  {"tactics","TACT",200},',
      '  {"x",\'}\',1},',
      '};',
      'SkillType *SkillDefs = sd;',
      'static int helper[] = { 1, 2 };',
    ].join('\n');
    const tables = parseGamedata(src);
    expect(tables.map((t) => t.name)).toEqual(['SkillDefs']);
    expect(tables[0]).toMatchObject({
      type: 'SkillType',
      line: 2,
      legend: ['// name, abbr, cost'],
    });
    expect(tables[0]!.entries.map((e) => e.startLine)).toEqual([3, 4]);

    attachEnumNames(tables, parseEnums('enum {\n S_TACTICS,\n S_X,\n NSKILLS\n};'));
    expect(tables[0]!.entries.map((e) => e.enumName)).toEqual(['S_TACTICS', 'S_X']);
  });
});
