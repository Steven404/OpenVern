// Error codes and standard user-facing messages (plan §4.2).

export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'internal'
  | 'no_api_key'
  | 'invalid_api_key'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'context_length_exceeded'
  | 'model_unavailable'
  | 'model_no_tools'
  | 'model_no_image_input'
  | 'provider_error'
  | 'network_error'
  | 'unsupported_file'
  | 'file_too_large'
  | 'path_invalid'
  | 'max_steps_reached';

export interface ApiErrorInfo {
  code: ErrorCode;
  message: string; // user-facing, sentence case, no stack traces
  retryable: boolean;
}

/** HTTP error body for every non-2xx JSON response. */
export interface ApiErrorBody {
  error: ApiErrorInfo;
}

/** Standard copy and retryability per code. Callers may pass a more specific message. */
export const ERROR_DEFAULTS: Record<ErrorCode, { message: string; retryable: boolean }> = {
  invalid_request: { message: 'The request was not valid.', retryable: false },
  not_found: { message: 'Not found.', retryable: false },
  conflict: { message: 'That conflicts with something that already exists.', retryable: false },
  internal: { message: 'Something went wrong inside harness.', retryable: true },
  no_api_key: { message: 'Add your OpenRouter API key in Settings to start chatting.', retryable: false },
  invalid_api_key: { message: 'OpenRouter rejected this key.', retryable: false },
  insufficient_credits: { message: 'Your OpenRouter account is out of credits.', retryable: false },
  rate_limited: { message: 'Rate limited by the provider. Wait a moment and try again.', retryable: true },
  context_length_exceeded: {
    message:
      'This conversation is too long for the selected model. Start a new chat or pick a model with a larger context.',
    retryable: false,
  },
  model_unavailable: { message: 'This model is not available right now. Pick another one.', retryable: false },
  model_no_tools: {
    message: "This model can't use tools, so it can't read your project files. Pick another model.",
    retryable: false,
  },
  model_no_image_input: { message: 'This model does not support image input', retryable: false },
  provider_error: { message: 'The model provider returned an error. Try again.', retryable: true },
  network_error: { message: "Couldn't reach OpenRouter. Check your connection.", retryable: true },
  unsupported_file: { message: 'This file type is not supported. Attach text files or images.', retryable: false },
  file_too_large: { message: 'This file is too large.', retryable: false },
  path_invalid: { message: 'That folder does not exist or cannot be read.', retryable: false },
  max_steps_reached: {
    message: 'Stopped after too many steps in one turn. Reply to let it continue.',
    retryable: true,
  },
};

/** HTTP status the server uses for each code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
  no_api_key: 400,
  invalid_api_key: 400,
  insufficient_credits: 402,
  rate_limited: 429,
  context_length_exceeded: 400,
  model_unavailable: 400,
  model_no_tools: 400,
  model_no_image_input: 400,
  provider_error: 502,
  network_error: 502,
  unsupported_file: 415,
  file_too_large: 413,
  path_invalid: 400,
  max_steps_reached: 400,
};

export function errorInfo(code: ErrorCode, message?: string): ApiErrorInfo {
  const d = ERROR_DEFAULTS[code];
  return { code, message: message ?? d.message, retryable: d.retryable };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const e = (value as { error: unknown }).error;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as ApiErrorInfo).code === 'string' &&
    typeof (e as ApiErrorInfo).message === 'string'
  );
}
