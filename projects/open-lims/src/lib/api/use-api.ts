import { useMemo } from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createApiClient, type ApiClient, type ApiClientOptions } from "./http-client";

export function useApiClient(options: ApiClientOptions = {}): ApiClient {
  const { getToken } = useAuth();
  const { baseUrl } = options;
  return useMemo(() => createApiClient(getToken, { baseUrl }), [getToken, baseUrl]);
}
