#!/bin/sh
set -eu
printf '%s\n' 'Use the supervisor workspace ownership records and git worktree list --porcelain. Unknown ownership means keep the worktree.'
git worktree list --porcelain
