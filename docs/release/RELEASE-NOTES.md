# Find Everything 0.3.47 · Apple Silicon preview

`fe status` now uses the existing modification-time index to count files with cached size and time when properties are sparse. Existing indexes can use this immediately. The metadata-only `fe explain` command continues to skip exact counts.

This Apple Silicon preview requires macOS 15 or later. It is locally signed and not notarized.
