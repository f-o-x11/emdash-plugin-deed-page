#!/usr/bin/env bash
# One-command release to the EmDash plugin registry.
#
#   scripts/publish.sh [bluesky-handle] [--dry-run]
#
# The handle defaults to upskillcoach.bsky.social, the account pinned as
# `publisher` in emdash-plugin.jsonc.
#
# 1. Resolves the handle to its DID and checks it matches the pinned
#    `publisher` DID (the registry refuses a mismatch; change the manifest
#    deliberately if the publishing account ever changes).
# 2. Installs, validates, and runs the test suite.
# 3. Logs in with atproto OAuth if this machine has no session for that DID
#    (opens a browser; on a headless machine, open the printed URL in a
#    browser on the same machine so the 127.0.0.1 callback can complete).
# 4. Runs `emdash-plugin publish`, which uploads the release to the
#    account's PDS. The listing then appears on plugins.emdashcms.com once
#    the registry's automated checks pass.
#
# --dry-run stops before login and publish.
set -euo pipefail

HANDLE="upskillcoach.bsky.social"
DRY_RUN=""
for arg in "$@"; do
	case "$arg" in
	--dry-run) DRY_RUN="--dry-run" ;;
	-*) echo "usage: scripts/publish.sh [bluesky-handle] [--dry-run]" >&2; exit 2 ;;
	*) HANDLE="$arg" ;;
	esac
done
HANDLE="${HANDLE#@}"

cd "$(dirname "$0")/.."

DID="$(curl -fsS "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${HANDLE}" |
	node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).did||""))')"
if [[ "$DID" != did:* ]]; then
	echo "Could not resolve ${HANDLE} to a DID" >&2
	exit 1
fi
echo "Publisher: ${HANDLE} (${DID})"

CURRENT="$(node -e 'const s=require("fs").readFileSync("emdash-plugin.jsonc","utf8");const m=s.match(/"publisher"\s*:\s*"([^"]+)"/);process.stdout.write(m?m[1]:"")')"
if [[ "$CURRENT" != "$DID" ]]; then
	echo "Manifest publisher is ${CURRENT:-<none>} but ${HANDLE} is ${DID}. Refusing to publish." >&2
	exit 1
fi

pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test

VERSION="$(node -p 'require("./package.json").version')"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
	echo "Dry run OK: would publish deed-page@${VERSION} as ${HANDLE}."
	exit 0
fi

ACTIVE="$(pnpm exec emdash-plugin whoami --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const c=j.current;process.stdout.write((c&&(c.did||c))||"")}catch{}})')"
if [[ "$ACTIVE" != "$DID" ]]; then
	echo "No active registry session for ${DID}; starting atproto OAuth login..."
	pnpm exec emdash-plugin login "$HANDLE"
fi

pnpm exec emdash-plugin publish
echo
echo "Published deed-page@${VERSION}. Track the listing with:"
echo "  pnpm exec emdash-plugin info ${HANDLE} deed-page --version ${VERSION} --watch"
