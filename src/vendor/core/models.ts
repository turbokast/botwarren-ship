/**
 * VENDORED FILE: models.ts of the Botwarren core contract (event schema, local reducer, one-way public projection, public schema).
 * Copied verbatim from the Botwarren core package when this repository was exported; the only edits are this header and, in
 * public.ts, the removal of constants that belong to the hosted service. Do not edit here: changes to the public contract are made
 * upstream and re-exported, and reviewed as a change to what this agent may publish.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Model identity tables: raw model id -> (maker, line). Part of the public privacy contract (vendored into botwarren-ship):
 * only these closed names ever leave the machine, never the raw id or version. Rules are tried in order, most specific first.
 * Catalogue researched 2026-10-16 from vendor model pages. Bare common words
 * (sol, luna, astra, spark, o3, nova, step, composer) only match inside a model context, never on their own.
 */
export const MODEL_MAKERS = [
  'anthropic', 'openai', 'google', 'meta', 'xai', 'deepseek', 'moonshot', 'alibaba', 'zhipu', 'minimax', 'mistral', 'nvidia',
  'microsoft', 'cursor', 'inception', 'amazon', 'cohere', 'ibm', 'bytedance', 'tencent', 'baidu', 'xiaomi', 'stepfun', 'other',
] as const;
export const MODEL_LINES = [
  // Anthropic
  'fable', 'mythos', 'opus', 'sonnet', 'haiku',
  // OpenAI: GPT-6 Astra / Sol / Luna (+ GPT-5.6 Terra); older GPT and o-series fall back to gpt / gpt-mini; open weights
  'astra', 'sol', 'terra', 'luna', 'gpt', 'gpt-mini', 'gpt-oss',
  // Meta Muse (Wonder, Spark, Glimmer) and Llama
  'wonder', 'spark', 'glimmer', 'llama',
  // Google
  'gemini-pro', 'gemini-flash', 'gemini-lite', 'gemini', 'gemma',
  // everyone else: one line per maker family
  'grok', 'grok-build', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'mistral', 'devstral', 'nemotron', 'mai', 'composer',
  'mercury', 'nova', 'command', 'granite', 'doubao', 'hunyuan', 'ernie', 'mimo', 'step',
  'other',
] as const;
export type ModelMakerName = (typeof MODEL_MAKERS)[number];
export type ModelLineName = (typeof MODEL_LINES)[number];
export type ModelId = { maker: ModelMakerName; model: ModelLineName };

/** model-context words that make a bare tier name (sol, luna, spark...) safe to read as a model */
const OAI = /(gpt|openai|codex)/;
const T = (w: string) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`);

const RULES: { re: RegExp; when?: RegExp; maker: ModelMakerName; model: ModelLineName }[] = [
  // Anthropic
  { re: /fable/, when: /claude|fable/, maker: 'anthropic', model: 'fable' },
  { re: /mythos/, maker: 'anthropic', model: 'mythos' },
  { re: /opus/, maker: 'anthropic', model: 'opus' },
  { re: /sonnet/, maker: 'anthropic', model: 'sonnet' },
  { re: /haiku/, maker: 'anthropic', model: 'haiku' },
  { re: /claude/, maker: 'anthropic', model: 'other' },
  // Meta Muse before OpenAI so "muse-spark" is never codex-spark
  { re: /muse[-_ ]?wonder/, maker: 'meta', model: 'wonder' },
  { re: /muse[-_ ]?spark/, maker: 'meta', model: 'spark' },
  { re: /muse[-_ ]?glimmer/, maker: 'meta', model: 'glimmer' },
  { re: /llama/, maker: 'meta', model: 'llama' },
  // OpenAI
  { re: /gpt-?oss/, maker: 'openai', model: 'gpt-oss' },
  { re: T('astra'), when: OAI, maker: 'openai', model: 'astra' },
  { re: T('sol'), when: OAI, maker: 'openai', model: 'sol' },
  { re: T('terra'), when: OAI, maker: 'openai', model: 'terra' },
  { re: T('luna'), when: OAI, maker: 'openai', model: 'luna' },
  { re: /(mini|nano|spark)/, when: /(gpt|codex|(^|[^a-z0-9])o[1-9])/, maker: 'openai', model: 'gpt-mini' },
  { re: /(gpt|codex|(^|[^a-z0-9])o[1-9]([^a-z0-9]|$))/, maker: 'openai', model: 'gpt' },
  // Google
  { re: /gemma/, maker: 'google', model: 'gemma' },
  { re: /gemini.*flash[-_ ]?lite/, maker: 'google', model: 'gemini-lite' },
  { re: /gemini.*flash/, maker: 'google', model: 'gemini-flash' },
  { re: /gemini.*(pro|argon|ultra|deep[-_ ]?think)/, maker: 'google', model: 'gemini-pro' },
  { re: /gemini/, maker: 'google', model: 'gemini' },
  // xAI
  { re: /grok[-_ ]?(build|code)/, maker: 'xai', model: 'grok-build' },
  { re: /grok/, maker: 'xai', model: 'grok' },
  // open-weight and regional labs
  { re: /deepseek/, maker: 'deepseek', model: 'deepseek' },
  { re: /(kimi|moonshot)/, maker: 'moonshot', model: 'kimi' },
  { re: /(qwen|qwq|qvq)/, maker: 'alibaba', model: 'qwen' },
  { re: /(glm|zhipu|(^|[^a-z])z-?ai[^a-z])/, maker: 'zhipu', model: 'glm' },
  { re: /(minimax|abab)/, maker: 'minimax', model: 'minimax' },
  { re: /(devstral|codestral)/, maker: 'mistral', model: 'devstral' },
  { re: /(mistral|magistral|ministral|mixtral)/, maker: 'mistral', model: 'mistral' },
  { re: /nemotron/, maker: 'nvidia', model: 'nemotron' },
  { re: T('mai'), when: /(mai-(code|thinking|ds|1)|microsoft)/, maker: 'microsoft', model: 'mai' },
  { re: /composer/, when: /cursor/, maker: 'cursor', model: 'composer' },
  { re: /mercury/, when: /(inception|mercury-?\d)/, maker: 'inception', model: 'mercury' },
  { re: /nova/, when: /(amazon|nova-(lite|pro|micro|premier|\d))/, maker: 'amazon', model: 'nova' },
  { re: /(command-?a|command-?r|cohere)/, maker: 'cohere', model: 'command' },
  { re: /granite/, maker: 'ibm', model: 'granite' },
  { re: /(doubao|seed-\d|bytedance)/, maker: 'bytedance', model: 'doubao' },
  { re: /(hunyuan|(^|[^a-z])hy\d)/, maker: 'tencent', model: 'hunyuan' },
  { re: /ernie/, maker: 'baidu', model: 'ernie' },
  { re: /mimo/, maker: 'xiaomi', model: 'mimo' },
  { re: /step-?\d/, when: /(stepfun|(^|[^a-z])step-?\d)/, maker: 'stepfun', model: 'step' },
];

/** Classify a raw model id; undefined when there is no id at all (not observed). Unknown ids are `other`, never guessed. */
export function classifyModel(id: string | null | undefined): ModelId | undefined {
  if (!id || !id.trim()) return undefined;
  const m = id.toLowerCase().trim();
  for (const r of RULES) if (r.re.test(m) && (!r.when || r.when.test(m))) return { maker: r.maker, model: r.model };
  return { maker: 'other', model: 'other' };
}
