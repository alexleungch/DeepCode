export interface Skill {
  name: string;
  description: string;
  /** Instruction body (markdown) */
  body: string;
  /** Source scope */
  scope: 'user' | 'project' | 'plugin' | 'builtin';
  /** Directory path (where auxiliary files live) */
  dir: string;
  sizeTokens: number;
}

export interface SkillScopeConfig {
  enabled: boolean;
  directories: string[];
}
