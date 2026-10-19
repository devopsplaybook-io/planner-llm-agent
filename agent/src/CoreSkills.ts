import * as fse from "fs-extra";
import * as path from "path";
import { listAgentSkills } from "./AgentConfigRepository";
import { Config } from "./Config";

// A skill, with its name and a short description taken from the SKILL.md
// front matter.
export interface AgentSkill {
  name: string;
  description: string;
}

const SKILL_DESCRIPTION_MAX_LENGTH = 120;

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
  return listSkillsInDir(getCoreSkillsPath(config));
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
