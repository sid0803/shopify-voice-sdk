// Shared API envelope. Verified:
// techladder-core/app/domain/developer_integrations/response_schemas.py:6-8
// and per-resource ApiResponse schemas, e.g.
// techladder-core/app/domain/developer_integrations/call_batches/schemas.py:335-381

export interface ApiEnvelope<T> {
  status_code: number;
  message: string;
  error: { code: string; details: string[] } | null;
  data: T;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}
