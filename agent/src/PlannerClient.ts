import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Config } from "./Config";
import { OTelTracer } from "./OTelContext";

const REQUEST_TIMEOUT_MS = 30000;

// Reference data (the agent's own user and the visible project catalog) is
// cached for this long: a project added or renamed becomes visible within at
// most 60 s, i.e. at the next poll after the cache expires. Failed fetches
// are never cached and are retried on the next call; concurrent callers share
// a single in-flight request.
export const PLANNER_REFERENCE_TTL_MS = 60_000;

// Conservative, centralised retry policy for idempotent (GET) requests. A
// transient network error, timeout, 429 or 5xx is retried with a full-jitter
// exponential backoff; plain 4xx and every write (POST/PUT/PATCH) are never
// retried here (the finalization retry loop handles the writes idempotently).
const REQUEST_RETRY_ATTEMPTS = 3;
const REQUEST_RETRY_BASE_DELAY_MS = 250;
const REQUEST_RETRY_MAX_DELAY_MS = 2000;
const REQUEST_RETRY_TOTAL_BUDGET_MS = 90_000;
// The response body of a failed request is included (truncated) in the
// error: it usually explains the failure in the logs.
const REQUEST_ERROR_BODY_MAX_CHARS = 500;

type PlannerSpan = ReturnType<StandardTracer["startSpan"]>;

// Retry policy overrides (tests inject zero delays).
export interface PlannerRetryOptions {
  // Total attempts of an idempotent request (writes stay single-attempt).
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  totalBudgetMs?: number;
}

// Failed Planner HTTP request: the status lets callers distinguish a
// missing/unsupported endpoint (404/405, e.g. an older Planner without the
// atomic label mutation) from an operational failure. The truncated response
// body, when any, is carried for diagnostics.
export class PlannerRequestError extends Error {
  public readonly status: number;
  public readonly body?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "PlannerRequestError";
    this.status = status;
    this.body = body;
  }
}

// An attachment larger than the configured cap: the download is aborted
// without buffering the whole body, and the caller skips the attachment.
export class AttachmentTooLargeError extends Error {
  public readonly limit: number;
  // Declared (content-length) or observed size in bytes when known.
  public readonly size: number | null;

  constructor(limit: number, size: number | null) {
    super(
      size !== null
        ? `Attachment exceeds the maximum size of ${limit} bytes (${size} bytes)`
        : `Attachment exceeds the maximum size of ${limit} bytes`,
    );
    this.name = "AttachmentTooLargeError";
    this.limit = limit;
    this.size = size;
  }
}

export interface PlannerUser {
  id: string;
  name: string;
}

export interface PlannerTaskComment {
  id: string;
  userId: string;
  userName?: string;
  text: string;
  dateCreated: string;
}

export interface PlannerTaskAttachment {
  id: string;
  fileName: string;
  filePath: string;
  dateCreated: string;
}

export interface PlannerTaskDependency {
  taskId: string;
  title?: string;
  status?: string;
}

export interface PlannerTask {
  id: string;
  projectId: string;
  title: string;
  status: string;
  priority: string;
  description: string;
  dateUpdated: string;
  comments: PlannerTaskComment[];
  attachments: PlannerTaskAttachment[];
  // Optional for the same reason as dependencies: consumers also tolerate
  // the unmapped task shapes (tests, older servers without label support).
  labels?: string[];
  // Hydrated when the poll requests the dependencies field; optional so the
  // consumers also tolerate the unmapped task shapes (tests, older servers).
  dependencies?: PlannerTaskDependency[];
}

export interface PlannerProject {
  id: string;
  name: string;
  description: string;
  // Status catalog of the project, when the server reports one (older
  // deploys omit it): used to degrade gracefully when a configured status
  // (e.g. status_in_progress) does not exist in the project.
  statuses?: string[];
}

export interface PlannerNote {
  id: string;
  projectId: string;
  title: string;
  description: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlannerTaskJson = any;

/**
 * Sparse fieldsets requested for the poll: every field the pipeline needs
 * (scheduling directives, evaluation prompt, session documents, dependency
 * gating, agent-managed labels) and only the ones it needs — checklist and
 * dueDate are dropped because the PlannerTask mapping discards them anyway.
 * The full default shape is still safe: the server only omits keys when
 * fields is sent.
 */
const AGENT_TASK_FIELDS =
  "id,projectId,title,description,status,priority,assignees,comments,attachments,labels,dependencies,dateCreated,dateUpdated";

export class PlannerClient {
  private config: Config;
  private retryAttempts: number;
  private retryBaseDelayMs: number;
  private retryMaxDelayMs: number;
  private retryTotalBudgetMs: number;
  private currentUserCache: { user: PlannerUser; expiresAt: number } | null =
    null;
  private currentUserInFlight: Promise<PlannerUser> | null = null;
  private projectsCache: {
    projects: PlannerProject[];
    expiresAt: number;
  } | null = null;
  private projectsInFlight: Promise<PlannerProject[]> | null = null;

