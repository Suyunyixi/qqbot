import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { parse as parseEnv } from 'dotenv';

const configSchema = z.object({
  trigger: z.object({ keywords: z.array(z.string().min(1)).default([]), directMessages: z.boolean().default(true) }).default({ keywords: [], directMessages: true }),
  model: z.object({ provider: z.enum(['openai', 'anthropic']).default('openai'), baseUrl: z.string().url().default('https://api.deepseek.com'), name: z.string().min(1).default('deepseek-flash'), apiKey: z.string().default(''), timeoutMs: z.number().int().min(1000).default(120000), vision: z.boolean().default(true), semanticReview:z.boolean().default(true), contextTokens: z.number().int().min(4096).max(1048576).default(65536) }).default({ provider: 'openai', baseUrl: 'https://api.deepseek.com', name: 'deepseek-flash', apiKey: '', timeoutMs: 120000, vision: true, semanticReview:true, contextTokens: 65536 }),
  memory: z.object({ recentMessages: z.number().int().min(5).max(300).default(25), summarizeAfter: z.number().int().min(10).default(80) }).default({ recentMessages: 25, summarizeAfter: 80 }),
  tools: z.object({ search: z.boolean().default(true), searchUrl: z.string().url().default('http://searxng:8080'), searchProvider: z.enum(['auto','deepseek','searxng']).default('auto'), deepseekSearchBaseUrl: z.string().url().default('https://api.deepseek.com/anthropic/v1'), deepseekSearchModel: z.string().min(1).default('deepseek-v4-flash'), media: z.boolean().default(true), python: z.boolean().default(true), pythonRunnerUrl: z.string().url().default('http://python-runner:8766'), voice: z.boolean().default(false), voiceName: z.string().default('zh-CN-XiaoxiaoNeural') }).default({ search: true, searchUrl: 'http://searxng:8080', searchProvider: 'auto', deepseekSearchBaseUrl: 'https://api.deepseek.com/anthropic/v1', deepseekSearchModel: 'deepseek-v4-flash', media: true, python: true, pythonRunnerUrl: 'http://python-runner:8766', voice: false, voiceName: 'zh-CN-XiaoxiaoNeural' }),
  sandbox: z.object({ permissions: z.object({ network: z.boolean().default(true), process: z.boolean().default(true), workspaceRead: z.boolean().default(true), workspaceWrite: z.boolean().default(true) }).default({ network: true, process: true, workspaceRead: true, workspaceWrite: true }) }).default({ permissions: { network: true, process: true, workspaceRead: true, workspaceWrite: true } }),
  delivery: z.object({ chunkCharacters: z.number().int().min(100).max(4000).default(1500), proactive: z.boolean().default(true) }).default({ chunkCharacters: 1500, proactive: true }),
  tasks: z.object({ concurrency: z.number().int().min(1).max(8).default(2), timeoutMs: z.number().int().min(10000).default(1800000) }).default({ concurrency: 2, timeoutMs: 1800000 }),
});
export type AppConfig = z.infer<typeof configSchema>;
export const runtimeOverrideSchema = z.object({
  model:z.object({provider:z.enum(['openai','anthropic']).optional(),baseUrl:z.string().url().optional(),name:z.string().min(1).optional(),apiKey:z.string().min(1).optional(),vision:z.boolean().optional(),semanticReview:z.boolean().optional(),contextTokens:z.number().int().min(4096).max(1048576).optional(),timeoutMs:z.number().int().min(1000).optional()}).optional(),
  memory:z.object({recentMessages:z.number().int().min(5).max(300).optional(),summarizeAfter:z.number().int().min(10).optional()}).optional(),
  tasks:z.object({concurrency:z.number().int().min(1).max(8).optional(),timeoutMs:z.number().int().min(10000).optional()}).optional(),
  tools:z.object({search:z.boolean().optional(),media:z.boolean().optional(),python:z.boolean().optional()}).optional(),
});
let runtimeConfigProvider: (() => string | undefined) | undefined;
export function setRuntimeConfigProvider(provider?: () => string | undefined): void { runtimeConfigProvider=provider; }
export const dataDir = path.resolve(process.env.BOT_DATA_DIR ?? './data');
function databasePath(envName: string, fallback: string): string {
  const file = path.resolve(process.env[envName] ?? path.join(dataDir, fallback));
  if (!file.startsWith(dataDir + path.sep)) throw new Error(`${envName} 必须位于数据目录内`);
  return file;
}
export const sqlitePath = databasePath('BOT_SQLITE_PATH', 'bot.sqlite');
export const checkpointPath = databasePath('BOT_CHECKPOINT_PATH', 'checkpoints.sqlite');
export const configPath = path.resolve(process.env.BOT_CONFIG_PATH ?? path.join(dataDir, 'config.yaml'));

