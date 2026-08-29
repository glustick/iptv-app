#!/usr/bin/env bash
# Stand-in "ffmpeg" for transcodeService.test.ts's control-flow tests — behavior is picked via
# $FAKE_FFMPEG_MODE rather than argv, since a test can't vary the fixed argument shape
# startTranscode always builds (source URL, map/codec flags, then the playlist path last).
# chmod +x is applied at test setup time (see transcodeService.test.ts) rather than relying on
# git to preserve the executable bit, which isn't guaranteed across clones/platforms.
set -u
last_arg="${@: -1}"

case "${FAKE_FFMPEG_MODE:-}" in
  success)
    printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
    sleep 5
    ;;
  success_with_subtitles)
    echo "Stream #0:2(eng): Subtitle: subrip" >&2
    printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
    printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$(dirname "$last_arg")/playlist_vtt.m3u8"
    sleep 5
    ;;
  subtitle_detected_but_rendition_never_written)
    echo "Stream #0:2(eng): Subtitle: subrip" >&2
    printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
    sleep 5
    ;;
  fail_immediately)
    echo "fake ffmpeg: simulated fatal error" >&2
    exit 1
    ;;
  hang_forever)
    sleep 300
    ;;
  *)
    echo "fake ffmpeg: unset or unknown FAKE_FFMPEG_MODE: ${FAKE_FFMPEG_MODE:-<unset>}" >&2
    exit 1
    ;;
esac
