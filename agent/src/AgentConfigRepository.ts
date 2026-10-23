import * as fse from "fs-extra";
import * as path from "path";
import { Config } from "./Config";
import { ExecFileError, extractErrorDetail, runCli } from "./CliUtils";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { AgentSkill, listSkillsInDir } from "./CoreSkills";

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

/**
 * Checks an AGENT_CONFIG_FOLDER value: it must name a relative folder inside
 * the synced repository. Returns the reason when invalid, null when valid.
 * An empty value (repository root) is valid; a trailing slash is accepted.
 */
export function validateAgentConfigFolder(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.includes("\\")) {
    return "backslashes are not allowed";
  }
  const folder = trimmed.replace(/\/+$/, "");
  if (
    folder.length === 0 ||
    folder.startsWith("/") ||
    /^[A-Za-z]:/.test(folder)
  ) {
    return "the path must be relative";
  }
  const segments = folder.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "empty path segments are not allowed";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "'.' and '..' segments are not allowed";
  }
  return null;
}

// Fails safe to the repository root for an invalid value: a hot-reloaded
// bad value can never escape the synced repository.
function normalizeFolderPath(value: string): string {
  if (validateAgentConfigFolder(value) !== null) {
    return "";
  }
  return value.trim().replace(/\/+$/, "");
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
  return listSkillsInDir(getAgentSkillsPath(config));
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
