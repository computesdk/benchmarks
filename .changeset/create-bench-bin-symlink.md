---
"create-bench": patch
---

Fix `npx create-bench` / `npm create bench` silently creating nothing. The entry guard compared `process.argv[1]` to `import.meta.url` literally, but npm invokes the bin through a `.bin` symlink, so the paths never matched and `main()` never ran. The guard now compares realpaths.
