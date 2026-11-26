import { ApiError } from "./api-error";
import type { ProblemDetails } from "./types";
import { MAX_UPLOAD_LABEL } from "./upload-limits";

export type TokenProvider = () => Promise<string | null>;
export type ApiResponseType = "json" | "blob" | "text";

export interface ApiRequestOptions extends Omit<RequestInit, "body" | "method"> {
  body?: unknown;
  responseType?: ApiResponseType;
  idempotencyKey?: string;
  authenticated?: boolean;
  /**
   * Bỏ cuộc sau bấy nhiêu mili-giây và báo hết giờ.
   *
   * Không đặt thì `fetch` chờ theo trình duyệt, tức có thể chờ rất lâu mà không nói gì. Ngoài
   * hiện trường, một nút kẹt ở "Đang gửi…" hàng chục giây rồi lặng lẽ trở lại bình thường là
   * điều tệ nhất có thể xảy ra: người dùng không biết đã gửi được hay chưa. Chỉ đặt cho những
   * lời gọi ngắn, có thể bấm lại an toàn (đã có Idempotency-Key) - đừng đặt cho lượt tải ảnh.
   */
  timeoutMs?: number;
}

export interface ApiClientOptions {
  baseUrl?: string;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(path: string, method?: string, options?: ApiRequestOptions): Promise<T>;
  get<T>(path: string, options?: ApiRequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T>;
  del<T>(path: string, options?: ApiRequestOptions): Promise<T>;
  getBlob(path: string, options?: ApiRequestOptions): Promise<Blob>;
}

const apiEnvKey = ["VITE", "API", "URL"].join("_");
const iamApiEnvKey = ["VITE", "IAM", "API", "URL"].join("_");
const configuredApiUrl = import.meta.env[apiEnvKey] as string | undefined;
const configuredIamApiUrl = import.meta.env[iamApiEnvKey] as string | undefined;
const DEFAULT_BASE_URL = "http://localhost:8080/api/v1";

function normalizedBaseUrl(baseUrl?: string): string {
  return (baseUrl || configuredApiUrl || configuredIamApiUrl || DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
}

function requestUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function isBodyInit(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function bodyFingerprint(body: unknown): string {
  if (body === undefined) return "";
  if (body instanceof FormData) {
    return JSON.stringify(
      Array.from(body.entries()).map(([key, value]) => [
        key,
        value instanceof File
          ? `${value.name}:${value.size}:${value.type}:${value.lastModified}`
          : value,
      ]),
    );
  }
  if (body instanceof File) {
    return `${body.name}:${body.size}:${body.type}:${body.lastModified}`;
  }
  if (body instanceof Blob) return `${body.size}:${body.type}`;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Câu thay thế cho những mã lỗi máy chủ trả về với thân rỗng.
 *
 * 413 là cái đau nhất: Quarkus từ chối một thân yêu cầu quá khổ ở tầng HTTP, trước khi chạm vào
 * mã ứng dụng, nên không có `ProblemDetails` nào để đọc - người dùng chỉ nhận đúng câu chung
 * "Không thể hoàn tất thao tác." sau khi đã đẩy xong cả tấm ảnh.
 */
const STATUS_FALLBACK_MESSAGES: Record<number, string> = {
  413: `Tệp vượt quá dung lượng máy chủ nhận. Mỗi tệp tối đa ${MAX_UPLOAD_LABEL}.`,
};

async function errorBody(response: Response): Promise<ProblemDetails> {
  let body: ProblemDetails = {};
  try {
    body = ((await response.json()) as ProblemDetails) ?? {};
  } catch {
    body = {};
  }
  const fallback = STATUS_FALLBACK_MESSAGES[response.status];
  return fallback && !body.message ? { ...body, message: fallback } : body;
}

export function createApiClient(
  tokenProvider?: TokenProvider,
  options: ApiClientOptions = {},
): ApiClient {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const pendingWriteKeys = new Map<string, string>();

  async function request<T>(
    path: string,
    method = "GET",
    requestOptions: ApiRequestOptions = {},
  ): Promise<T> {
    const {
      body,
      responseType = "json",
      idempotencyKey,
      authenticated = tokenProvider !== undefined,
      headers: requestHeaders,
      timeoutMs,
      signal: callerSignal,
      ...init
    } = requestOptions;
    const token = authenticated ? await tokenProvider?.() : null;
    if (authenticated && !token) {
      throw new ApiError(401, { code: "E-IAM-001", message: "Phiên đăng nhập không hợp lệ." });
    }

    const upperMethod = method.toUpperCase();
    const writes = ["POST", "PUT", "PATCH", "DELETE"].includes(upperMethod);
    const writeFingerprint = writes ? `${upperMethod}:${path}:${bodyFingerprint(body)}` : undefined;
    const rawBody = body === undefined ? undefined : isBodyInit(body) ? body : JSON.stringify(body);
    const headers = new Headers(requestHeaders);
    headers.set("Accept", responseType === "json" ? "application/json" : "*/*");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (body !== undefined && !(body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    if (writes && !headers.has("Idempotency-Key")) {
      const key = idempotencyKey ?? pendingWriteKeys.get(writeFingerprint!) ?? crypto.randomUUID();
      pendingWriteKeys.set(writeFingerprint!, key);
      headers.set("Idempotency-Key", key);
    }

    const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const signal =
      timeoutSignal && callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : (timeoutSignal ?? callerSignal);

    // If fetch throws, execution never reaches the deletion below, so an
    // unknown-outcome retry reuses the same key.
    let response: Response;
    try {
      response = await fetch(requestUrl(baseUrl, path), {
        ...init,
        method: upperMethod,
        headers,
        body: rawBody,
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      // Hết giờ là một kết cục KHÔNG BIẾT: máy chủ có thể đã nhận. Nói đúng như vậy thay vì
      // ngầm hiểu là thất bại, và giữ nguyên Idempotency-Key để lần bấm lại không tạo bản ghi
      // thứ hai nếu lần đầu thực ra đã tới nơi.
      if (timeoutSignal?.aborted) {
        throw new ApiError(
          408,
          {
            code: "E-NET-TIMEOUT",
            message:
              "Máy chủ không trả lời kịp. Kiểm tra lại trạng thái lượt trước khi gửi lần nữa - " +
              "dữ liệu vừa nhập vẫn còn trên màn hình.",
          },
          { cause },
        );
      }
      throw cause;
    }
    if (writeFingerprint) pendingWriteKeys.delete(writeFingerprint);
    if (!response.ok) throw new ApiError(response.status, await errorBody(response));
    if (response.status === 204) return undefined as T;
    if (responseType === "blob") return (await response.blob()) as T;
    if (responseType === "text") return (await response.text()) as T;
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new ApiError(
        response.status,
        { message: "Phản hồi máy chủ không đúng định dạng JSON." },
        { cause },
      );
    }
  }

  return {
    baseUrl,
    request,
    get: (path, requestOptions) => request(path, "GET", requestOptions),
    post: (path, body, requestOptions) => request(path, "POST", { ...requestOptions, body }),
    put: (path, body, requestOptions) => request(path, "PUT", { ...requestOptions, body }),
    patch: (path, body, requestOptions) => request(path, "PATCH", { ...requestOptions, body }),
    del: (path, requestOptions) => request(path, "DELETE", requestOptions),
    getBlob: (path, requestOptions) =>
      request<Blob>(path, "GET", { ...requestOptions, responseType: "blob" }),
  };
}