  constructor(config: Config, retryOptions?: PlannerRetryOptions) {
    this.config = config;
    this.retryAttempts = retryOptions?.attempts ?? REQUEST_RETRY_ATTEMPTS;
    this.retryBaseDelayMs =
      retryOptions?.baseDelayMs ?? REQUEST_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs =
      retryOptions?.maxDelayMs ?? REQUEST_RETRY_MAX_DELAY_MS;
    this.retryTotalBudgetMs =
      retryOptions?.totalBudgetMs ?? REQUEST_RETRY_TOTAL_BUDGET_MS;
  }

  public async getCurrentUser(): Promise<PlannerUser> {
    const cached = this.currentUserCache;
    if (cached !== null && Date.now() < cached.expiresAt) {
      return cached.user;
    }
    let inFlight = this.currentUserInFlight;
    if (inFlight === null) {
      inFlight = this.fetchCurrentUser().then((user) => {
        this.currentUserCache = {
          user,
          expiresAt: Date.now() + PLANNER_REFERENCE_TTL_MS,
        };
        return user;
      });
      this.currentUserInFlight = inFlight;
      const settle = () => {
        if (this.currentUserInFlight === inFlight) {
          this.currentUserInFlight = null;
        }
      };
      inFlight.then(settle, settle);
    }
    return inFlight;
  }

