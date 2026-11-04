import type { AppConfig } from '../config/settings.js';
import type { InboundEvent } from '../domain/types.js';

export function shouldRespond(event: InboundEvent, config: AppConfig): boolean {
  if (event.scope === 'c2c') return config.trigger.directMessages;
  return event.isMention || config.trigger.keywords.some((keyword) => event.content.includes(keyword));
}
