/**
 * The shared hard timeout for send-purpose translation requests lives in
 * `@gian/chat-ui` so Remote Web applies the exact same 45s gate. This module
 * keeps the local import path stable.
 */
export { SEND_TRANSLATE_TIMEOUT_MS, withSendTimeout, type SendTimeout } from '@gian/chat-ui';
