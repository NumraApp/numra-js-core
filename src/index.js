export { Numra, VERSION } from './client.js';
export { NumraError, ERROR_CODES } from './errors.js';
export {
  verifyWebhook,
  isValidWebhook,
  WebhookVerificationError,
} from './webhooks.js';

/* Shared by @numra/express, @numra/fastify, @numra/next and @numra/nuxt.
   Framework packages are thin adapters over these; the logic that must not
   drift between them — deny-by-default above all — lives in one file. */
export {
  createHandlers,
  forBrowser,
  translateError,
  DENY_BY_DEFAULT,
  NOT_CONFIGURED_MESSAGE,
  notConfiguredMessage,
  DEFAULT_USAGE,
} from './server.js';
