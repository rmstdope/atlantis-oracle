import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { PathError } from '../repo/paths.js';
import { findDefinition } from './findDefinition.js';
import { listDir } from './listDir.js';
import { readFile } from './readFile.js';
import { readRules, searchRules } from './rules.js';
import { searchCode } from './searchCode.js';
import { ToolError, type Tool, type ToolContext } from './types.js';

export type { Tool, ToolContext } from './types.js';

/** Tools over the player rules; the agent offers these first. */
export const rulesTools: Tool[] = [searchRules, readRules] as Tool[];

/** Tools over the game source code. */
export const codeTools: Tool[] = [searchCode, readFile, listDir, findDefinition] as Tool[];

export const defaultTools: Tool[] = [...rulesTools, ...codeTools];

export function toOpenAITools(tools: Tool[]): ChatCompletionFunctionTool[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema) as Record<
      string,
      unknown
    >;
    return {
      type: 'function',
      function: { name: t.name, description: t.description, parameters },
    };
  });
}

/**
 * Runs a tool call from the model. Never throws: every failure becomes an
 * error string the model can react to.
 */
export async function runTool(
  tools: Tool[],
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<{ output: string; ok: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      ok: false,
      output: `Error: unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}`,
    };
  }

  let json: unknown;
  try {
    json = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
  } catch {
    return { ok: false, output: `Error: arguments are not valid JSON: ${rawArgs.slice(0, 200)}` };
  }

  const parsed = tool.schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, output: `Error: invalid arguments for ${name}: ${issues.join('; ')}` };
  }

  try {
    return { ok: true, output: await tool.handler(parsed.data, ctx) };
  } catch (err) {
    if (err instanceof ToolError || err instanceof PathError) {
      return { ok: false, output: `Error: ${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `Error: ${name} failed: ${message}` };
  }
}
