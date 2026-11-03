import type { ResolvedGuide } from '../guide/store.js';
import type { RulesDoc } from '../rules/store.js';
import type { z } from 'zod';

export interface ToolContext {
  /** Absolute path of the game repository root. */
  root: string;
  /** The game variant the question is about. */
  variant: string;
  /** Player rules per variant; absent when none could be built or found. */
  rules?: RulesLookup;
  /** The code guide resolved for the current commit; present in guide lookup mode. */
  guide?: ResolvedGuide;
}

/** The part of RulesStore the tools need. */
export interface RulesLookup {
  get(variant: string): RulesDoc | undefined;
  readonly variants: string[];
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Read by the model; keep it short and concrete. */
  description: string;
  schema: S;
  handler(args: z.infer<S>, ctx: ToolContext): Promise<string>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

/** An expected failure; the message is returned to the model. */
export class ToolError extends Error {}

/** Cuts `text` to `max` characters on a line boundary and appends a note. */
export function truncate(text: string, max: number, hint = 'narrow your request'): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  const kept = text.slice(0, cut > 0 ? cut : max);
  const droppedLines = text.slice(kept.length).split('\n').filter(Boolean).length;
  return `${kept}\n[truncated: ${droppedLines} more lines, ${hint}]`;
}
