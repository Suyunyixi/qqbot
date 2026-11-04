import { FilesystemBackend } from 'deepagents';
import { virtualWorkspacePath, workspaceFor } from './workspace.js';

/** Make Deep Agents' virtual filesystem accept the same paths as delivery tools. */
export class WorkspaceBackend extends FilesystemBackend {
  constructor(private readonly conversationId: string) { super({ rootDir: workspaceFor(conversationId), virtualMode: true }); }
  private v(file: string): string { return virtualWorkspacePath(this.conversationId, file); }
  override ls(dir: string) { return super.ls(this.v(dir)); }
  override read(file: string, offset?: number, limit?: number) { return super.read(this.v(file), offset, limit); }
  override readRaw(file: string) { return super.readRaw(this.v(file)); }
  override write(file: string, content: string) { return super.write(this.v(file), content); }
  override edit(file: string, oldString: string, newString: string, replaceAll?: boolean) { return super.edit(this.v(file), oldString, newString, replaceAll); }
  override delete(file: string) { return super.delete(this.v(file)); }
  override grep(pattern: string, dir?: string, glob?: string | null, maxCount?: number | null) { return super.grep(pattern, dir === undefined ? undefined : this.v(dir), glob, maxCount); }
  override glob(pattern: string, searchPath?: string) { return super.glob(this.v(pattern), searchPath === undefined ? undefined : this.v(searchPath)); }
  override uploadFiles(files: Array<[string, Uint8Array]>) { return super.uploadFiles(files.map(([file, data]) => [this.v(file), data])); }
  override downloadFiles(files: string[]) { return super.downloadFiles(files.map((file) => this.v(file))); }
}
