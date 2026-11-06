-- 016_whiteboard_scene.sql -- room for the native (Excalidraw) board scene inside attempts.whiteboard.
--
-- The scene is stored under whiteboard->'scene' next to the legacy keys (steps, strokes, elements, next_seq), which are never modified by a
-- scene save. No data is changed or deleted: this only raises the hard size cap that 015 set for the legacy-only format (400 000 bytes),
-- which a board with a few images can exceed. The API enforces its own, smaller limits (see ai/whiteboard/scene.py); this is the backstop.
-- Idempotent: safe to run repeatedly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attempts_whiteboard_shape_chk') THEN
    ALTER TABLE public.attempts DROP CONSTRAINT attempts_whiteboard_shape_chk;
  END IF;
  ALTER TABLE public.attempts ADD CONSTRAINT attempts_whiteboard_shape_chk CHECK (
    whiteboard IS NULL OR (jsonb_typeof(whiteboard) = 'object' AND pg_column_size(whiteboard) <= 3500000));
END $$;
