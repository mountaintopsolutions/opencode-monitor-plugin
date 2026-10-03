// Runtime entry: helper exports in index.ts are not additional plugin factories.
//
// Re-export the combined `{ id, setup, server }` default rather than just
// `server`. v2's plugin resolver prefers this entry, and it rejects a default
// that is a bare function ("Expected object at [default]"), so exporting only
// `server` here made the package unloadable under v2 even though index.ts was
// correct.
export { default } from './index.js';
