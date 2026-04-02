#!/usr/bin/env bash
set -euo pipefail

echo "Running MSAB architecture checks..."

violations=0

check() {
  local message="$1"
  local pattern="$2"
  local target="$3"
  if grep -R -nE "$pattern" "$target" --include='*.ts' 2>/dev/null >/tmp/arch_check_msab.out; then
    echo "FAIL: $message"
    cat /tmp/arch_check_msab.out
    violations=$((violations + 1))
  fi
}

# Empty catch blocks hide REACT failures — log instead.
check "Silent catch blocks are not allowed" 'catch\s*\([^)]*\)\s*\{\s*\}' src

if [[ $violations -gt 0 ]]; then
  echo "MSAB architecture checks failed with $violations violation group(s)."
  exit 1
fi

echo "MSAB architecture checks passed."
