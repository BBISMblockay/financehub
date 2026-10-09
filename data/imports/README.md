# One-time import files

Use this folder when running the **Legacy Payment Requests Import** GitHub Action with a full export.

**Import files carry vendor bank details. Never commit one to `main`:** GitHub Pages
serves `main` publicly, so a file there is downloadable by anyone. This folder is
git-ignored except for this README (security audit 2026-10-08).

1. Create a short-lived branch (e.g. `import/2026-10-ap`) and upload your Jotform/WPV
   export to it at `data/imports/<name>.csv` or `.tsv` (GitHub's web upload works;
   locally use `git add -f`).
2. Run **Actions → Legacy Payment Requests Import** with that branch selected:
   - `dry_run`: `true` first
   - `file_path`: `data/imports/<name>.tsv`
   - `company_entity_id`: the company UUID
3. Re-run with `dry_run`: `false` to write to Supabase.
4. Delete the branch. Never merge it.
