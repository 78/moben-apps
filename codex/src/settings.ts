import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodexServer, JsonValue } from './codex';

export type TaskSettings = { model: string; effort: string; serviceTier: string };
export type SettingsChoice = Partial<TaskSettings>;
export type SettingsField = keyof TaskSettings;
export const SETTINGS_FIELDS: SettingsField[] = ['model', 'effort', 'serviceTier'];

export type ModelInfo = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
  tiers: { id: string; name: string }[];
  isDefault: boolean;
};

// Codex's standard speed; the other tiers come from model/list.
export const STANDARD_TIER = 'default';

const MODELS_TTL_MS = 10 * 60 * 1000;
// The desktop app may change config.toml at any time.
const DEFAULTS_TTL_MS = 60 * 1000;

const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;

/**
 * Model, reasoning effort and speed for tasks. New tasks use the choices made
 * on the device, then the desktop's Codex config; every value is checked
 * against what the chosen model supports.
 */
export class SettingsStore {
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;
  private defaultsCache: { at: number; choice: SettingsChoice } | null = null;
  private saved: SettingsChoice;

  constructor(private codex: CodexServer, private file: string) {
    this.saved = this.load();
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_TTL_MS) return this.modelsCache.models;
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: JsonValue = await this.codex.request('model/list', { limit: 50, cursor });
      for (const model of page.data ?? []) {
        if (model.hidden) continue;
        models.push({
          id: model.id,
          name: model.displayName || model.id,
          efforts: (model.supportedReasoningEfforts ?? []).map((option: JsonValue) => option.reasoningEffort),
          defaultEffort: model.defaultReasoningEffort,
          tiers: (model.serviceTiers ?? []).map((tier: JsonValue) => ({ id: tier.id, name: tier.name })),
          isDefault: !!model.isDefault,
        });
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /** The desktop's config.toml values. */
  async defaults(): Promise<SettingsChoice> {
    if (this.defaultsCache && Date.now() - this.defaultsCache.at < DEFAULTS_TTL_MS) return this.defaultsCache.choice;
    const { config } = await this.codex.request('config/read', {});
    const choice = { model: text(config?.model), effort: text(config?.model_reasoning_effort), serviceTier: text(config?.service_tier) };
    this.defaultsCache = { at: Date.now(), choice };
    return choice;
  }

  /** Settings for a new task. */
  async forNewTask(): Promise<TaskSettings> {
    return this.resolve(this.saved, await this.defaults());
  }

  saveForNewTasks(change: SettingsChoice) {
    this.saved = { ...this.saved, ...change };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.saved, null, 2)}\n`);
  }

  /** Takes each field from the first layer that sets a value the model supports. */
  async resolve(...layers: SettingsChoice[]): Promise<TaskSettings> {
    const models = await this.models();
    const model = layers.map(layer => models.find(m => m.id === layer.model)).find(Boolean)
      ?? models.find(m => m.isDefault) ?? models[0];
    if (!model) throw new Error('Codex lists no models');
    const effort = layers.map(layer => layer.effort).find(value => value && model.efforts.includes(value))
      ?? model.defaultEffort;
    const serviceTier = layers.map(layer => layer.serviceTier)
      .find(value => value === STANDARD_TIER || model.tiers.some(tier => tier.id === value)) ?? STANDARD_TIER;
    return { model: model.id, effort, serviceTier };
  }

  /** Whether value is a choice the device may offer for field. */
  async isValid(field: SettingsField, value: string): Promise<boolean> {
    const models = await this.models();
    if (field === 'model') return models.some(m => m.id === value);
    if (field === 'effort') return models.some(m => m.efforts.includes(value));
    return value === STANDARD_TIER || models.some(m => m.tiers.some(tier => tier.id === value));
  }

  private load(): SettingsChoice {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      return Object.fromEntries(SETTINGS_FIELDS.filter(field => text(raw?.[field])).map(field => [field, raw[field]]));
    } catch {
      return {};
    }
  }
}
