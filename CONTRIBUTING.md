# Contributing to Toduck

Pull requests against `main` use the pull request template. The Contribution checks workflow fails a pull request that is missing a summary, verification evidence, or a documentation decision. It also fails while any Codex review thread is still unresolved. Resolve those threads before merge. Added Markdown and the pull request description use American spellings. A line that must keep another spelling carries `<!-- us-spelling: allow -->`.

Releases move in small patch numbers (`1.3.1`, `1.3.2`), not large jumps. `latest` is the release image. `develop` and `nightly` are floating tags built only from a Quality-green `main` commit. They are pointers, not places to land work.

```sh
npm test
npm run lint
npm run typecheck
npm run build
```
