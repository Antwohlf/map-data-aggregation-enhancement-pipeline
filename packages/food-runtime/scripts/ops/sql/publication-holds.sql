-- Local enrichment DB only. Apply before deploying the guarded publisher.
CREATE TABLE IF NOT EXISTS public.publication_holds (
  entity_type text NOT NULL CHECK (entity_type IN ('pizza', 'taco')),
  place_id bigint NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  resolution text,
  PRIMARY KEY (entity_type, place_id),
  CHECK (released_at IS NULL OR (resolution IS NOT NULL AND length(trim(resolution)) > 0))
);
GRANT SELECT ON public.publication_holds TO food_pizza_publish, food_taco_publish;
