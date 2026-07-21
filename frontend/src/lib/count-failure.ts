export type CountFailure = {
  status: 500 | 503;
  publicMessage: string;
};

/** Map Firestore count failures to an HTTP response the client can act on. */
export function classifyCountFailure(message: string): CountFailure {
  if (/currently building|cannot be used yet/i.test(message)) {
    return {
      status: 503,
      publicMessage: "count temporarily unavailable (index building)",
    };
  }

  if (/could not load the default credentials|application default credentials/i.test(message)) {
    return {
      status: 503,
      publicMessage: "count temporarily unavailable (credentials not configured)",
    };
  }

  return { status: 500, publicMessage: "count failed" };
}
