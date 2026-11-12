# Repository preview artwork

`social-preview.png` is a deterministic 1280×640 repository card generated from the Repo Release Excellence SVG template. It uses text and vector shapes, contains no personal paths, and makes no performance claim. The product screenshots under `../release/images/` retain their documented synthetic native fixtures.

Regenerate the card with the installed skill:

```sh
bash ~/.claude/skills/repo-release-excellence/scripts/gen-hero.sh \
  --name 'Find Everything' --tagline 'Local file search for macOS' \
  --motif 'name:receipt ext:pdf view:all' --badge '0.3.1 preview · MIT' \
  --accent '#58A6FF' --out docs/assets/social-preview.png
```

Uploading the repository social preview in GitHub settings remains a manual action. The committed PNG does not establish that account-level setting.
