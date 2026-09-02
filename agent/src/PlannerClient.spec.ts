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
            title: "Fix the build",
            status: "In Progress",
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
      { id: "task-1", title: "Fix the build", status: "In Progress" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://planner.test:8080/api/tasks",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "test-api-key" }),
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
});
