#!/usr/bin/env bash
# Stand-in "ffmpeg" for transcodeService.test.ts's control-flow tests — behavior is picked via
# $FAKE_FFMPEG_MODE rather than argv, since a test can't vary the fixed argument shape
# startTranscode always builds (source URL, map/codec flags, then the playlist path last).
# chmod +x is applied at test setup time (see transcodeService.test.ts) rather than relying on
# git to preserve the executable bit, which isn't guaranteed across clones/platforms.
set -u
last_arg="${@: -1}"

case "${FAKE_FFMPEG_MODE:-}" in
  capture_argv)
    # Writes its own argv, one flag per line, to the file the test points at — the only way a
    # fixture this blind can pin down WHICH argv shape a call built (see the live-fmp4 vs
    # VOD-MPEG-TS assertions in transcodeService.test.ts).
    printf '%s\n' "$@" > "${FAKE_FFMPEG_ARGV_FILE:?FAKE_FFMPEG_ARGV_FILE must be set for this mode}"
    printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
    sleep 5
    ;;
  capture_argv_hevc)
    # Simulates the HEVC-restart flow: the first invocation announces an HEVC video stream
    # (which the service's stderr watcher reacts to by killing this attempt) and lingers; the
    # second invocation — the respawn with the hvc1 tag — is the one that captures its argv.
    marker="${FAKE_FFMPEG_ARGV_FILE:?FAKE_FFMPEG_ARGV_FILE must be set for this mode}.hevc-restarted"
    if [ -f "$marker" ]; then
      printf '%s\n' "$@" > "${FAKE_FFMPEG_ARGV_FILE}"
      printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
      sleep 5
    else
      touch "$marker"
      echo "Stream #0:0: Video: hevc (Main), yuv420p(tv, bt709), 3840x2160, 50 fps, 50 tbr, 90k tbn" >&2
      sleep 300
    fi
    ;;
  stall_then_succeed)
    # Simulates the provider's intermittent new-connection stall (confirmed live 2026-09-26:
    # a live stream that accepts the connection and delivers nothing): the first invocation
    # produces nothing at all and lingers until the service's timeout kills it; the retry —
    # a genuinely fresh attempt on a fresh "connection" — succeeds.
    marker="${FAKE_FFMPEG_ARGV_FILE:?FAKE_FFMPEG_ARGV_FILE must be set for this mode}.retried"
    if [ -f "$marker" ]; then
      printf '#EXTM3U\n#EXT-X-ENDLIST\n' > "$last_arg"
      sleep 5
    else
      touch "$marker"
      sleep 300
    fi
    ;;
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
  probe_multi_audio)
    # Mirrors a real probe against a real live channel on this app's test account (a sports
    # channel provider-labeled "5.1 + Stereo" whose playlist advertised one rendition, but whose
    # raw multiplex actually carried three) — see probeTracks/AUDIO_STREAM_PATTERN.
    echo "Stream #0:0: Video: h264 (High), yuv420p(tv, bt709), 1920x1080, 50 fps, 50 tbr, 90k tbn" >&2
    echo "Stream #0:1: Audio: aac (HE-AAC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp" >&2
    echo "Stream #0:2: Audio: eac3 (EAC3 / 0x33434145), 48000 Hz, stereo, fltp, 128 kb/s" >&2
    echo "Stream #0:3: Audio: eac3 (EAC3 / 0x33434145), 48000 Hz, 5.1(side), fltp, 256 kb/s" >&2
    echo "At least one output file must be specified" >&2
    exit 1
    ;;
  probe_single_audio_no_subtitles)
    echo "Stream #0:0: Video: hevc (Main), yuv420p, 3840x2160, 50 fps, 50 tbr, 90k tbn" >&2
    echo "Stream #0:1: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp" >&2
    echo "At least one output file must be specified" >&2
    exit 1
    ;;
  probe_audio_and_subtitle)
    echo "Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 50 fps, 50 tbr, 90k tbn" >&2
    echo "Stream #0:1(eng): Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp" >&2
    echo "Stream #0:2(fre): Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp" >&2
    echo "Stream #0:3(eng): Subtitle: dvb_subtitle" >&2
    echo "At least one output file must be specified" >&2
    exit 1
    ;;
  hang_forever)
    sleep 300
    ;;
  # ---- recordingService.test.ts (0.29.0) — the recording argv also ends with its output
  # playlist path, so the same last_arg trick works. ffmpeg's HLS event muxer never writes
  # #EXT-X-ENDLIST on a SIGTERM death, and these fixtures reproduce that honestly.
  recording_success)
    # A healthy recorder: playlist appears immediately (no ENDLIST — the event is still open),
    # then it "records" until signaled. SIGTERM is left to kill the process (signal-death),
    # exactly like the real recorder being stopped by the service.
    printf '#EXTM3U
#EXTINF:6.0,
seg0.ts
' > "$last_arg"
    printf 'fake-segment-bytes' > "$(dirname "$last_arg")/seg0.ts"
    sleep 300
    ;;
  recording_die)
    # An unexpected death — nonzero exit, no output at all.
    echo "fake ffmpeg: recording died unexpectedly" >&2
    exit 1
    ;;
  recording_die_then_live)
    # Dies unexpectedly the first time, succeeds on the service's one restart attempt.
    marker="${FAKE_FFMPEG_ARGV_FILE:?FAKE_FFMPEG_ARGV_FILE must be set for this mode}.rec-retried"
    if [ -f "$marker" ]; then
      printf '#EXTM3U
