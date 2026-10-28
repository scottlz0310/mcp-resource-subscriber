#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/package-output"
cat > "$tmp/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_ARGS"
EOF
chmod +x "$tmp/bin/npm"
export PATH="$tmp/bin:$PATH" MOCK_ARGS="$tmp/args" TAG=v0.9.0
awk '/^      - name: 同じ workflow から OIDC で npm 公開$/ { found=1; next } found && /^        run: \|$/ { body=1; next } body && /^          / { sub(/^          /, ""); print; next } body { exit }' "$root/.github/workflows/publish.yml" > "$tmp/publish.sh"
test -s "$tmp/publish.sh"
cd "$tmp"
if bash publish.sh > /dev/null 2>&1; then
  echo 'tarball 不在を検出できません' >&2
  exit 1
fi
touch package-output/resource-bridge-cli-0.9.0.tgz
bash publish.sh
expected=$(printf '%s\n' publish ./package-output/resource-bridge-cli-0.9.0.tgz --provenance --access public)
test "$(cat "$MOCK_ARGS")" = "$expected"
echo 'npm 公開引数の検証に成功しました'
