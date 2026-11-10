#!/usr/bin/env bash
# CI gate: operational output goes through @cuny-ai-lab/cail-log (src/logging.ts)
# only. Any direct console call, or a logging library, in the Worker source fails.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
if grep -rnE '\bconsole\.(log|info|warn|error|debug|trace|dir|table)\b' src; then
  echo "check-logging: use logger() from src/logging.ts (cail-log), not console" >&2
  status=1
fi
if grep -rnE "from ['\"](pino|winston|debug|loglevel|consola)['\"]" src; then
  echo "check-logging: only @cuny-ai-lab/cail-log may be used for logging" >&2
  status=1
fi
if ! grep -q 'createCailLogger' src/logging.ts; then
  echo "check-logging: src/logging.ts must build the cail-log logger" >&2
  status=1
fi
exit $status
