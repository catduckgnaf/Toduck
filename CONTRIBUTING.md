# Contributing to Toduck

Pull requests against `main` use the pull request template. Fill in a meaningful summary describing the change and its impact; merely retaining the template headings or comments fails the Contribution checks workflow. Record the tests or inspections actually performed under `Checks run:`, or explain why checks could not run under `Checks not run and why:`. Select exactly one `Documentation:` decision: `updated` if a Markdown file changed, or `not needed` with a substantive `Reason:`. An untouched template does not satisfy these requirements. The workflow also fails while any Codex review thread remains unresolved. Resolve those threads before merge. Added Markdown and the pull request description use American spellings. A line that must keep another spelling carries `<!-- us-spelling: allow -->`.

Releases move in small patch numbers (`1.3.1`, `1.3.2`), not large jumps. `latest` is the release image. `develop` and `nightly` are floating tags built only from a Quality-green `main` commit. They are pointers, not places to land work.

```sh
npm test
npm run lint
npm run typecheck
npm run build
```
