import type { AppConfig } from '../config/settings.js';

export type ToolPermission = 'network' | 'process' | 'workspaceRead' | 'workspaceWrite';
export const toolPermissions: Record<string, readonly ToolPermission[]> = {
  sandbox_capabilities: [], search_chat_history: [], read_chat_history: [], read_chat_message: [], remember_fact: [], list_chat_images: [], read_chat_image: [],
  web_search: ['network'], research_web: ['network'], search_images: ['network'], read_webpage: ['network'], download_file: ['network', 'workspaceWrite'], current_time: [],
  download_media: ['network', 'process', 'workspaceWrite'],
  extract_audio: ['process', 'workspaceRead', 'workspaceWrite'],
  inspect_media: ['process', 'workspaceRead'],
  deliver_media: ['process', 'workspaceRead', 'workspaceWrite'],
  run_python_script: ['process', 'workspaceRead', 'workspaceWrite'], run_shell_command: ['process', 'workspaceRead', 'workspaceWrite'], render_image_card: ['process', 'workspaceWrite'],
  send_text: [], send_media: ['workspaceRead'], send_native_card: [], send_keyboard: [], send_embed: [],
  speak: ['network', 'process', 'workspaceRead', 'workspaceWrite'],
  set_voice: ['network', 'process'], list_voices: ['network', 'process'],
  start_background_task: [], check_background_task: [], cancel_background_task: [],
  list_background_tasks: [], update_background_task: [], list_pending_deliveries: [], retry_delivery: ['workspaceRead'],
  ask_user: [], report_progress: [],
  owner_set_group_preferences: [], owner_add_memory: [], owner_qq_api: ['network'],
};
export function permitted(required: readonly ToolPermission[], config: AppConfig): boolean {
  return required.every((permission) => config.sandbox.permissions[permission]);
}
export function filesystemRules(config: AppConfig) {
  const rules: Array<{ operations: Array<'read' | 'write'>; paths: string[]; mode: 'deny' }> = [];
  if (!config.sandbox.permissions.workspaceRead) rules.push({ operations: ['read'], paths: ['/**'], mode: 'deny' });
  if (!config.sandbox.permissions.workspaceWrite) rules.push({ operations: ['write'], paths: ['/**'], mode: 'deny' });
  return rules;
}
