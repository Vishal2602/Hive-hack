#!/bin/sh
# Puts both demo playground folders back to a clean checkout before each take.
# Keeps the Hive connection files (.hive/ and .claude/settings.local.json are git-ignored).
set -e
for dir in "$HOME/Documents/Projects/hive-playground" "$HOME/Documents/Projects/hive-playground-2"; do
  if [ ! -d "$dir/.git" ]; then echo "Missing $dir, skipping"; continue; fi
  git -C "$dir" checkout -- .
  git -C "$dir" clean -fdq
  echo "Reset $dir"
done
echo "Done. Close old Claude sessions and wait about 2 minutes so their Hive leases expire."
