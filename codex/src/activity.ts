import type { PageActivity } from '@moben-ai/app-sdk';

const executionItems = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'collabToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration',
]);

/** Current upstream evidence for one thread; no timers or guesses from silence. */
export class TaskActivity {
  turnId: string | null = null;
  running = false;
  revision = 0;
  private flags = new Set<string>();
  private items = new Map<string, PageActivity>();
  private completed = new Set<string>();
  private retired = new Set<string>();
  private uncertain = false;

  get state(): PageActivity {
    if (!this.running) return 'idle';
    if (this.flags.has('waitingOnApproval')) return 'waitingApproval';
    if (this.flags.has('waitingOnUserInput')) return 'waitingInput';
    if (this.uncertain || [...this.flags].some(flag => !['waitingOnApproval', 'waitingOnUserInput'].includes(flag))) return 'waiting';
    // Parallel tools keep executing until the last one ends. Blocking flags
    // outrank all work, and tool execution outranks concurrent reasoning.
    const active = [...this.items.values()];
    if (active.includes('executing')) return 'executing';
    if (active.includes('thinking')) return 'thinking';
    return 'waiting';
  }

  start(turnId: string): boolean {
    if (!turnId || this.retired.has(turnId)) return false;
    if (this.turnId !== turnId) {
      if (this.turnId) this.retire(this.turnId);
      if (this.turnId || !this.running) this.clearWork();
      this.turnId = turnId;
    }
    this.running = true;
    ++this.revision;
    return true;
  }

  stop(turnId?: string): boolean {
    if (turnId && this.turnId && turnId !== this.turnId) return false;
    if (turnId && this.running && !this.turnId && this.retired.has(turnId)) return false;
    if (turnId) this.retire(turnId);
    if (this.turnId) this.retire(this.turnId);
    this.turnId = null;
    this.running = false;
    this.clearWork();
    ++this.revision;
    return true;
  }

  status(status: any): boolean {
    if (!status || typeof status.type !== 'string') return false;
    if (!['active', 'idle', 'notLoaded', 'systemError'].includes(status.type)) {
      if (!this.running) return false;
      this.items.clear(); this.flags = new Set(['unknown']); ++this.revision;
      return true;
    }
    if (status.type !== 'active') return this.stop();
    this.running = true;
    this.flags = new Set(Array.isArray(status.activeFlags) ? status.activeFlags.filter((flag: unknown) => typeof flag === 'string') : ['unknown']);
    ++this.revision;
    return true;
  }

  started(turnId: string, item: { id?: string; type?: string; status?: string }): boolean {
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || !this.accepts(turnId) || this.completed.has(item.id)) return false;
    if (['completed', 'failed', 'declined', 'interrupted'].includes(item.status ?? '')) return this.finished(turnId, item.id);
    ++this.revision;
    if (this.uncertain) return true;
    if (this.items.size >= 512 && !this.items.has(item.id)) { this.uncertain = true; this.items.clear(); return true; }
    this.items.set(item.id, item.type === 'reasoning' ? 'thinking' : executionItems.has(item.type) ? 'executing' : 'waiting');
    return true;
  }

  reasoning(turnId: string, itemId: string): boolean {
    // The text itself is never retained or sent to the device status channel.
    return this.started(turnId, { id: itemId, type: 'reasoning' });
  }

  finished(turnId: string, itemId: string): boolean {
    if (typeof itemId !== 'string' || !this.accepts(turnId) || this.completed.has(itemId)) return false;
    ++this.revision;
    this.items.delete(itemId);
    if (!this.uncertain) {
      if (this.completed.size >= 2048) { this.uncertain = true; this.items.clear(); this.completed.clear(); }
      else this.completed.add(itemId);
    }
    return true;
  }

  private accepts(turnId: string): boolean {
    if (typeof turnId !== 'string' || !turnId || !this.running || this.retired.has(turnId)) return false;
    // A status snapshot may establish active before its first item arrives.
    this.turnId ??= turnId;
    return this.turnId === turnId;
  }

  private clearWork() {
    this.items.clear(); this.completed.clear(); this.flags.clear(); this.uncertain = false;
  }

  private retire(turnId: string) {
    this.retired.add(turnId);
    if (this.retired.size > 64) this.retired.delete(this.retired.values().next().value!);
  }
}
