import { PlannerClient } from "./PlannerClient";
import { Config } from "./Config";

jest.mock("./OTelContext", () => ({
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
        attachments: [],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "test-api-key" }),
      }),
    );
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
      },
    ]);
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
          { id: "p1", name: "Agent Workspace", other: "ignored" },
          { id: "p2", name: "Personal" },
        ]),
        { status: 200 },
      ),
    );

    const client = new PlannerClient(config);
    const projects = await client.listProjects();

    expect(projects).toEqual([
      { id: "p1", name: "Agent Workspace" },
      { id: "p2", name: "Personal" },
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
});
