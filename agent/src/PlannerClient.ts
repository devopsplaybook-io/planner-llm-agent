import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Config } from "./Config";
import { OTelTracer } from "./OTelContext";

const REQUEST_TIMEOUT_MS = 30000;

type PlannerSpan = ReturnType<StandardTracer["startSpan"]>;

export interface PlannerUser {
  id: string;
  name: string;
}

export interface PlannerTask {
  id: string;
  title: string;
  status: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlannerTaskJson = any;

export class PlannerClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  public async getCurrentUser(): Promise<PlannerUser> {
    const span = OTelTracer().startSpan("planner-client.get-current-user");
    try {
      const body = await this.request("/api/users/session", "POST", span);
      const user = body?.user;
      if (!user?.id || !user?.name) {
        throw new Error(
          "Planner session response is missing user information",
        );
      }
      return { id: user.id as string, name: user.name as string };
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async listAssignedTasks(user: PlannerUser): Promise<PlannerTask[]> {
    const span = OTelTracer().startSpan("planner-client.list-assigned-tasks");
    try {
      const body = await this.request("/api/tasks", "GET", span);
      if (!Array.isArray(body)) {
        throw new Error("Planner tasks response is not a list");
      }
      const tasks = body as PlannerTaskJson[];
      return tasks
        .filter(
          (task) =>
            Array.isArray(task?.assignees) &&
            task.assignees.some(
              (assignee: PlannerTaskJson) => assignee?.userId === user.id,
            ),
        )
        .map((task) => ({
          id: String(task.id),
          title: String(task.title),
          status: String(task.status),
        }));
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async request(
    path: string,
    method: string,
    span: PlannerSpan,
  ): Promise<PlannerTaskJson> {
    const url = `${this.config.PLANNER_URL}${path}`;
    const headers: Record<string, string> = {
      "x-api-key": this.config.PLANNER_API_KEY,
    };
    StandardTracer.updateHttpHeader(span, headers);
    let response: Response;
    try {
      response = await fetch(url, {
        method: method,
        headers: headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Failed to reach Planner at '${url}': ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(
        `Planner request to '${path}' failed with status ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(
        `Planner request to '${path}' returned an invalid JSON response`,
        { cause: error },
      );
    }
  }
}
