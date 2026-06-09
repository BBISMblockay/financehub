# One-time import files

Use this folder when running the **Legacy Payment Requests Import** GitHub Action with a full export.

1. In GitHub, upload your Jotform/WPV export here (e.g. `payment-requests-export.tsv`).
2. Commit to `main` (or a branch and merge).
3. Run **Actions → Legacy Payment Requests Import** with:
   - `dry_run`: `true` first
   - `file_path`: `data/imports/payment-requests-export.tsv`
4. Re-run with `dry_run`: `false` to write to Supabase.

The pilot file for testing stays at `data/legacy-payment-requests-pilot.csv`.