export function initConfig(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, stringify(configSchema.parse({})), { mode: 0o600 });
}
export function readConfig(): AppConfig {
  initConfig();
  const data = parse(fs.readFileSync(configPath, 'utf8')) ?? {};
  const config = configSchema.parse(data);
  const modelEnvPath = process.env.BOT_MODEL_ENV_PATH;
  const runtimeEnv = modelEnvPath && fs.existsSync(modelEnvPath) ? parseEnv(fs.readFileSync(modelEnvPath)) : {};
  const env = (name: string) => runtimeEnv[name] || process.env[name];
  if (env('MODEL_PROVIDER')) config.model.provider = env('MODEL_PROVIDER') as 'openai' | 'anthropic';
  if (env('MODEL_BASE_URL')) config.model.baseUrl = env('MODEL_BASE_URL')!;
  if (env('MODEL_NAME')) config.model.name = env('MODEL_NAME')!;
  if (env('MODEL_API_KEY')) config.model.apiKey = env('MODEL_API_KEY')!;
  if (process.env.SEARCH_BASE_URL) config.tools.searchUrl = process.env.SEARCH_BASE_URL;
  if (env('SEARCH_PROVIDER')) config.tools.searchProvider = env('SEARCH_PROVIDER') as 'auto' | 'deepseek' | 'searxng';
  if (env('DEEPSEEK_SEARCH_BASE_URL')) config.tools.deepseekSearchBaseUrl = env('DEEPSEEK_SEARCH_BASE_URL')!;
  if (env('DEEPSEEK_SEARCH_MODEL')) config.tools.deepseekSearchModel = env('DEEPSEEK_SEARCH_MODEL')!;
  if (process.env.PYTHON_RUNNER_URL) config.tools.pythonRunnerUrl = process.env.PYTHON_RUNNER_URL;
  const stored=runtimeConfigProvider?.();
  if (stored) {
    const override=runtimeOverrideSchema.parse(JSON.parse(stored));
    for (const section of ['model','memory','tasks','tools'] as const) if (override[section]) Object.assign(config[section],override[section]);
  }
  return configSchema.parse(config);
}

// Only supported operational preferences can be changed by the model.
export function updatePreference(key: string, value: unknown): AppConfig {
  const allowed: Record<string, (v: unknown) => unknown> = {
    'tools.voiceName': (v) => z.string().min(1).max(100).parse(v),
    'tools.voice': (v) => z.boolean().parse(v),
    'delivery.chunkCharacters': (v) => z.number().int().min(100).max(4000).parse(v),
  };
  const validate = allowed[key];
  if (!validate) throw new Error('该设置不允许通过聊天修改');
  const current = parse(fs.readFileSync(configPath, 'utf8')) ?? {};
  const [section, field] = key.split('.');
  if (!section || !field) throw new Error('无效设置');
  current[section] ??= {};
  current[section][field] = validate(value);
  const result = configSchema.parse(current);
  const temporary = `${configPath}.tmp`;
  fs.writeFileSync(temporary, stringify(result), { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  return result;
}
