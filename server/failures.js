import { AppError } from "./errors.js";

// Builds an AppError that also carries a stable machine-readable `code`.
// The existing AppError(message, status) signature is untouched, so every
// current catch block and test keeps working.
//
// Codes used across the server:
//   AUTH_INVALID, QUOTA_EXCEEDED, RATE_LIMITED, MODEL_UNAVAILABLE,
//   PROVIDER_REJECTED, PROVIDER_UNAVAILABLE, TIMEOUT, NETWORK,
//   TRUNCATED_OUTPUT, BLOCKED, EMPTY_OUTPUT, UNREADABLE_RESPONSE,
//   BAD_JSON, SCHEMA_INVALID, EVIDENCE_NOT_FOUND, KEY_UNREADABLE,
//   STORE_UNREADABLE
export function fail(
  message,
  status = 502,
  code = "PROVIDER_ERROR",
  extra = {},
) {
  const error = new AppError(message, status);
  error.code = code;
  Object.assign(error, extra);
  return error;
}
