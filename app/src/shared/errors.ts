export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.error;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return error == null ? '启动失败，请重试' : String(error);
}