  private async fetchCurrentUser(): Promise<PlannerUser> {
    const span = OTelTracer().startSpan("planner-client.get-current-user");
    try {
      const body = await this.request("/api/users/session", "POST", span);
      const user = body?.user;
      if (!user?.id || !user?.name) {
        throw new Error("Planner session response is missing user information");
      }
      return { id: user.id as string, name: user.name as string };
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  // The poll is scoped server-side through the 'assigneeUserId' filter (all
  // statuses, composing with 'projectIds') and slimmed through the
  // 'fields' sparse fieldsets. The client-side assignee filter below is
  // kept as a safety net: against a server that ignores 'assigneeUserId'
  // (older deploy), a filter-less poll would hand the agent every
  // human-assigned task in scope. 'labels' (optional) adds the server-side
  // AND label filter used by the running-label reconciliation.
  public async listAssignedTasks(
    user: PlannerUser,
    projectIds?: string[],
    labels?: string[],
  ): Promise<PlannerTask[]> {
    const span = OTelTracer().startSpan("planner-client.list-assigned-tasks");
    try {
      let path = `/api/tasks?assigneeUserId=${encodeURIComponent(user.id)}&fields=${AGENT_TASK_FIELDS}`;
      if (projectIds && projectIds.length > 0) {
        path += `&projectIds=${encodeURIComponent(projectIds.join(","))}`;
      }
      if (labels && labels.length > 0) {
        path += `&labels=${encodeURIComponent(labels.join(","))}`;
      }
      const body = await this.request(path, "GET", span);
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
        .map((task) => this.mapTask(task));
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  // Maps a raw Planner task JSON to the PlannerTask shape, applying the
  // missing-field defaults (medium priority, empty strings, empty lists)
  // shared by the list and single-task fetches.
  private mapTask(task: PlannerTaskJson): PlannerTask {
    return {
      id: String(task.id),
      projectId: String(task.projectId ?? ""),
      title: String(task.title),
      status: String(task.status),
      priority:
        task.priority === undefined || task.priority === null
          ? "medium"
          : String(task.priority),
      description:
        task.description === undefined || task.description === null
          ? ""
          : String(task.description),
      dateUpdated:
        task.dateUpdated === undefined || task.dateUpdated === null
          ? ""
          : String(task.dateUpdated),
      comments: Array.isArray(task.comments)
        ? task.comments.map(
            (comment: PlannerTaskJson): PlannerTaskComment => ({
              id: String(comment.id),
              userId: String(comment.userId),
              userName: comment.userName
                ? String(comment.userName)
                : undefined,
              text: String(comment.text),
              dateCreated: String(comment.dateCreated),
            }),
          )
        : [],
      attachments: Array.isArray(task.attachments)
        ? task.attachments.map(
            (attachment: PlannerTaskJson): PlannerTaskAttachment => ({
              id: String(attachment.id),
              fileName: String(attachment.fileName),
              filePath: String(attachment.filePath),
              dateCreated: String(attachment.dateCreated),
            }),
          )
        : [],
      labels: Array.isArray(task.labels)
        ? task.labels.map((label: unknown) => String(label))
        : [],
      dependencies: Array.isArray(task.dependencies)
        ? task.dependencies.map(
            (dependency: PlannerTaskJson): PlannerTaskDependency => ({
              taskId: String(dependency.taskId),
              title: dependency.title ? String(dependency.title) : undefined,
              status: dependency.status
                ? String(dependency.status)
                : undefined,
            }),
          )
        : [],
    };
  }

  public async getTask(taskId: string): Promise<PlannerTask> {
    const span = OTelTracer().startSpan("planner-client.get-task");
    try {
      const body = await this.request(`/api/tasks/${taskId}`, "GET", span);
      if (!body?.id) {
        throw new Error("Planner task response is missing the task id");
      }
      return this.mapTask(body);
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async addTaskComment(taskId: string, text: string): Promise<void> {
    const span = OTelTracer().startSpan("planner-client.add-task-comment");
    try {
      await this.request(`/api/tasks/${taskId}/comments`, "POST", span, {
        text: text,
      });
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async updateTaskStatus(taskId: string, status: string): Promise<void> {
    const span = OTelTracer().startSpan("planner-client.update-task-status");
    try {
      await this.request(`/api/tasks/${taskId}`, "PUT", span, {
        status: status,
      });
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  // Atomic label mutation: the server applies the add/remove sets itself
  // (no read-merge-write race) and reports the resulting labels and whether
  // anything changed. quiet skips the server-side "Labels updated" feed
  // entry and the assignee notification while still bumping dateUpdated.
  public async mutateTaskLabels(
    taskId: string,
    mutation: { add?: string[]; remove?: string[]; quiet?: boolean },
  ): Promise<{ labels: string[]; changed: boolean }> {
    const span = OTelTracer().startSpan("planner-client.mutate-task-labels");
    try {
      const body = await this.request(
        `/api/tasks/${taskId}/labels`,
        "PATCH",
        span,
        mutation,
      );
      if (!Array.isArray(body?.labels) || typeof body?.changed !== "boolean") {
        throw new Error(
          "Planner label mutation response is missing labels/changed",
        );
      }
      return {
        labels: body.labels.map((label: unknown) => String(label)),
        changed: body.changed,
      };
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  // Replaces the whole label list of a task (legacy whole-list write), kept
  // as the fallback for Planner servers without the atomic label mutation
  // endpoint. Also bumps the task dateUpdated and records a "Labels updated"
  // feed entry server-side.
  public async updateTaskLabels(
    taskId: string,
    labels: string[],
  ): Promise<void> {
    const span = OTelTracer().startSpan("planner-client.update-task-labels");
    try {
      await this.request(`/api/tasks/${taskId}/labels`, "POST", span, {
        labels: labels,
      });
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async downloadTaskAttachment(
    taskId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    const span = OTelTracer().startSpan(
      "planner-client.download-task-attachment",
    );
    try {
      const path = `/api/tasks/${taskId}/attachments/${attachmentId}`;
      // The initial fetch is idempotent: a transient failure is retried
      // before the (much larger) body is read.
      const response = await this.fetchResponse(path, "GET", span);
      // Read the cap at call time so a hot-reloaded value applies; 0 (or an
      // invalid value) disables it.
      const configuredLimit = this.config.TASK_ATTACHMENT_MAX_BYTES;
      const limit =
        Number.isInteger(configuredLimit) && configuredLimit > 0
          ? configuredLimit
          : 0;
      const declared = Number.parseInt(
        response.headers.get("content-length") ?? "",
        10,
      );
      if (limit > 0 && Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw new AttachmentTooLargeError(limit, declared);
      }
      const body = response.body;
      if (body === null) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (limit > 0 && buffer.length > limit) {
          throw new AttachmentTooLargeError(limit, buffer.length);
        }
        return buffer;
      }
      const reader = body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          total += value.byteLength;
          if (limit > 0 && total > limit) {
            // Stop pulling the stream: the memory stays bounded even for a
            // chunked response without a content-length header.
            await reader.cancel().catch(() => undefined);
            throw new AttachmentTooLargeError(limit, total);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // A reader with a pending read cannot release; the stream is
          // already cancelled or finished in that case.
        }
      }
      return Buffer.concat(chunks);
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async listProjects(): Promise<PlannerProject[]> {
    const cached = this.projectsCache;
    if (cached !== null && Date.now() < cached.expiresAt) {
      return cached.projects;
    }
    let inFlight = this.projectsInFlight;
    if (inFlight === null) {
      inFlight = this.fetchProjects().then((projects) => {
        this.projectsCache = {
          projects,
          expiresAt: Date.now() + PLANNER_REFERENCE_TTL_MS,
        };
        return projects;
      });
      this.projectsInFlight = inFlight;
      const settle = () => {
        if (this.projectsInFlight === inFlight) {
          this.projectsInFlight = null;
        }
      };
      inFlight.then(settle, settle);
    }
    return inFlight;
  }

  private async fetchProjects(): Promise<PlannerProject[]> {
    const span = OTelTracer().startSpan("planner-client.list-projects");
    try {
      const body = await this.request("/api/projects", "GET", span);
      if (!Array.isArray(body)) {
        throw new Error("Planner projects response is not a list");
      }
      return (body as PlannerTaskJson[])
        .filter((project) => project?.id && project?.name)
        .map((project) => ({
          id: String(project.id),
          name: String(project.name),
          description:
            project.description === undefined || project.description === null
              ? ""
              : String(project.description),
          statuses: Array.isArray(project.statuses)
            ? project.statuses.map((status: unknown) => String(status))
            : undefined,
        }));
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async listNotes(projectId: string): Promise<PlannerNote[]> {
    const span = OTelTracer().startSpan("planner-client.list-notes");
    try {
      const body = await this.request(
        `/api/notes?projectId=${encodeURIComponent(projectId)}`,
        "GET",
        span,
      );
      if (!Array.isArray(body)) {
        throw new Error("Planner notes response is not a list");
      }
      return (body as PlannerTaskJson[]).map((note) => ({
        id: String(note.id),
        projectId: String(note.projectId),
        title: String(note.title),
        description:
          note.description === undefined || note.description === null
            ? ""
            : String(note.description),
      }));
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async createNote(
    projectId: string,
    title: string,
    description: string,
  ): Promise<PlannerNote> {
    const span = OTelTracer().startSpan("planner-client.create-note");
    try {
      const body = await this.request("/api/notes", "POST", span, {
        projectId: projectId,
        title: title,
        description: description,
      });
      if (!body?.id) {
        throw new Error(
          "Planner note creation response is missing the note id",
        );
      }
      return {
        id: String(body.id),
        projectId: String(body.projectId ?? projectId),
        title: String(body.title ?? title),
        description:
          body.description === undefined || body.description === null
            ? ""
            : String(body.description),
      };
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  public async updateNote(
    noteId: string,
    description: string,
    title?: string,
  ): Promise<void> {
    const span = OTelTracer().startSpan("planner-client.update-note");
    try {
      const body: { description: string; title?: string } = {
        description: description,
      };
      if (title !== undefined) {
        body.title = title;
      }
      await this.request(`/api/notes/${noteId}`, "PUT", span, body);
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
    body?: unknown,
  ): Promise<PlannerTaskJson> {
    const response = await this.fetchResponse(path, method, span, body);
    try {
      return await response.json();
    } catch (error) {
      throw new Error(
        `Planner request to '${path}' returned an invalid JSON response`,
        { cause: error },
      );
    }
  }

  // Performs the HTTP fetch with the retry policy of the client. Only
  // idempotent requests (GET) are retried, and only on a network error or
  // timeout and on a 429/5xx response; the retryable response body is
  // cancelled before the next attempt. A final non-OK response is reported
  // as a PlannerRequestError carrying the (truncated) response body.
  private async fetchResponse(
    path: string,
    method: string,
    span: PlannerSpan,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.config.PLANNER_URL}${path}`;
    const headers: Record<string, string> = {
      "x-api-key": this.config.PLANNER_API_KEY,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    StandardTracer.updateHttpHeader(span, headers);
    const attempts = method === "GET" ? Math.max(1, this.retryAttempts) : 1;
    const deadline = Date.now() + this.retryTotalBudgetMs;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method: method,
          headers: headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
        });
      } catch (error) {
        lastError = new Error(
          `Failed to reach Planner at '${url}': ${(error as Error).message}`,
          { cause: error },
        );
        if (
          attempt < attempts &&
          (await this.waitBeforeRetry(attempt, deadline))
        ) {
          continue;
        }
        throw lastError;
      }
      if (response.ok) {
        return response;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < attempts) {
        await response.body?.cancel().catch(() => undefined);
        if (await this.waitBeforeRetry(attempt, deadline)) {
          continue;
        }
      }
      const errorBody = await this.readErrorBody(response);
      throw new PlannerRequestError(
        `Planner request to '${path}' failed with status ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
        response.status,
        errorBody || undefined,
      );
    }
    throw (
      lastError ??
      new Error(
        `Planner request to '${path}' failed: the retry budget of ${this.retryTotalBudgetMs} ms was exhausted`,
      )
    );
  }

  // Full-jitter exponential backoff between two attempts. Returns false when
  // the delay would exceed the overall request budget.
  private async waitBeforeRetry(
    attempt: number,
    deadline: number,
  ): Promise<boolean> {
    const delay =
      Math.random() *
      Math.min(
        this.retryBaseDelayMs * 2 ** (attempt - 1),
        this.retryMaxDelayMs,
      );
    if (Date.now() + delay >= deadline) {
      return false;
    }
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return true;
  }

  private async readErrorBody(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, REQUEST_ERROR_BODY_MAX_CHARS).trim();
    } catch {
      return "";
    }
  }
}
