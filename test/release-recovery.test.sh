#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '{"isDraft":%s,"tagName":"%s"}\n' "$MOCK_DRAFT" "$MOCK_TAG"
EOF
cat > "$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fetch) exit 0 ;;
  rev-parse) printf '%s\n' "$MOCK_TAG_SHA" ;;
  merge-base) [[ "$MOCK_ANCESTOR" == true ]] ;;
  show) printf '%s\n' "$MOCK_SUBJECT" ;;
  *) exit 1 ;;
esac
EOF
cat > "$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$MOCK_HTTP" == error ]]; then exit 7; fi
printf '%s' "$MOCK_HTTP"
EOF
chmod +x "$tmp/bin/gh" "$tmp/bin/git" "$tmp/bin/curl"
export PATH="$tmp/bin:$PATH"
export GITHUB_REF=refs/heads/main DEFAULT_BRANCH=main GITHUB_REPOSITORY=owner/repo REF_PROTECTED=true
export TAG=v0.9.0 TARGET_SHA=0123456789abcdef0123456789abcdef01234567
export GITHUB_SHA="$TARGET_SHA"
export MOCK_DRAFT=true MOCK_TAG=v0.9.0 MOCK_TAG_SHA="$TARGET_SHA" MOCK_ANCESTOR=true MOCK_HTTP=404 MOCK_SUBJECT='chore(release): v0.9.0'

expect_failure() {
  if bash "$root/scripts/validate-release-recovery.sh" > /dev/null 2>&1; then
    echo "失敗すべき検証が成功しました: $1" >&2
    exit 1
  fi
}

bash "$root/scripts/validate-release-recovery.sh"
GITHUB_REF=refs/heads/other expect_failure '既定ブランチ以外'
REF_PROTECTED=false expect_failure '保護されていないブランチ'
TAG='v0.9.0;bad' expect_failure '不正なタグ'
TARGET_SHA=bad expect_failure '不正な SHA'
MOCK_DRAFT=false expect_failure '公開済み release'
MOCK_TAG=v0.8.0 expect_failure '異なる draft'
MOCK_TAG_SHA=1123456789abcdef0123456789abcdef01234567 expect_failure 'タグの SHA 不一致'
MOCK_ANCESTOR=false expect_failure 'main の履歴に含まれない SHA'
MOCK_SUBJECT='chore: v0.9.0' expect_failure 'リリースコミット以外'
MOCK_HTTP=200 expect_failure 'npm 公開済み'
MOCK_HTTP=500 expect_failure 'registry 障害'
MOCK_HTTP=error expect_failure 'registry 通信失敗'
echo 'リリース回復の検証に成功しました'
