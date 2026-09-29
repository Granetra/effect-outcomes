-- Apply once before using PostgresOperationStore. Keep this migration under version control.
CREATE TABLE IF NOT EXISTS public.effect_outcomes_operations (
  key text PRIMARY KEY CHECK (key <> '' AND key = btrim(key)),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^sha256-json-v1:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN (
    'created', 'claimed', 'confirmed_success', 'confirmed_no_effect', 'unknown'
  )),
  claim_id text,
  claimed_at double precision,
  result jsonb,
  failure jsonb,
  evidence_basis text,
  evidence_details jsonb,
  evidence_has_details boolean NOT NULL DEFAULT false,
  reason text,
  recorded_at double precision,
  CONSTRAINT effect_outcomes_state_shape CHECK (
    (evidence_has_details = (evidence_details IS NOT NULL))
    AND (evidence_basis IS NULL OR btrim(evidence_basis) <> '')
    AND (
      (state = 'created'
        AND claim_id IS NULL AND claimed_at IS NULL
        AND result IS NULL AND failure IS NULL
        AND evidence_basis IS NULL AND NOT evidence_has_details
        AND reason IS NULL AND recorded_at IS NULL)
      OR (state = 'claimed'
        AND claim_id IS NOT NULL AND claim_id <> '' AND claimed_at IS NOT NULL
        AND result IS NULL AND failure IS NULL
        AND evidence_basis IS NULL AND NOT evidence_has_details
        AND reason IS NULL AND recorded_at IS NULL)
      OR (state = 'unknown'
        AND claim_id IS NULL AND claimed_at IS NULL
        AND result IS NULL AND failure IS NULL
        AND evidence_basis IS NULL AND NOT evidence_has_details
        AND reason IS NOT NULL AND btrim(reason) <> '' AND recorded_at IS NOT NULL)
      OR (state = 'confirmed_success'
        AND claim_id IS NULL AND claimed_at IS NULL
        AND result IS NOT NULL AND failure IS NULL
        AND evidence_basis IS NOT NULL
        AND reason IS NULL AND recorded_at IS NULL)
      OR (state = 'confirmed_no_effect'
        AND claim_id IS NULL AND claimed_at IS NULL
        AND result IS NULL AND failure IS NOT NULL
        AND evidence_basis IS NOT NULL
        AND reason IS NULL AND recorded_at IS NULL)
    )
  )
);
