# Stress media

The 1080p clips are generated, not committed (21 MB together). Regenerate them
before running `video-*` scenarios:

```sh
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 20 \
  -c:v libx264 -preset veryfast -b:v 6M -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 96k clip-1080p.mp4

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000" -t 20 \
  -c:v libvpx-vp9 -b:v 3M -cpu-used 4 -row-mt 1 \
  -c:a libopus -b:a 96k clip-1080p.webm
```
