export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method, cache: 'no-store', credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-GroupOS-Request': '1' }, body: JSON.stringify(body) }) });
  if (response.status === 401) {
    window.dispatchEvent(new Event('groupos-session-expired'));
    throw new ApiError(401, 'Your session expired. Sign in again to continue.');
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'Unable to complete this request. Try refreshing.');
  return data as T;
}
export const messageOf = (error: unknown) => error instanceof TypeError ? 'Unable to reach GroupOS. Check your connection and refresh.' : error instanceof Error ? error.message : 'Unable to reach GroupOS. Please try again.';
export type Outing = { id: string; title: string; description: string | null; location: string | null; startsAt: string | null; endsAt: string | null; timeZone: string; status: 'DRAFT' | 'OPEN' | 'FINALIZED' | 'CANCELLED' };
export type Counts = { total: number; YES: number; NO: number; MAYBE: number; pending: number };
export const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not set';
