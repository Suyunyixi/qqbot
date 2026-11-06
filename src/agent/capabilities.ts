import type { Scope } from '../domain/types.js';

/** Derive capabilities from the tools actually registered for this turn. */
export function capabilityManifest(direct: string[], worker: string[], scope: Scope, networkEnabled = true) {
  const current = new Set(direct);
  const delegated = current.has('start_background_task') ? new Set(worker) : new Set<string>();
  const has = (name: string) => current.has(name) || delegated.has(name);
  const scriptDownload = networkEnabled && (has('run_python_script') || has('run_shell_command'));
  return {
    directToolCount: direct.length,
    backgroundOnlyTools: [...delegated].filter((name) => !current.has(name)).slice(0,12),
    backgroundToolCount: delegated.size,
    downloads: { publicFiles: has('download_file') || scriptDownload, supportedMediaSites: has('download_media') ? true : scriptDownload ? null : false, scriptFallback: scriptDownload },
    scripts: { python: has('run_python_script'), shell: has('run_shell_command') },
    delivery: { text: has('send_text'), image: has('send_media'), filesAndVideo: has('send_media') && (scope === 'group' || scope === 'c2c'), nativeCard: has('send_native_card') },
  };
}
