# Changelog (draft, week of 2026-10-07)

Covers every commit from 2026-09-03 to 2026-09-10. No earlier draft or release tag exists, so this is the first draft.

## Breaking changes

- **Configuration moved.** The app now reads its settings from `config/app.toml` instead of `.apprc`. Copy your existing settings into `config/app.toml` before upgrading, because the old file is no longer read. The setup guide is updated to match.

## Deprecations

- **Export file format.** Export now takes a `--format` flag to choose the output format. Passing the format as a positional argument still works but is deprecated, so switch to `--format`.

## New

- **CSV export.** You can now export data as a CSV file.
- **Sorting stays put.** The sort order you pick in a table is kept when you move between pages.

## Fixes

- **CSV export.** Fields that contain quotes are now escaped correctly, so exported files open without broken columns.
- **Date picker.** The date picker no longer shows the day before the one you pick for users in time zones behind UTC.
- **Import.** Importing a large file no longer loads the whole file into memory.

## Performance

- Sorting tables is faster, because the comparison functions are now cached.

## Not in the changelog

- Fixed a typo in the setup guide (#482).
- Pinned the time zone in the date tests.
- Project scaffold.
