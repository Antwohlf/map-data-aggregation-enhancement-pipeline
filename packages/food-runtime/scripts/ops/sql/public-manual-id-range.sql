-- Supabase public DB only. Existing IDs and relationships remain unchanged.
-- Pair with canonical-place-id.mjs: imports start at one billion.
BEGIN;
LOCK TABLE public.pizza_places, public.taco_places IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF (SELECT max(id) FROM public.pizza_places) >= 500000000 OR
     (SELECT max(id) FROM public.taco_places) >= 500000000 OR
     (SELECT last_value FROM public."pizzaPlaces_id_seq") >= 500000000 OR
     (SELECT last_value FROM public.taco_places_id_seq) >= 500000000 THEN
    RAISE EXCEPTION 'Review existing high IDs before assigning the manual namespace';
  END IF;
END $$;
ALTER SEQUENCE public."pizzaPlaces_id_seq" MINVALUE 500000000 MAXVALUE 999999999 START 500000000 RESTART WITH 500000000 NO CYCLE;
ALTER SEQUENCE public.taco_places_id_seq MINVALUE 500000000 MAXVALUE 999999999 START 500000000 RESTART WITH 500000000 NO CYCLE;
COMMIT;
