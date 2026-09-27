import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "./Config";
import { ExecFileError, extractErrorDetail, runCli } from "./CliUtils";
import { OTelLogger, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("agent-config-repository");

const GIT_TIMEOUT_MS = 300000;

/**
 * Returns the local directory where the agent config repository is synced.
 */
export function getAgentConfigPath(config: Config): string {
  return path.join(config.DATA_DIR, "agent-config");
}

/**
 * Returns the local directory holding the configuration content: the synced
 * repository itself, or the configured folder inside it.
 */
export function getAgentConfigContentPath(config: Config): string {
  const folder = normalizeFolderPath(config.AGENT_CONFIG_FOLDER);
  return folder.length > 0
    ? path.join(getAgentConfigPath(config), folder)
    : getAgentConfigPath(config);
}

function normalizeFolderPath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Returns the local directory holding the skills of the config repository
 * (one directory per skill, each with its SKILL.md file).
 */
export function getAgentSkillsPath(config: Config): string {
  const contentPath = getAgentConfigContentPath(config);
  // AGENT_CONFIG_FOLDER may point at the skills folder itself (e.g. a
  // sparse checkout of the repository's 'skills' folder): the synced
  // content path then already is the skills directory.
  return path.basename(contentPath) === "skills"
    ? contentPath
    : path.join(contentPath, "skills");
}

// A skill of the config repository, with its name and a short description
// taken from the SKILL.md front matter.
export interface AgentSkill {
  name: string;
  description: string;
}

const SKILL_DESCRIPTION_MAX_LENGTH = 120;

/**
 * Lists the skills synced from the config repository, so the task prompt
 * can tell the CLI which skills exist and when to use them. Malformed
 * skills are skipped; the list is empty when no repository is configured
 * or no skills are found.
 */
export async function listAgentSkills(config: Config): Promise<AgentSkill[]> {
  if (config.AGENT_CONFIG_REPOSITORY.trim().length === 0) {
    return [];
  }
  const skillsDir = getAgentSkillsPath(config);
  let entries: string[];
  try {
    entries = await fse.readdir(skillsDir);
  } catch {
    return [];
  }
  const skills: AgentSkill[] = [];
  for (const entry of entries.sort()) {
    const skill = await readAgentSkill(path.join(skillsDir, entry, "SKILL.md"));
    if (skill !== null) {
      skills.push(skill);
    }
  }
  return skills;
}

async function readAgentSkill(skillFile: string): Promise<AgentSkill | null> {
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
function parseFrontMatter(content: string): Record<string, string> {
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
function summarizeSkillDescription(description: string): string {
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

/**
 * Keeps the agent configuration (skills, configuration files and other
 * resources) in sync with a dedicated Git repository configured through
 * AGENT_CONFIG_REPOSITORY.
 *
 * The repository is cloned at startup and refreshed periodically. It is
 * stored under DATA_DIR/agent-config and the working tree is always forced
 * to match the remote branch, so the local copy is a faithful mirror of the
 * repository content. Authentication relies on the Git and GitHub
 * environment prepared by GitEnvironment (token credential helper or SSH
 * key); public repositories require no authentication.
 */
export class AgentConfigRepository {
  private config: Config;
  private syncing = false;

  constructor(config: Config) {
    this.config = config;
  }

  public isEnabled(): boolean {
    return this.config.AGENT_CONFIG_REPOSITORY.trim().length > 0;
  }

  /**
   * Clones or updates the configured repository and returns the local path
   * holding the configuration content (empty when not configured).
   */
  public async sync(): Promise<string> {
    if (!this.isEnabled()) {
      return "";
    }
    if (this.syncing) {
      // A refresh is already running: the content on disk stays coherent, so
      // the current content path can be returned as-is.
      return getAgentConfigContentPath(this.config);
    }
    const span = OTelTracer().startSpan("agent-config-repository.sync");
    this.syncing = true;
    try {
      const repository = this.config.AGENT_CONFIG_REPOSITORY.trim();
      const branch = this.config.AGENT_CONFIG_BRANCH.trim() || "main";
      const folder = normalizeFolderPath(this.config.AGENT_CONFIG_FOLDER);
      const targetDir = getAgentConfigPath(this.config);

      // A changed repository URL invalidates the existing clone.
      let origin = await this.getOriginUrl(targetDir);
      if (origin !== null && origin !== repository) {
        logger.info(
          `Agent config repository URL changed: re-cloning '${repository}'`,
        );
        await fse.remove(targetDir);
        origin = null;
      }

      if (origin === null) {
        // Remove any stale directory left behind by a failed previous clone.
        await fse.remove(targetDir);
        await this.cloneRepository(repository, targetDir, branch, folder);
      } else {
        await this.updateClone(targetDir, branch, folder);
      }

      const revision = (
        await this.git(["rev-parse", "--short", "HEAD"], targetDir)
      ).stdout.trim();
      const contentPath = getAgentConfigContentPath(this.config);
      logger.info(
        `Agent config repository synced at revision ${revision} (${contentPath})`,
      );
      return contentPath;
    } catch (error) {
      span.recordException(error as Error);
      throw new Error(
        `Agent config repository sync failed:\n${extractErrorDetail(error as ExecFileError)}`,
        { cause: error },
      );
    } finally {
      this.syncing = false;
      span.end();
    }
  }

  private async getOriginUrl(targetDir: string): Promise<string | null> {
    if (!(await fse.pathExists(path.join(targetDir, ".git")))) {
      return null;
    }
    try {
      return (
        await this.git(["remote", "get-url", "origin"], targetDir)
      ).stdout.trim();
    } catch {
      // Broken clone: fall through to a fresh clone.
      return null;
    }
  }

  private async cloneRepository(
    repository: string,
    targetDir: string,
    branch: string,
    folder: string,
  ): Promise<void> {
    await this.git([
      "clone",
      "--depth",
      "1",
      "--branch",
      branch,
      repository,
      targetDir,
    ]);
    if (folder.length > 0) {
      // Shallow cone-mode sparse checkout: the working tree is pruned to the
      // configured folder right after the clone (root files are always kept).
      await this.git(["sparse-checkout", "init", "--cone"], targetDir);
      await this.git(["sparse-checkout", "set", folder], targetDir);
    }
  }

  private async updateClone(
    targetDir: string,
    branch: string,
    folder: string,
  ): Promise<void> {
    await this.git(["fetch", "--depth", "1", "origin", branch], targetDir);
    if (folder.length > 0) {
      await this.git(["sparse-checkout", "init", "--cone"], targetDir);
      await this.git(["sparse-checkout", "set", folder], targetDir);
    }
    // Force the checked out state to the fetched revision and drop anything
    // that is not tracked anymore.
    await this.git(["checkout", "-f", "-B", branch, "FETCH_HEAD"], targetDir);
    await this.git(["clean", "-fd"], targetDir);
  }

  private git(
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return runCli("git", args, {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      cwd: cwd ?? process.cwd(),
    });
  }
}
