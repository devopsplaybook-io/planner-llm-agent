import * as fse from "fs-extra";
import * as path from "path";
import { getAgentSkillsPath, listAgentSkills } from "./AgentConfigRepository";
import { Config } from "./Config";

// A skill, with its name and a short description taken from the SKILL.md
// front matter.
export interface AgentSkill {
  name: string;
  description: string;
}

const SKILL_DESCRIPTION_MAX_LENGTH = 120;

// The skills listing is immutable for the process lifetime: the image skills
// never change and the synced copy only changes through
// AgentConfigRepository.sync(), which invalidates these caches. A config hot
// reload that changes a path makes the key miss naturally, so a synced skill
// change is visible on the first prompt after the next sync (at most
// AGENT_CONFIG_SYNC_INTERVAL, 300 s by default).
interface SkillsCacheSlot {
  key: string;
  skills: Promise<AgentSkill[]>;
}

let coreSkillsCache: SkillsCacheSlot | null = null;
let availableSkillsCache: SkillsCacheSlot | null = null;

/**
 * Clears the skills listing caches: the listing is rebuilt from disk on the
 * next call.
 */
export function invalidateSkillsCache(): void {
  coreSkillsCache = null;
  availableSkillsCache = null;
}

function coreSkillsKey(config: Config): string {
  return getCoreSkillsPath(config);
}

function availableSkillsKey(config: Config): string {
  return `${getCoreSkillsPath(config)}\n${config.AGENT_CONFIG_REPOSITORY.trim()}\n${getAgentSkillsPath(config)}`;
}

/**
 * Caches a pending listing, clearing the slot when it settles unsuccessfully
 * so a rejected promise is never kept and the next call retries.
 */
function cacheSkills(
  slot: SkillsCacheSlot,
  read: () => SkillsCacheSlot | null,
  write: (slot: SkillsCacheSlot | null) => void,
): Promise<AgentSkill[]> {
  write(slot);
  slot.skills.then(
    () => undefined,
    () => {
      if (read() === slot) {
        write(null);
      }
    },
  );
  return slot.skills;
}

/**
 * Returns the directory holding the core skills shipped with the agent
 * image: the configured CORE_SKILLS_PATH when set, otherwise the skills
 * directory sitting next to the compiled code (/opt/app/planner-llm-agent/
 * skills in the image, agent/skills in development).
 */
export function getCoreSkillsPath(config: Config): string {
  if (config.CORE_SKILLS_PATH.trim().length > 0) {
    return config.CORE_SKILLS_PATH;
  }
  return path.resolve(__dirname, "..", "skills");
}

/**
 * Lists the core skills shipped with the agent image, so tasks can use
 * them even when no agent config repository is configured. Malformed
 * skills are skipped; a missing directory yields an empty list.
 */
export async function listCoreSkills(config: Config): Promise<AgentSkill[]> {
  const key = coreSkillsKey(config);
  const cached = coreSkillsCache;
  if (cached !== null && cached.key === key) {
    return cached.skills;
  }
  return cacheSkills(
    { key, skills: listSkillsInDir(key) },
    () => coreSkillsCache,
    (slot) => {
      coreSkillsCache = slot;
    },
  );
}

/**
 * The skills a task can use: the core skills shipped with the agent image
 * merged with the skills synced from the agent config repository. A synced
 * skill with the same name overrides the core one (a deployment can
 * customize a core skill without rebuilding the image); the result is
 * sorted by name.
 */
export async function listAvailableSkills(
  config: Config,
): Promise<AgentSkill[]> {
  const key = availableSkillsKey(config);
  const cached = availableSkillsCache;
  if (cached !== null && cached.key === key) {
    return cached.skills;
  }
  return cacheSkills(
    { key, skills: buildAvailableSkills(config) },
    () => availableSkillsCache,
    (slot) => {
      availableSkillsCache = slot;
    },
  );
}

async function buildAvailableSkills(config: Config): Promise<AgentSkill[]> {
  const [core, synced] = await Promise.all([
    listCoreSkills(config),
    listAgentSkills(config),
  ]);
  const byName = new Map<string, AgentSkill>();
  for (const skill of core) {
    byName.set(skill.name, skill);
  }
  for (const skill of synced) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lists the skills of a directory (one directory per skill, each with its
 * SKILL.md file), sorted by directory name. Malformed skills are skipped;
 * a missing directory yields an empty list.
 */
export async function listSkillsInDir(dir: string): Promise<AgentSkill[]> {
  let entries: string[];
  try {
    entries = await fse.readdir(dir);
  } catch {
    return [];
  }
  const skills: AgentSkill[] = [];
  for (const entry of entries.sort()) {
    const skill = await readSkillFile(path.join(dir, entry, "SKILL.md"));
    if (skill !== null) {
      skills.push(skill);
    }
  }
  return skills;
}

/**
 * Reads one SKILL.md and returns its name and summarized description, or
 * null when the file is missing or malformed (no name or no description).
 */
export async function readSkillFile(
  skillFile: string,
): Promise<AgentSkill | null> {
  let content: string;
  try {
    content = await fse.readFile(skillFile, "utf8");
  } catch {
    return null;
  }
  const frontMatter = parseFrontMatter(content);
  const name = (frontMatter.name ?? "").trim();
  const description = summarizeSkillDescription(frontMatter.description ?? "");
  if (name.length === 0 || description.length === 0) {
    return null;
  }
  return { name, description };
}

// Minimal parser for the SKILL.md front matter: the scalar keys of the
// first YAML block, without nested structures or multi-line values.
export function parseFrontMatter(content: string): Record<string, string> {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return {};
  }
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      break;
    }
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields[match[1].toLowerCase()] = value;
  }
  return fields;
}

// Compact form of a skill description for the task prompt: the first
// sentence when it fits, otherwise a word-boundary truncation.
export function summarizeSkillDescription(description: string): string {
  const text = description.trim();
  const firstSentence =
    text.match(/^[\s\S]*?\.(?=\s+[A-Z]|$)/)?.[0]?.trim() ?? text;
  if (firstSentence.length <= SKILL_DESCRIPTION_MAX_LENGTH) {
    return firstSentence;
  }
  const cut = text.slice(0, SKILL_DESCRIPTION_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const summary = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${summary.trimEnd()}...`;
}
