import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  getCoreSkillsPath,
  listAvailableSkills,
  listCoreSkills,
  listSkillsInDir,
  parseFrontMatter,
  summarizeSkillDescription,
} from "./CoreSkills";
import { Config } from "./Config";

const writeSkill = async (
  dir: string,
  folder: string,
  content: string,
): Promise<void> => {
  await fse.outputFile(path.join(dir, folder, "SKILL.md"), content);
};

const skillFile = (name: string, description: string): string =>
  ["---", `name: ${name}`, `description: "${description}"`, "---", ""].join(
    "\n",
  );

describe("CoreSkills", () => {
  let dataDir: string;
  let config: Config;

  beforeEach(async () => {
    dataDir = await fse.mkdtemp(path.join(os.tmpdir(), "core-skills-spec-"));
    config = new Config();
    config.DATA_DIR = dataDir;
    config.CORE_SKILLS_PATH = path.join(dataDir, "core-skills");
  });

  afterEach(async () => {
    await fse.remove(dataDir);
  });

  describe("listSkillsInDir", () => {
    it("parses the name and description of every skill and sorts them", async () => {
      await writeSkill(
        dataDir,
        "beta",
        skillFile("beta-skill", "Use when handling beta cases."),
      );
      await writeSkill(
        dataDir,
        "alpha",
        skillFile("alpha-skill", "Use when handling alpha cases."),
      );

      await expect(listSkillsInDir(dataDir)).resolves.toEqual([
        { name: "alpha-skill", description: "Use when handling alpha cases." },
        { name: "beta-skill", description: "Use when handling beta cases." },
      ]);
    });

    it("skips malformed skills", async () => {
      await fse.outputFile(
        path.join(dataDir, "not-a-skill", "README.md"),
        "no SKILL.md here",
      );
      await writeSkill(dataDir, "no-front-matter", "# Just a document");
      await writeSkill(dataDir, "no-description", ["---", "name: lonely", "---"].join("\n"));
      await writeSkill(dataDir, "no-name", ["---", "description: Named less.", "---"].join("\n"));
      await writeSkill(dataDir, "valid", skillFile("valid", "Kept."));

      await expect(listSkillsInDir(dataDir)).resolves.toEqual([
        { name: "valid", description: "Kept." },
      ]);
    });

    it("returns an empty list when the directory does not exist", async () => {
      await expect(
        listSkillsInDir(path.join(dataDir, "missing")),
      ).resolves.toEqual([]);
    });
  });

  describe("parseFrontMatter", () => {
    it("parses the scalar keys of the first YAML block", () => {
      expect(
        parseFrontMatter(
          ["---", "name: my-skill", 'description: "Quoted."', "---", "# Body"].join("\n"),
        ),
      ).toEqual({ name: "my-skill", description: "Quoted." });
    });

    it("is case-insensitive on keys and strips single quotes", () => {
      expect(
        parseFrontMatter(["---", "Name: one", "DESCRIPTION: 'two'", "---"].join("\n")),
      ).toEqual({ name: "one", description: "two" });
    });

    it("returns nothing without a front matter block", () => {
      expect(parseFrontMatter("# Just a document")).toEqual({});
      expect(parseFrontMatter("name: no block")).toEqual({});
    });
  });

  describe("summarizeSkillDescription", () => {
    it("keeps the first sentence when it fits", () => {
      expect(
        summarizeSkillDescription("First sentence. Second sentence. Third."),
      ).toBe("First sentence.");
    });

    it("truncates at a word boundary with an ellipsis when the sentence is too long", () => {
      const summary = summarizeSkillDescription(`Use when ${"very ".repeat(40)}long.`);
      expect(summary.length).toBeLessThanOrEqual(123);
      expect(summary.endsWith("...")).toBe(true);
      expect(summary.startsWith("Use when very")).toBe(true);
    });
  });

  describe("getCoreSkillsPath", () => {
    it("returns the configured path when set", () => {
      expect(getCoreSkillsPath(config)).toBe(path.join(dataDir, "core-skills"));
    });

    it("resolves the skills directory shipped next to the compiled code by default", () => {
      config.CORE_SKILLS_PATH = "";
      // In the image the compiled code sits in
      // /opt/app/planner-llm-agent/dist and the skills in
      // /opt/app/planner-llm-agent/skills; in development the sources in
      // agent/src resolve to agent/skills the same way.
      expect(getCoreSkillsPath(config)).toBe(
        path.resolve(__dirname, "..", "skills"),
      );
    });
  });

  describe("listCoreSkills", () => {
    it("lists the skills of the configured core skills directory", async () => {
      await writeSkill(
        config.CORE_SKILLS_PATH,
        "my-core",
        skillFile("my-core", "Use when testing the core list."),
      );

      await expect(listCoreSkills(config)).resolves.toEqual([
        { name: "my-core", description: "Use when testing the core list." },
      ]);
    });

    it("returns an empty list when no core skills directory exists", async () => {
      await expect(listCoreSkills(config)).resolves.toEqual([]);
    });

    it("parses the core skills shipped with the agent", async () => {
      // Default path: the repository's agent/skills directory (in the image:
      // /opt/app/planner-llm-agent/skills). Guards the shipped set against
      // malformed front matter.
      config.CORE_SKILLS_PATH = "";
      const skills = await listCoreSkills(config);
      expect(skills.map((skill) => skill.name)).toEqual([
        "github-checks",
        "github-pull-request",
        "planner-notes",
        "planner-projects",
        "planner-tasks",
        "planner-templates",
      ]);
      for (const skill of skills) {
        expect(skill.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("listAvailableSkills", () => {
    it("lists the core skills when no config repository is configured", async () => {
      await writeSkill(
        config.CORE_SKILLS_PATH,
        "my-core",
        skillFile("my-core", "Core only."),
      );

      await expect(listAvailableSkills(config)).resolves.toEqual([
        { name: "my-core", description: "Core only." },
      ]);
    });

    it("merges the synced skills with the core skills, sorted by name", async () => {
      config.AGENT_CONFIG_REPOSITORY = "https://github.com/acme/agent-config.git";
      await writeSkill(
        config.CORE_SKILLS_PATH,
        "my-core",
        skillFile("my-core", "Core only."),
      );
      await fse.outputFile(
        path.join(dataDir, "agent-config", "skills", "my-synced", "SKILL.md"),
        skillFile("my-synced", "Synced only."),
      );

      await expect(listAvailableSkills(config)).resolves.toEqual([
        { name: "my-core", description: "Core only." },
        { name: "my-synced", description: "Synced only." },
      ]);
    });

    it("lets a synced skill override the core skill with the same name", async () => {
      config.AGENT_CONFIG_REPOSITORY = "https://github.com/acme/agent-config.git";
      await writeSkill(
        config.CORE_SKILLS_PATH,
        "shared",
        skillFile("shared", "Core description."),
      );
      await fse.outputFile(
        path.join(dataDir, "agent-config", "skills", "shared", "SKILL.md"),
        skillFile("shared", "Synced description."),
      );

      await expect(listAvailableSkills(config)).resolves.toEqual([
        { name: "shared", description: "Synced description." },
      ]);
    });
  });
});
