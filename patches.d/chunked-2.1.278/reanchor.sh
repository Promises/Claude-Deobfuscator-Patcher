#!/bin/bash
# Re-context the patch set against a new deob tree, IN BUILD ORDER.
# Order matters: 008 and 010 sit 9 lines apart in the same file, so each
# patch's diff must be generated against the tree with its predecessors applied.
# Header comments are preserved verbatim; only the diff body is regenerated.
P=/Users/henningberge/Documents/projects/claudiverse/patch-ref/patches.d/chunked
T="$1"; OUT="$2"; mkdir -p "$OUT"
cd "$T" || exit 1
git reset -q --hard $(git rev-list --max-parents=0 HEAD); git clean -qfd
for p in $P/*.patch; do
  n=$(basename "$p" .patch)
  if git apply --check "$p" 2>/dev/null; then
    git apply "$p"; git add -A; git -c user.email=t@t -c user.name=t commit -qm "$n"
    echo "CLEAN     $n"; continue
  fi
  if patch -p1 --fuzz=3 -s -i "$p" >/dev/null 2>&1; then
    /usr/bin/find . -name '*.orig' -delete 2>/dev/null
    awk '/^diff --git/{exit} {print}' "$p" > "$OUT/$n.patch"
    git diff -U6 >> "$OUT/$n.patch"
    git add -A; git -c user.email=t@t -c user.name=t commit -qm "$n"
    echo "REGENED   $n"
  else
    git checkout -q .; git clean -qfd 2>/dev/null
    echo "MANUAL    $n"
  fi
done
