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
  success_with_multiple_subtitles)
    echo "Stream #0:2(eng): Subtitle: subrip" >&2
    echo "Stream #0:3(fre): Subtitle: subrip" >&2
    printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
    printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$(dirname "$last_arg")/playlist_vtt.m3u8"
    sleep 5
    ;;
  subtitle_codec_incompatible_then_succeeds)
    # Simulates the real failure a bitmap subtitle codec (PGS, VobSub, ...) produces — confirmed
    # live against a real file — and the automatic retry-without-subtitles that should follow.
    # Distinguishing "first attempt" from "the retry" needs a marker outside startTranscode's own
    # per-call temp dir, since each attempt gets a fresh one (mkdtemp) with nothing shared between
    # them — FAKE_FFMPEG_MARKER_FILE is a fixed path the test controls for exactly this.
    marker="${FAKE_FFMPEG_MARKER_FILE:?FAKE_FFMPEG_MARKER_FILE must be set for this mode}"
    if [ -f "$marker" ]; then
      printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
      sleep 5
    else
      touch "$marker"
      echo "Stream #0:2(eng): Subtitle: dvd_subtitle" >&2
      echo "[sost#0:2/webvtt @ 0x0] Subtitle encoding currently only possible from text to text or bitmap to bitmap" >&2
      exit 1
    fi
    ;;
  subtitle_codec_incompatible_always)
    # Unlike the _then_succeeds mode above, fails the same way on every invocation — for testing
    # that startTranscode's retry-without-subtitles guard doesn't recurse forever if the retry
    # itself somehow hit the identical failure again.
    echo "Stream #0:2(eng): Subtitle: dvd_subtitle" >&2
    echo "[sost#0:2/webvtt @ 0x0] Subtitle encoding currently only possible from text to text or bitmap to bitmap" >&2
    exit 1
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
