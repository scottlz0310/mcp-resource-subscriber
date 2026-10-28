#!/usr/bin/env bash
set -euo pipefail

if [[ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" || "$REF_PROTECTED" != true || ! "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ || ! "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ || ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo '::error::既定ブランチ、タグ、対象 SHA を確認してください' >&2
  exit 1
fi

release=$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,tagName)
if ! jq -e --arg tag "$TAG" '.isDraft == true and .tagName == $tag' <<< "$release" > /dev/null; then
  echo '::error::対象の draft release を確認できません' >&2
  exit 1
fi

git fetch --no-tags origin "refs/tags/$TAG"
tag_sha=$(git rev-parse 'FETCH_HEAD^{commit}')
if [[ "$tag_sha" != "$TARGET_SHA" ]] || ! git merge-base --is-ancestor "$TARGET_SHA" "$GITHUB_SHA"; then
  echo '::error::タグ、対象 SHA、main の履歴が一致しません' >&2
  exit 1
fi
subject=$(git show -s --format=%s "$TARGET_SHA")
expected="chore(release): $TAG"
suffix=${subject#"$expected"}
if [[ "$subject" != "$expected"* || ( -n "$suffix" && ! "$suffix" =~ ^\ \(\#[0-9]+\)$ ) ]]; then
  echo '::error::対象コミットの件名がリリース版に一致しません' >&2
  exit 1
fi

status=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 "https://registry.npmjs.org/resource-bridge-cli/${TAG#v}")
if [[ "$status" != 404 ]]; then
  echo "::error::npm 未公開を確認できません（HTTP $status）" >&2
  exit 1
fi
