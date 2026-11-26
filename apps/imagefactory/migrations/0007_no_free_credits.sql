-- Credits for this app come from admin grants only; the platform default of 50 free credits a month would
-- let any new sign-up spend the owner's image-generation budget. Runs once per database, so a value an
-- admin sets later in /admin/settings/ is not overwritten.
UPDATE admin_settings
SET value_json = '0', updated_by = 'migration', updated_at = '2026-11-06T00:00:00.000Z'
WHERE key = 'free_monthly_credits';
