import { z } from 'zod';
import type { Scope } from '../domain/types.js';
import type { Store } from '../storage/store.js';
import { readConfig } from './settings.js';

export const groupSettingsSchema = z.object({
  label: z.string().max(100).default(''),
  enabled: z.boolean(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(100),
  persona: z.string().max(12000),
  engagementWindowSeconds: z.number().int().min(10).max(900).default(180),
  disabledTools: z.array(z.string().min(1).max(100)).max(100),
});
export type GroupSettings = z.infer<typeof groupSettingsSchema>;
export function groupSettings(store: Store, conversationId: string): GroupSettings {
  const defaults = { label: '', enabled: true, keywords: readConfig().trigger.keywords, persona: '', engagementWindowSeconds: 180, disabledTools: [] };
  const saved = store.getSetting(conversationId, 'groupSettings');
  if (!saved) return defaults;
  try { return groupSettingsSchema.parse({ ...defaults, ...JSON.parse(saved) }); }
  catch { return defaults; }
}
export function effectiveTrigger(store: Store, scope: Scope, conversationId: string) {
  const config = readConfig();
  if (scope === 'group') config.trigger.keywords = groupSettings(store, conversationId).keywords;
  return config;
}
