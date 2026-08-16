import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Skill } from './types.js';
import type { SkillConfig } from '../config/types.js';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Lenient, line-based frontmatter parser used as a fallback when the strict
 * YAML parser throws (e.g. a value containing "key: sub" that YAML
 * misinterprets as a nested mapping — common in free-form skill descriptions).
 * We only need `name` and `description`, so a best-effort per-line scan is
 * sufficient and keeps the skill loadable instead of silently dropping it.
 */
function lenientFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, string> = {};
  let curKey: string | null = null;
  for (const line of fm.split('\n')) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s?(.*)$/.exec(line);
    if (m && m[1]) {
      curKey = m[1];
      out[curKey] = m[2] ?? '';
    } else if (curKey) {
      out[curKey] = (out[curKey] ?? '') + '\n' + line;
    }
  }
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v !== undefined) out[k] = v.trim();
  }
  return out as unknown as Record<string, unknown>;
}


export function parseSkillFile(file: string): { name: string; description: string; body: string } | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return null;
  const fm = m[1] ?? '';
  let meta: Record<string, unknown>;
  try {
    meta = (parseYaml(fm) ?? {}) as Record<string, unknown>;
  } catch {
    // Strict YAML failed — fall back to the lenient parser so a skill whose
    // frontmatter contains an embedded ": " is not silently dropped.
    meta = lenientFrontmatter(fm);
  }
  const name = typeof meta.name === 'string' ? meta.name : '';
  const description = typeof meta.description === 'string' ? meta.description : '';
  if (!name) return null;
  return { name, description, body: m[2] ?? '' };
}

/** Scan a skill directory (DSH style: <dir>/SKILL.md, YAML frontmatter + markdown body) */
export class SkillLoader {
  constructor(
    private userSkillsDir: string,
    private config: SkillConfig,
    private extraDirs: string[] = [],
  ) {}

  private scanDir(dir: string, scope: Skill['scope']): Skill[] {
    const out: Skill[] = [];
    if (!existsSync(dir)) return out;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const skillDir = join(dir, entry);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const parsed = parseSkillFile(skillFile);
      if (!parsed) {
        // Surface the failure instead of silently skipping the skill.
        console.warn(`[skills] skipped ${skillFile}: no valid 'name' found in frontmatter`);
        continue;
      }
      out.push({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        scope,
        dir: skillDir,
        sizeTokens: Math.max(1, Math.ceil(parsed.body.length / 3.5)),
      });
    }
    return out;
  }

  async loadAll(projectDir?: string): Promise<Skill[]> {
    const scopes: { dir: string; scope: Skill['scope'] }[] = [];
    scopes.push({ dir: this.userSkillsDir, scope: 'user' });
    if (projectDir) scopes.push({ dir: join(projectDir, 'skills'), scope: 'project' });
    for (const d of this.config.directories) scopes.push({ dir: d, scope: 'user' });
    for (const d of this.extraDirs) scopes.push({ dir: d, scope: 'plugin' });

    const all = scopes.flatMap(({ dir, scope }) => this.scanDir(dir, scope));
    // Priority: project > user > plugin; dedupe by name
    const byName = new Map<string, Skill>();
    const priority: Record<Skill['scope'], number> = { project: 0, user: 1, plugin: 2, builtin: 3 };
    for (const s of all) {
      const existing = byName.get(s.name);
      if (!existing || priority[s.scope] < priority[existing.scope]) byName.set(s.name, s);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function skillsCatalog(skills: Skill[], limit = 30): string {
  return skills
    .slice(0, limit)
    .map((s) => `- ${s.name}: ${s.description} (${s.sizeTokens} tokens)`)
    .join('\n');
}
