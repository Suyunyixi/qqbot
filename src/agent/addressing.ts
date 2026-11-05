import type { IdentityAlias } from '../storage/memory.js';

/** Resolve an explicitly named recipient only from identities observed in this conversation. */
export function requestedRecipient(content: string, actorId: string, aliases: IdentityAlias[]): IdentityAlias | undefined {
  if (!/(?:问问|问一下|问下|请|找|叫|让|提醒|通知|咨询)/.test(content)) return undefined;
  const text = content.toLocaleLowerCase();
  const matches = aliases.filter((alias) => alias.external_id !== actorId && alias.display_name && alias.display_name.trim().length >= 2 && text.includes(alias.display_name.trim().toLocaleLowerCase()));
  return new Set(matches.map((match) => match.external_id)).size === 1 ? matches[0] : undefined;
}

/** Turn a textual request to a known recipient into an actual QQ mention. */
export function mentionRecipient(text: string, recipient: IdentityAlias | undefined, alreadyReplied: boolean): string {
  if (!recipient || alreadyReplied || !recipient.display_name) return text;
  if (!text.toLocaleLowerCase().includes(recipient.display_name.trim().toLocaleLowerCase())) return text;
  if (!/[?？]|(?:麻烦|请你|帮忙|帮我|你看|你说|你觉得|你瞅|告诉我|说一声|回复|确认)/.test(text)) return text;
  if (text.includes(`<@${recipient.external_id}>`) || text.includes(`<@!${recipient.external_id}>`)) return text;
  return `<@${recipient.external_id}> ${text}`;
}
