#!/usr/bin/env bash
set -euo pipefail

umask 077

session_root=${PI_SESSION_ROOT:-"$HOME/.pi/agent/sessions"}
subagent_root=${PI_SUBAGENT_SESSION_ROOT:-"$HOME/.local/state/pi-subagents/sessions"}
archive_root=${PI_SESSION_ARCHIVE_ROOT:-"$HOME/.local/share/pi/session-archive"}
primary_days=${PI_PRIMARY_RETENTION_DAYS:-90}
child_days=${PI_CHILD_RETENTION_DAYS:-30}

if [[ ! $primary_days =~ ^[0-9]+$ ]] || [[ ! $child_days =~ ^[0-9]+$ ]]; then
	printf 'Retention periods must be non-negative integers.\n' >&2
	exit 2
fi
primary_minutes=$((primary_days * 24 * 60))
child_minutes=$((child_days * 24 * 60))

manifest=""
archive_temp=""
cleanup() {
	[[ -z $manifest ]] || rm -f -- "$manifest"
	[[ -z $archive_temp ]] || rm -f -- "$archive_temp"
}
trap cleanup EXIT

archive_primary_sessions() {
	[[ -d $session_root ]] || return 0

	local -a files=()
	mapfile -d '' files < <(
		find "$session_root" \
			-mindepth 2 \
			-maxdepth 2 \
			-type f \
			-name '*.jsonl' \
			-mmin "+$primary_minutes" \
			-print0
	)
	if ((${#files[@]} == 0)); then
		return 0
	fi

	mkdir -p -- "$archive_root"
	chmod 0700 "$archive_root"
	manifest=$(mktemp "$archive_root/.pi-session-manifest.XXXXXX")
	archive_temp=$(mktemp "$archive_root/.pi-sessions.XXXXXX.tar.zst")

	local file
	for file in "${files[@]}"; do
		printf '%s\0' "${file#"$session_root"/}" >>"$manifest"
	done

	tar \
		--create \
		--file=- \
		--directory="$session_root" \
		--null \
		--files-from="$manifest" |
		zstd --quiet --force --threads=0 -o "$archive_temp"
	zstd --quiet --test "$archive_temp"
	tar --use-compress-program=unzstd --list --file="$archive_temp" >/dev/null

	local archive
	archive="$archive_root/pi-sessions-$(date --utc +%Y%m%dT%H%M%SZ)-$$.tar.zst"
	mv -- "$archive_temp" "$archive"
	archive_temp=""
	rm -f -- "$manifest"
	manifest=""
	rm -f -- "${files[@]}"
	printf 'Archived %d primary Pi sessions in %s.\n' "${#files[@]}" "$archive"
}

remove_expired_nested_data() {
	[[ -d $session_root ]] || return 0

	local -a files=()
	mapfile -d '' files < <(
		find "$session_root" \
			-mindepth 3 \
			-type f \
			-mmin "+$child_minutes" \
			\( -name '*.jsonl' -o -path '*/subagent-artifacts/*' \) \
			-print0
	)
	if ((${#files[@]} > 0)); then
		rm -f -- "${files[@]}"
		printf 'Removed %d expired nested subagent files.\n' "${#files[@]}"
	fi
	find "$session_root" -depth -mindepth 2 -type d -empty -delete
}

remove_expired_separate_sessions() {
	[[ -d $subagent_root ]] || return 0

	local -a files=()
	mapfile -d '' files < <(
		find "$subagent_root" \
			-type f \
			-name '*.jsonl' \
			-mmin "+$child_minutes" \
			-print0
	)
	if ((${#files[@]} > 0)); then
		rm -f -- "${files[@]}"
		printf 'Removed %d expired subagent sessions.\n' "${#files[@]}"
	fi
	find "$subagent_root" -depth -mindepth 1 -type d -empty -delete
}

archive_primary_sessions
remove_expired_nested_data
remove_expired_separate_sessions
