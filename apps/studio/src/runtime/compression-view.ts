/**
 * W1900: the `/api/status.compression` block.
 *
 * The studio does not compute compression state — it REPORTS it. The engine
 * layer already knows what a session's log is compressing (the sidecar's block
 * list, read through the same overlay the model sees), and a second copy of
 * that arithmetic in the HTTP layer would be a second answer to the same
 * question, free to drift the moment a rule changes. So this module is only a
 * NAMED re-export: the studio's status surface speaks `CompressionStatusView`
 * the way it speaks `RecoveryView`, and the values come from
 * `@celestea/runtime`.
 *
 * Always present, never throwing: `compressionViewOf(null)` is the honest
 * "this session has nothing compressed" block, which is exactly what a status
 * poll of a session that was never composed must report.
 */

import { compressionViewOf, type CompressionView } from "@celestea/runtime";

/** The `compression` key of `GET /api/status` (see the module doc). */
export type CompressionStatusView = CompressionView;

/** The block of a session's compression state, or the disabled one. */
export { compressionViewOf };