#EXTINF:6.0,
seg0.ts
' > "$last_arg"
      sleep 300
    else
      touch "$marker"
      echo "fake ffmpeg: recording died unexpectedly" >&2
      exit 1
    fi
    ;;
  recording_natural_end)
    # The stream simply ends: ffmpeg exits 0 having written a complete playlist with its own
    # ENDlist (the event muxer writes one on natural EOF).
    printf '#EXTM3U
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
' > "$last_arg"
    exit 0
    ;;
  # ---- output-watchdog modes (0.35.0) ----------------------------------------------------------
  # Each writes a playlist plus seg_* files (the watchdog's signal is segment mtimes), then
  # behaves per mode. FAKE_FFMPEG_SEGMENT_DELAY controls append pacing; FAKE_FFMPEG_RUN_TRACKER
  # is a shared file distinguishing "first attempt" from "the respawn" (each attempt gets a
  # fresh mkdtemp dir, so like FAKE_FFMPEG_MARKER_FILE this lives outside the session dir).
  live_output)
    # Healthy live output: playlist (no ENDLIST — delete_segments window), then a new segment
    # every $FAKE_FFMPEG_SEGMENT_DELAY ms until killed. The run tracker records invocations.
    dir="$(dirname "$last_arg")"
    printf '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg_00000.m4s\n' > "$last_arg"
    printf 'fake-segment-0' > "$dir/seg_00000.m4s"
    echo 1 >> "${FAKE_FFMPEG_RUN_TRACKER:?FAKE_FFMPEG_RUN_TRACKER must be set for this mode}"
    i=1
    while [ "$i" -lt 400 ]; do
      sleep "${FAKE_FFMPEG_SEGMENT_DELAY:-0.05}"
      printf "fake-segment-$i" > "$dir/seg_$(printf '%05d' "$i").m4s"
      i=$((i + 1))
    done
    ;;
  live_stall_alive)
    # The provider-kill case with a twist: ffmpeg stays ALIVE but the feed behind it died —
    # playlist + segments appear, then nothing new is ever written while the process lingers.
    dir="$(dirname "$last_arg")"
    printf '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg_00000.m4s\n' > "$last_arg"
    printf 'fake-segment-0' > "$dir/seg_00000.m4s"
    echo 1 >> "${FAKE_FFMPEG_RUN_TRACKER:?FAKE_FFMPEG_RUN_TRACKER must be set for this mode}"
    sleep 300
    ;;
  live_stall_then_recover)
    # First attempt: stalls alive (above). Respawn — the marker file exists — keeps appending:
    # the watchdog's one fresh-connection retry actually recovers the feed.
    marker="${FAKE_FFMPEG_RUN_TRACKER:?FAKE_FFMPEG_RUN_TRACKER must be set for this mode}.recovered"
    dir="$(dirname "$last_arg")"
    printf '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg_00000.m4s\n' > "$last_arg"
    printf 'fake-segment-0' > "$dir/seg_00000.m4s"
    if [ -f "$marker" ]; then
      echo 2 >> "${FAKE_FFMPEG_RUN_TRACKER}"
      i=1
      while [ "$i" -lt 400 ]; do
        sleep "${FAKE_FFMPEG_SEGMENT_DELAY:-0.05}"
        printf "fake-segment-$i" > "$dir/seg_$(printf '%05d' "$i").m4s"
        i=$((i + 1))
      done
    else
      touch "$marker"
      echo 1 >> "${FAKE_FFMPEG_RUN_TRACKER}"
      sleep 300
    fi
    ;;
  live_stall_exited)
    # Exited-after-output: playlist + segments, then exit 0 — the exit handler keeps the session
    # (its "player finishes what it was handed" rule), and the watchdog must see a dead live
    # feed and respawn rather than SIGKILL a pid that is already gone.
    dir="$(dirname "$last_arg")"
    printf '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg_00000.m4s\n' > "$last_arg"
    printf 'fake-segment-0' > "$dir/seg_00000.m4s"
    echo 1 >> "${FAKE_FFMPEG_RUN_TRACKER:?FAKE_FFMPEG_RUN_TRACKER must be set for this mode}"
    exit 0
    ;;
  vod_stall_then_complete)
    # VOD flavour: the first attempt stalls alive mid-encode (hard title, input died), the
    # respawn — marker present — writes everything and exits 0 with a complete ENDLIST playlist.
    marker="${FAKE_FFMPEG_RUN_TRACKER:?FAKE_FFMPEG_RUN_TRACKER must be set for this mode}.vod-done"
    dir="$(dirname "$last_arg")"
    if [ -f "$marker" ]; then
      printf '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg_00000.ts\n#EXTINF:4.0,\nseg_00001.ts\n#EXT-X-ENDLIST\n' > "$last_arg"
      printf 'fake-segment-0' > "$dir/seg_00000.ts"
      printf 'fake-segment-1' > "$dir/seg_00001.ts"
      echo 2 >> "${FAKE_FFMPEG_RUN_TRACKER}"
      exit 0
    else
      touch "$marker"
      printf '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg_00000.ts\n' > "$last_arg"
      printf 'fake-segment-0' > "$dir/seg_00000.ts"
      echo 1 >> "${FAKE_FFMPEG_RUN_TRACKER}"
      sleep 300
    fi
    ;;
  *)
    echo "fake ffmpeg: unset or unknown FAKE_FFMPEG_MODE: ${FAKE_FFMPEG_MODE:-<unset>}" >&2
    exit 1
    ;;
esac
