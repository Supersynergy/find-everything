# Find Everything 0.3.45 · Apple Silicon preview

The live index now recognizes repeat notifications for an already deleted file. It keeps the original removal and avoids another write to the search journal. Directory removals still advance the revision because newer descendants can exist. Cache database names remain searchable. The watcher skips updates to the size and modification time of its own active SQLite files to avoid triggering more index writes.

Event batches reuse the saved scope options and journal count. An external SQLite commit invalidates the count. Large batches yield to the event loop and continue processing their remaining paths. Existing journal gaps remain visible.

In a controlled macOS replay, 256 previously deleted files generated 3,072 duplicate notifications across 12 batches. The kernel attributed 2,170,880 bytes of disk writes to the watcher in 0.3.44 and 57,344 bytes in 0.3.45, including the final cursor checkpoint. Both versions retained all 256 removals. The comparison measures one workload. Physical NAND writes and SSD lifetime were outside the measurement.

The preview requires an Apple Silicon Mac running macOS 15 or later. It is locally signed and not notarized.
