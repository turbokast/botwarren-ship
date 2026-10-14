/** Ship secret loading, kept dependency-free so the CLI bundle does not pull in the agent. Never log the value. */
import { existsSync, readFileSync } from 'node:fs';

export function readShipSecret(path: string): string {
  if (!existsSync(path)) throw new Error(`ship secret file not found: ${path}`);
  const s = readFileSync(path, 'utf8').replace(/^﻿/, '').trim();
  if (s.length < 16) throw new Error(`ship secret file ${path} looks empty or too short`);
  return s;
}
