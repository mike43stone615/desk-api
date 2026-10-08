-- An extra market analysis (beyond a paid plan's included number) now costs $0.15 instead of $0.30, on Pro and Business.
-- Still above the most one analysis costs Desk (~$0.12 at worst, see 0030), so the plans still make money at the extreme.
-- The plans page, the key form's hover notes and invoices all read this one number.
UPDATE plans SET overage_cents_per_analysis = 15 WHERE id IN ('developer', 'business');
