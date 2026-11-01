import {
  AttachmentTooLargeError,
  PlannerClient,
  PlannerRequestError,
  PLANNER_REFERENCE_TTL_MS,
} from "./PlannerClient";
import { Config } from "./Config";

jest.mock("./OTelContext", () => ({
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
  OTelTracer: jest.fn(() => ({
    startSpan: jest.fn(() => ({
      end: jest.fn(),
      setAttribute: jest.fn(),
      recordException: jest.fn(),
    })),
  })),
}));

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: Object.assign(jest.fn(), {
    updateHttpHeader: jest.fn((_span: unknown, headers: unknown) => headers),
  }),
}));

describe("PlannerClient", () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  let config: Config;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    delete process.env.PLANNER_URL;
    delete process.env.PLANNER_API_KEY;
    config = new Config();
    config.PLANNER_URL = "http://planner.test:8080";
    config.PLANNER_API_KEY = "test-api-key";

    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("should return the current user from the Planner session", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          token: "jwt-token",
          user: { id: "user-1", name: "Didier", role: "admin" },
        }),
        { status: 201 },
      ),
    );

    const client = new PlannerClient(config);
    const user = await client.getCurrentUser();

    expect(user).toEqual({ id: "user-1", name: "Didier" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/users/session",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "test-api-key" }),
      }),
    );
  });

  it("should throw a clear error when authentication fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Access Denied" }), {
        status: 403,
      }),
    );

    const client = new PlannerClient(config);
    await expect(client.getCurrentUser()).rejects.toThrow(
      "Planner request to '/api/users/session' failed with status 403",
    );
  });

  it("should list only tasks assigned to the given user", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "task-1",
            projectId: "p1",
            title: "Fix the build",
            status: "In Progress",
            description: "The build is broken",
            comments: [
              {
                id: "comment-1",
                userId: "user-2",
                userName: "Alice",
                text: "Please add tests",
                dateCreated: "2026-09-02T00:00:00.000Z",
              },
            ],
            assignees: [{ userId: "user-1" }],
          },
          {
            id: "task-2",
            title: "Other user task",
            status: "To Do",
            assignees: [{ userId: "user-2" }],
          },
          {
            id: "task-3",
            title: "Unassigned task",
            status: "To Do",
            assignees: [],
          },
        ]),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const tasks = await client.listAssignedTasks({
      id: "user-1",
      name: "Didier",
    });

    expect(tasks).toEqual([
      {
        id: "task-1",
        projectId: "p1",
        title: "Fix the build",
        status: "In Progress",
        priority: "medium",
        description: "The build is broken",
        dateUpdated: "",
        comments: [
          {
            id: "comment-1",
            userId: "user-2",
            userName: "Alice",
            text: "Please add tests",
            dateCreated: "2026-09-02T00:00:00.000Z",
          },
        ],
        attachments: [],
        labels: [],
        dependencies: [],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks?assigneeUserId=user-1&fields=id,projectId,title,description,status,priority,assignees,comments,attachments,labels,dependencies,dateCreated,dateUpdated",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "test-api-key" }),
      }),
    );
  });

  it("should scope the task fetch to the given project ids", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const client = new PlannerClient(config);
    await client.listAssignedTasks({ id: "user-1", name: "Didier" }, [
      "p1",
      "p2",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks?assigneeUserId=user-1&fields=id,projectId,title,description,status,priority,assignees,comments,attachments,labels,dependencies,dateCreated,dateUpdated&projectIds=p1%2Cp2",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "test-api-key" }),
      }),
    );
  });

  it("should scope the task fetch to the given label names", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const client = new PlannerClient(config);
    await client.listAssignedTasks({ id: "user-1", name: "Didier" }, undefined, [
      "agent:running",
    ]);

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("labels=agent%3Arunning");
  });

  it("should request every field the agent pipeline relies on", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const client = new PlannerClient(config);
    await client.listAssignedTasks({ id: "user-1", name: "Didier" });

    const url = fetchMock.mock.calls[0]![0] as string;
    const fields = new URLSearchParams(url).get("fields") ?? "";
    for (const required of [
      "id",
      "projectId",
      "title",
      "description",
      "status",
      "priority",
      "assignees",
      "comments",
      "attachments",
      "labels",
      "dependencies",
      "dateCreated",
      "dateUpdated",
    ]) {
      expect(fields.split(",")).toContain(required);
    }
    expect(fetchMock.mock.calls[0]![0] as string).toContain(
      "assigneeUserId=user-1",
    );
  });

  it("should map the task priority and last update date", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "task-1",
            title: "Fix the build",
            status: "To Do",
            priority: "high",
            description: "The build is broken",
            dateUpdated: "2026-09-10T12:00:00.000Z",
            comments: [],
            assignees: [{ userId: "user-1" }],
          },
        ]),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const tasks = await client.listAssignedTasks({
      id: "user-1",
      name: "Didier",
    });

    expect(tasks).toEqual([
      {
        id: "task-1",
        projectId: "",
        title: "Fix the build",
        status: "To Do",
        priority: "high",
        description: "The build is broken",
        dateUpdated: "2026-09-10T12:00:00.000Z",
        comments: [],
        attachments: [],
        labels: [],
        dependencies: [],
      },
    ]);
  });

  it("should map task dependencies with their current title and status", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "task-1",
            title: "Follow-up work",
            status: "To Do",
            comments: [],
            assignees: [{ userId: "user-1" }],
            dependencies: [
              {
                taskId: "task-2",
                title: "First step",
                status: "Done",
              },
              {
                taskId: "task-3",
              },
            ],
          },
        ]),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const tasks = await client.listAssignedTasks({
      id: "user-1",
      name: "Didier",
    });

    expect(tasks[0]!.dependencies).toEqual([
      { taskId: "task-2", title: "First step", status: "Done" },
      { taskId: "task-3", title: undefined, status: undefined },
    ]);
  });

  it("should map task attachments", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "task-1",
            title: "Fix the build",
            status: "In Progress",
            description: "The build is broken",
            comments: [],
            attachments: [
              {
                id: "attachment-1",
                fileName: "screenshot.png",
                filePath: "/uploads/screenshot.png",
                dateCreated: "2026-09-02T00:00:00.000Z",
              },
            ],
            assignees: [{ userId: "user-1" }],
          },
        ]),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const tasks = await client.listAssignedTasks({
      id: "user-1",
      name: "Didier",
    });

    expect(tasks).toEqual([
      {
        id: "task-1",
        projectId: "",
        title: "Fix the build",
        status: "In Progress",
        priority: "medium",
        description: "The build is broken",
        dateUpdated: "",
        comments: [],
        attachments: [
          {
            id: "attachment-1",
            fileName: "screenshot.png",
            filePath: "/uploads/screenshot.png",
            dateCreated: "2026-09-02T00:00:00.000Z",
          },
        ],
        labels: [],
        dependencies: [],
      },
    ]);
  });

  it("should fetch a single task with its full shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "task-1",
          projectId: "p1",
          title: "Fix the build",
          status: "In Progress",
          priority: "high",
          description: "The build is broken",
          dateUpdated: "2026-09-10T12:00:00.000Z",
          comments: [
            {
              id: "comment-1",
              userId: "user-2",
              userName: "Alice",
              text: "Please add tests",
              dateCreated: "2026-09-02T00:00:00.000Z",
            },
          ],
          attachments: [
            {
              id: "attachment-1",
              fileName: "screenshot.png",
              filePath: "/uploads/screenshot.png",
              dateCreated: "2026-09-02T00:00:00.000Z",
            },
          ],
          labels: ["urgent", "model:qwen3.8-flash"],
          dependencies: [
            { taskId: "task-2", title: "First step", status: "Done" },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const task = await client.getTask("task-1");

    expect(task).toEqual({
      id: "task-1",
      projectId: "p1",
      title: "Fix the build",
      status: "In Progress",
      priority: "high",
      description: "The build is broken",
      dateUpdated: "2026-09-10T12:00:00.000Z",
      comments: [
        {
          id: "comment-1",
          userId: "user-2",
          userName: "Alice",
          text: "Please add tests",
          dateCreated: "2026-09-02T00:00:00.000Z",
        },
      ],
      attachments: [
        {
          id: "attachment-1",
          fileName: "screenshot.png",
          filePath: "/uploads/screenshot.png",
          dateCreated: "2026-09-02T00:00:00.000Z",
        },
      ],
      labels: ["urgent", "model:qwen3.8-flash"],
      dependencies: [
        { taskId: "task-2", title: "First step", status: "Done" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks/task-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "test-api-key" }),
      }),
    );
  });

  it("should apply the missing-field defaults when fetching a single task", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ id: "task-1", title: "Minimal", status: "To Do" }),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const task = await client.getTask("task-1");

    expect(task).toEqual({
      id: "task-1",
      projectId: "",
      title: "Minimal",
      status: "To Do",
      priority: "medium",
      description: "",
      dateUpdated: "",
      comments: [],
      attachments: [],
      labels: [],
      dependencies: [],
    });
  });

  it("should throw a clear error when fetching a missing task", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );

    const client = new PlannerClient(config);
    await expect(client.getTask("task-1")).rejects.toThrow(
      "Planner request to '/api/tasks/task-1' failed with status 404",
    );
  });

  it("should report the HTTP status on request failures", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );

    const client = new PlannerClient(config);
    await expect(client.getTask("task-1")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("should throw a clear error when the single-task response is invalid", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 200 }),
    );

    const client = new PlannerClient(config);
    await expect(client.getTask("task-1")).rejects.toThrow(
      "Planner task response is missing the task id",
    );
  });

  it("should download a task attachment", async () => {
    fetchMock.mockResolvedValue(
      new Response(Buffer.from("file-content"), { status: 200 }),
    );

    const client = new PlannerClient(config);
    const data = await client.downloadTaskAttachment("task-1", "attachment-1");

    expect(data.toString()).toBe("file-content");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks/task-1/attachments/attachment-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "test-api-key" }),
      }),
    );
  });

  it("should throw a clear error when an attachment download fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );

    const client = new PlannerClient(config);
    await expect(
      client.downloadTaskAttachment("task-1", "attachment-1"),
    ).rejects.toThrow(
      "Planner request to '/api/tasks/task-1/attachments/attachment-1' failed with status 404",
    );
  });

  it("should reject an attachment declared above the size cap without reading the body", async () => {
    config.TASK_ATTACHMENT_MAX_BYTES = 10;
    const pull = jest.fn();
    const body = new ReadableStream({
      pull(controller) {
        pull();
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-length": "100" },
      }),
    );

    const client = new PlannerClient(config);
    await expect(
      client.downloadTaskAttachment("task-1", "attachment-1"),
    ).rejects.toMatchObject({ limit: 10, size: 100 });
    // The declared size is enough to reject: the body is not consumed (a
    // ReadableStream may pull once eagerly into its internal queue).
    expect(pull.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("should abort a chunked attachment body above the size cap", async () => {
    config.TASK_ATTACHMENT_MAX_BYTES = 10;
    const cancel = jest.fn();
    let chunk = 0;
    const body = new ReadableStream({
      pull(controller) {
        chunk += 1;
        if (chunk > 5) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
      },
      cancel() {
        cancel();
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const client = new PlannerClient(config);
    await expect(
      client.downloadTaskAttachment("task-1", "attachment-1"),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    // The reader stopped pulling after the cap was crossed.
    expect(chunk).toBeLessThan(5);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("should enforce the size cap when the response has no content-length", async () => {
    config.TASK_ATTACHMENT_MAX_BYTES = 10;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const client = new PlannerClient(config);
    await expect(
      client.downloadTaskAttachment("task-1", "attachment-1"),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
  });

  it("should accept an oversized attachment when the cap is disabled", async () => {
    // 0 disables the cap: a body above the 50 MiB default is accepted.
    config.TASK_ATTACHMENT_MAX_BYTES = 0;
    const payload = Buffer.alloc(50 * 1024 * 1024 + 1, 7);
    fetchMock.mockResolvedValue(new Response(payload, { status: 200 }));

    const client = new PlannerClient(config);
    const data = await client.downloadTaskAttachment("task-1", "attachment-1");
    expect(data.length).toBe(payload.length);
  });

  it("should add a comment to a task", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "comment-1" }), { status: 201 }),
    );

    const client = new PlannerClient(config);
    await client.addTaskComment("task-1", "Feature implemented");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks/task-1/comments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-api-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ text: "Feature implemented" }),
      }),
    );
  });

  it("should update a task status", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "task-1" }), { status: 201 }),
    );

    const client = new PlannerClient(config);
    await client.updateTaskStatus("task-1", "Done");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks/task-1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "x-api-key": "test-api-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ status: "Done" }),
      }),
    );
  });

  it("should replace the labels of a task", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 201 }),
    );

    const client = new PlannerClient(config);
    await client.updateTaskLabels("task-1", [
      "urgent",
      "agent:running",
      "model:deepseek-flash",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks/task-1/labels",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-api-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          labels: ["urgent", "agent:running", "model:deepseek-flash"],
        }),
      }),
    );
  });

  it("should mutate the labels of a task atomically", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ labels: ["urgent", "agent:running"], changed: true }),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const result = await client.mutateTaskLabels("task-1", {
      add: ["agent:running"],
      remove: ["stale"],
      quiet: true,
    });

    expect(result).toEqual({
      labels: ["urgent", "agent:running"],
      changed: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks/task-1/labels",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "x-api-key": "test-api-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          add: ["agent:running"],
          remove: ["stale"],
          quiet: true,
        }),
      }),
    );
  });

  it("should reject an invalid label mutation response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const client = new PlannerClient(config);
    await expect(
      client.mutateTaskLabels("task-1", { add: ["agent:running"] }),
    ).rejects.toThrow(
      "Planner label mutation response is missing labels/changed",
    );
  });

  it("should throw a clear error when the Planner is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const client = new PlannerClient(config);
    await expect(client.getCurrentUser()).rejects.toThrow(
      "Failed to reach Planner at 'http://planner.test:8080/api/users/session'",
    );
  });

  it("should list the visible projects", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "p1",
            name: "Agent Workspace",
            description: "Workspace description",
            other: "ignored",
          },
          { id: "p2", name: "Personal" },
        ]),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const projects = await client.listProjects();

    expect(projects).toEqual([
      {
        id: "p1",
        name: "Agent Workspace",
        description: "Workspace description",
      },
      { id: "p2", name: "Personal", description: "" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/projects",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("should list the notes of a project", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "note-1",
            projectId: "p1",
            title: "agent",
            description: "note content",
          },
          { id: "note-2", projectId: "p1", title: "no description" },
        ]),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const notes = await client.listNotes("p1");

    expect(notes).toEqual([
      {
        id: "note-1",
        projectId: "p1",
        title: "agent",
        description: "note content",
      },
      {
        id: "note-2",
        projectId: "p1",
        title: "no description",
        description: "",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/notes?projectId=p1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("should create a note in a project", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "note-1",
          projectId: "p1",
          title: "agent",
          description: "note content",
        }),
        { status: 201 },
      ),
    );

    const client = new PlannerClient(config);
    const note = await client.createNote("p1", "agent", "note content");

    expect(note).toEqual({
      id: "note-1",
      projectId: "p1",
      title: "agent",
      description: "note content",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/notes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId: "p1",
          title: "agent",
          description: "note content",
        }),
      }),
    );
  });

  it("should throw a clear error when the note creation response is invalid", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 200 }),
    );

    const client = new PlannerClient(config);
    await expect(client.createNote("p1", "agent", "content")).rejects.toThrow(
      "Planner note creation response is missing the note id",
    );
  });

  it("should update the description of an existing note", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "note-1" }), { status: 200 }),
    );

    const client = new PlannerClient(config);
    await client.updateNote("note-1", "updated content");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/notes/note-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ description: "updated content" }),
      }),
    );
  });

  it("should update the title and description of an existing note", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "note-1" }), { status: 200 }),
    );

    const client = new PlannerClient(config);
    await client.updateNote("note-1", "updated content", "New title");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/notes/note-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          description: "updated content",
          title: "New title",
        }),
      }),
    );
  });

  describe("reference data cache", () => {
    const noRetry = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

    const userResponse = (id: string, name: string): Response =>
      new Response(JSON.stringify({ success: true, user: { id, name } }), {
        status: 201,
      });

    const projectsResponse = (name: string): Response =>
      new Response(JSON.stringify([{ id: "p1", name }]), { status: 200 });

    it("fetches the current user once within the TTL", async () => {
      fetchMock.mockResolvedValue(userResponse("user-1", "Didier"));

      const client = new PlannerClient(config);
      const first = await client.getCurrentUser();
      const second = await client.getCurrentUser();

      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refreshes the current user after the TTL", async () => {
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        fetchMock
          .mockResolvedValueOnce(userResponse("user-1", "Didier"))
          .mockResolvedValueOnce(userResponse("user-2", "New Name"));

        const client = new PlannerClient(config);
        await expect(client.getCurrentUser()).resolves.toEqual({
          id: "user-1",
          name: "Didier",
        });

        nowSpy.mockReturnValue(1_000_000 + PLANNER_REFERENCE_TTL_MS);
        await expect(client.getCurrentUser()).resolves.toEqual({
          id: "user-2",
          name: "New Name",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("caches the project catalog for the TTL and refreshes it after", async () => {
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        fetchMock
          .mockResolvedValueOnce(projectsResponse("Project A"))
          .mockResolvedValueOnce(projectsResponse("Project A renamed"));

        const client = new PlannerClient(config);
        const expected = [
          { id: "p1", name: "Project A", description: "" },
        ];
        await expect(client.listProjects()).resolves.toEqual(expected);
        await expect(client.listProjects()).resolves.toEqual(expected);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        nowSpy.mockReturnValue(1_000_000 + PLANNER_REFERENCE_TTL_MS);
        await expect(client.listProjects()).resolves.toEqual([
          { id: "p1", name: "Project A renamed", description: "" },
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("does not cache a failed user fetch", async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Access Denied" }), {
            status: 403,
          }),
        )
        .mockResolvedValueOnce(userResponse("user-1", "Didier"));

      const client = new PlannerClient(config, noRetry);
      await expect(client.getCurrentUser()).rejects.toThrow("status 403");
      await expect(client.getCurrentUser()).resolves.toEqual({
        id: "user-1",
        name: "Didier",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failed project fetch", async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
        )
        .mockResolvedValueOnce(projectsResponse("Project A"));

      const client = new PlannerClient(config, noRetry);
      await expect(client.listProjects()).rejects.toThrow("status 500");
      await expect(client.listProjects()).resolves.toEqual([
        { id: "p1", name: "Project A", description: "" },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("single-flights concurrent user fetches", async () => {
      let resolveFetch!: (response: Response) => void;
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const client = new PlannerClient(config);
      const first = client.getCurrentUser();
      const second = client.getCurrentUser();
      resolveFetch(userResponse("user-1", "Didier"));

      await expect(Promise.all([first, second])).resolves.toEqual([
        { id: "user-1", name: "Didier" },
        { id: "user-1", name: "Didier" },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("single-flights concurrent project fetches", async () => {
      let resolveFetch!: (response: Response) => void;
      fetchMock.mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const client = new PlannerClient(config);
      const first = client.listProjects();
      const second = client.listProjects();
      resolveFetch(projectsResponse("Project A"));

      await expect(Promise.all([first, second])).resolves.toEqual([
        [{ id: "p1", name: "Project A", description: "" }],
        [{ id: "p1", name: "Project A", description: "" }],
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries instead of reusing a rejected in-flight fetch", async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Access Denied" }), {
            status: 403,
          }),
        )
        .mockResolvedValueOnce(userResponse("user-1", "Didier"));

      const client = new PlannerClient(config, noRetry);
      const first = client.getCurrentUser();
      const second = client.getCurrentUser();

      await expect(Promise.allSettled([first, second])).resolves.toEqual([
        { status: "rejected", reason: expect.any(Error) },
        { status: "rejected", reason: expect.any(Error) },
      ]);
      await expect(client.getCurrentUser()).resolves.toEqual({
        id: "user-1",
        name: "Didier",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("shares the per-poll reference fetches within the TTL", async () => {
      fetchMock.mockImplementation(async (url: string) =>
        String(url).endsWith("/api/users/session")
          ? userResponse("user-1", "Didier")
          : projectsResponse("Project A"),
      );

      const client = new PlannerClient(config);
      for (let poll = 0; poll < 2; poll++) {
        await client.getCurrentUser();
        await client.listProjects();
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // Retry policy tests: no delay is injected, the policy itself is what is
  // being tested.
  const retryOptions = { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

  it("should retry an idempotent GET after a 5xx and then succeed", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "boom" }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "task-1", title: "T" }), {
          status: 200,
        }),
      );

    const client = new PlannerClient(config, retryOptions);
    const task = await client.getTask("task-1");

    expect(task.id).toBe("task-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should retry an idempotent GET after a 429 and then succeed", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "slow down" }), { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "task-1", title: "T" }), {
          status: 200,
        }),
      );

    const client = new PlannerClient(config, retryOptions);
    const task = await client.getTask("task-1");

    expect(task.id).toBe("task-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should retry an idempotent GET after a network error and then succeed", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "task-1", title: "T" }), {
          status: 200,
        }),
      );

    const client = new PlannerClient(config, retryOptions);
    const task = await client.getTask("task-1");

    expect(task.id).toBe("task-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("should not retry a 404 GET", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );

    const client = new PlannerClient(config, retryOptions);
    await expect(client.getTask("task-1")).rejects.toMatchObject({
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should not retry a 400 GET", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Bad request" }), { status: 400 }),
    );

    const client = new PlannerClient(config, retryOptions);
    await expect(client.getTask("task-1")).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should not retry a write even on a 5xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    const client = new PlannerClient(config, retryOptions);
    await expect(client.addTaskComment("task-1", "summary")).rejects.toMatchObject(
      { status: 500 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should throw after the configured attempts are exhausted", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "Service unavailable" }), {
          status: 503,
        }),
    );

    const client = new PlannerClient(config, retryOptions);
    await expect(client.getTask("task-1")).rejects.toThrow(
      "failed with status 503: ",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("should include the truncated response body in the error", async () => {
    const longBody = `failure ${"x".repeat(1000)}`;
    // A fresh response per attempt (a retried body is cancelled).
    fetchMock.mockImplementation(
      async () => new Response(longBody, { status: 500 }),
    );

    const client = new PlannerClient(config, retryOptions);
    const error = await client.getTask("task-1").catch((caught) => caught);

    expect(error).toBeInstanceOf(PlannerRequestError);
    expect(error.status).toBe(500);
    expect(error.body).toHaveLength(500);
    expect(error.message).toContain(longBody.slice(0, 500));
    expect(error.message).not.toContain("x".repeat(501));
  });

  it("should retry the initial fetch of an attachment download", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "boom" }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("file-content"), { status: 200 }),
      );

    const client = new PlannerClient(config, retryOptions);
    const data = await client.downloadTaskAttachment("task-1", "attachment-1");

    expect(data.toString()).toBe("file-content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
