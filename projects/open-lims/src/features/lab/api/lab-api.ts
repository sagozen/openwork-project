import type { ApiClient } from "@/lib/api";
import type {
  AnalysisTaskDetail,
  AnalysisTaskFilters,
  AnalysisTaskList,
  AssignTasksInput,
  AssignTasksResponse,
  CreateRawResultInput,
  CreateRawResultResponse,
  EligibleAssignee,
  FinalResult,
  RegisterTechnicalFileInput,
  SelectFinalResultInput,
  TaskActionResult,
  TechnicalFile,
} from "../types";

/** `?parameterCode=A&parameterCode=B` - JAX-RS `@QueryParam List<String>` binds repeated params
 * of the exact declared name; a `key[]` suffix (as sibling domains still send) would bind to
 * nothing since no `@QueryParam("parameterCode[]")` exists. */
function query(filters: AnalysisTaskFilters): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}
const taskPath = (code: string) => `/analysis-tasks/${encodeURIComponent(code)}`;

export const labApi = {
  list: (api: ApiClient, filters: AnalysisTaskFilters = {}) =>
    api.get<AnalysisTaskList>(`/analysis-tasks${query(filters)}`),
  detail: (api: ApiClient, code: string) => api.get<AnalysisTaskDetail>(taskPath(code)),
  assign: (api: ApiClient, input: AssignTasksInput) =>
    api.post<AssignTasksResponse>("/analysis-tasks/assign", input),
  eligibleAssignees: (api: ApiClient, code: string) =>
    api.get<{ content: EligibleAssignee[] }>(`${taskPath(code)}/eligible-assignees`),
  claim: (api: ApiClient, code: string) => api.post<TaskActionResult>(`${taskPath(code)}/claim`),
  start: (api: ApiClient, code: string) => api.post<TaskActionResult>(`${taskPath(code)}/start`),
  addRawResult: (api: ApiClient, code: string, input: CreateRawResultInput) =>
    api.post<CreateRawResultResponse>(`${taskPath(code)}/raw-results`, input),
  selectFinalResult: (api: ApiClient, code: string, input: SelectFinalResultInput) =>
    api.put<FinalResult>(`${taskPath(code)}/final-result`, input),
  registerTechnicalFile: (api: ApiClient, code: string, input: RegisterTechnicalFileInput) =>
    api.post<TechnicalFile>(`${taskPath(code)}/technical-files`, input),
  submitReview: (api: ApiClient, code: string) =>
    api.post<TaskActionResult>(`${taskPath(code)}/submit-review`),
};

/** Stable detail client owned by lab and shared with the technical-review feature. */
export const getAnalysisTaskDetail = labApi.detail;
